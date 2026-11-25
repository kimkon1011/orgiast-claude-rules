# 指示書A: 全アカウントの AI 領収書を Gmail(DWD) から毎日集計し、未監視の課金源を検知する

## 背景（事故 2026-10-17）
- Anthropic Admin API の監視キー（`~/.claude/cost-monitor.env` の `ANTHROPIC_ADMIN_KEY`）が見ている Console 組織は「オージャスト」（メンバー kim@ と m.kanau@ のみ、10月は日額 $1〜9）。
- ところが seisaku-team@orgiast.jp 名義の別 Console 組織「よろしくお願いします。's Individual Org」が存在し、2026-07-10 から毎日 $10〜$60 の自動チャージ（7/11〜15 だけで $2,945、10/16 $78、10/17 $55、直近100通の領収書合計 $4,240）が続いていた。誰も気付かなかった。
- 一方 seisaku-team@ の Gmail には Anthropic からの領収書・「Auto-reload was paused」・「Your Claude API access is turned off」・「$22.00 payment ... unsuccessful」が全部届いていた。**払った額の一次情報は Gmail にあった。**
- `tools/gmail-search.mjs` は DWD(サービスアカウント) で orgiast.jp の任意ユーザーを impersonate して Gmail を読める（kim@ / seisaku-team@ / nishi@ / cr@ は実測可。keiri2@ は Google Group なので不可＝スキップ）。

## 目的
Admin キーやアカウント所属に依存せず、**「AI ベンダーから届いた領収書・課金イベント」を全アカウント横断で毎日集計**し、未知の課金源・急増・決済失敗を kim に DM する。これが「freee を見れば気付けたはず」を機械化した版（freee は月次で遅い、Gmail は即日）。

## 作るもの

### 1. `tools/ai-receipt-accounts.json`（設定・新規）
```json
{
  "accounts": ["kim@orgiast.jp", "seisaku-team@orgiast.jp", "nishi@orgiast.jp", "cr@orgiast.jp", "m.kanau@orgiast.jp"],
  "vendors": {
    "anthropic": { "from": ["mail.anthropic.com", "anthropic.com"] },
    "openai": { "from": ["openai.com"] },
    "google": { "from": ["payments-noreply@google.com", "cloud-billing", "google.com"] },
    "openrouter": { "from": ["openrouter.ai"] },
    "xai": { "from": ["x.ai"] },
    "deepseek": { "from": ["deepseek.com"] },
    "kimi": { "from": ["moonshot.cn", "moonshot.ai"] },
    "glm": { "from": ["z.ai", "zhipuai.cn", "bigmodel.cn"] },
    "cursor": { "from": ["cursor.com", "cursor.sh"] },
    "genspark": { "from": ["genspark.ai"] },
    "groq": { "from": ["groq.com"] },
    "mistral": { "from": ["mistral.ai"] }
  },
  "coveredAnthropicOrgs": ["オージャスト"],
  "thresholds": { "burst48hUsd": 30, "burstReloads48h": 3, "mtdSourceUsd": 100, "newSourceAlert": true }
}
```
- Gmail の検索式は vendors の from を OR で連結し、`newer_than:{days}d` を付ける。語句フィルタ（receipt / invoice / payment / "auto-reload" / "usage credits" / "spend limit" / "API access" / 領収 / 請求 / お支払い）も OR で付ける。クエリ文字列を返す純粋関数 `buildReceiptQuery(config, days)` を export し、テストで固定文字列を検証する。

### 2. `tools/ai-receipt-scan.mjs`（新規・ESM・既存ツールの流儀に合わせる）
- `import { searchGmail } from './gmail-search.mjs'`（`{ user, query, max: 100, withBody: true, bodyLimit: 6000 }`）。
- `import { notifyKim } from './notify-kim.mjs'`、`import { isEntry } from './is-entry.mjs'`。
- **export する純粋関数（テスト対象）**:
  - `classifyVendor(from, subject, config)` → vendor 名 or `'unknown'`。Stripe 経由（`from` が stripe.com）は subject の `Your receipt from <Vendor>` から判定。
  - `parseReceiptMail(message, config)` → `{ messageId, threadId, account(=to), vendor, kind, date(ISO), amountUsd|null, amountJpy|null, currency, org|null, card|null, receiptNo|null, subject }`。
    - kind: `receipt`（件名 `Your receipt from` / 本文 `Amount paid`）、`failed_payment`（件名 `payment to ... was unsuccessful`）、`autoreload_paused`（件名 `Auto-reload was paused`）、`autoreload_other_card`（件名 `Auto-reload went through on another saved card`）、`api_off`（件名 `Your Claude API access is turned off`）、`spend_limit_reached`（件名 `reached its usage credits spend limit`）、`spend_limit_warning`（`approaching its usage credits spend limit` / `used 75%`）、`limit_increased`（`usage limit has been increased`）、`usage_request`（`requested more usage`）、`other`。
    - 金額: 本文の `Amount paid $22.00` を最優先、無ければ `Total $22.00`、件名の `$22.00 payment` も可。`¥12,345` は amountJpy。
    - org: 本文の `for <org名> went through` / `organization '<org名>' is out of usage credits` / `organization &#39;<org名>&#39;` を抽出（HTML エンティティ `&#39;` を `'` に戻してから）。
    - card: `JCB ending in 7945` / `Visa ending in 5406` / `with - 1109`（Stripe 領収書の `Paid on ... with - 1109` は末尾4桁）を `{brand, last4}` 文字列化。
  - `summarizeReceipts(rows, { now })` → `{ sources: { "<account>|<vendor>|<org||'-'>": { account, vendor, org, mtdUsd, last48hUsd, last24hUsd, reloads48h, byDay, events48h: [kind...], lastDate } }, totals: { mtdUsd, byVendor } }`。MTD は JST（`+9h`）の月で切る。
  - `evaluateReceiptAlerts(summary, state, thresholds, { now })` → `{ alerts: [{ kind, sourceKey, text }], state }`。
    - `new_billing_source`: state.seenSources に無い sourceKey（初回スキャン時は全件 new になるので、`state.initialized !== true` のときは alert を出さず seen に登録するだけ）。
    - `reload_burst`: last48hUsd ≥ burst48hUsd または reloads48h ≥ burstReloads48h。
    - `billing_event`: events48h に failed_payment / autoreload_paused / api_off / spend_limit_reached が含まれる。
    - `mtd_high`: mtdUsd ≥ mtdSourceUsd（同じ sourceKey は月1回だけ）。
    - 同一 (kind, sourceKey) は `state.alerted[key] = YYYY-MM-DD` で1日1回。
  - `formatReceiptReport(summary, alerts)` → 日本語の複数行テキスト（「領収書(全アカウント Gmail・直近48h)」見出し、source ごとに `account / vendor / org: 48h $X (N回) / MTD $Y / 最終 kind`、アラート行は 🚨）。
- **I/O**:
  - 台帳 `~/.claude/ai-receipts.jsonl`（1行1 message、`messageId` で重複排除。既存行は読み込んで summarize に含める＝MTD は台帳全体から出す）。
  - 状態 `~/.claude/ai-receipts-alert-state.json`（`{ initialized, seenSources: {key: firstSeenISO}, alerted: {key: date} }`）。
  - 失敗したアカウント（`unauthorized_client` 等）はスキップして `errors: [{account, reason}]` に残し、レポートに「未計測: cr@…（理由）」と出す。**0 件を「課金なし」と書かない**（[[feedback_zero_cost_may_mean_unmeasured]] の原則）。
  - `export async function scanAiReceipts({ home, days = 3, config, now, appendLedger = true, searchImpl = searchGmail })` → `{ rows(新規), summary, alerts, errors, report }`。
  - `export async function alertAiReceipts(result, { home, now, notify = notifyKim })` → alerts があれば 1通の DM にまとめて送る（notifyKim の既存シグネチャに従う）。
- **CLI**: `node tools/ai-receipt-scan.mjs [--days 3] [--dry-run] [--json] [--notify]`。`--dry-run` は Gmail 読み取りは行うが台帳・状態を書かず DM も送らない。既定は台帳更新のみ・DM は `--notify` 時だけ。

### 3. `tools/cost-improve-loop.mjs` への組み込み
- `collectSignals()` の `providerBalances` の隣に `aiReceipts: await (io.scanAiReceipts ?? scanAiReceipts)({ home, now, days: 3, appendLedger: !dryRun })` を追加（try/catch で失敗は `null`、ログ1行）。
- `alertProviderBalances` の直後に `await (io.alertAiReceipts ?? alertAiReceipts)(signals?.aiReceipts, { home, now, notify: io.notifyKim ?? notifyKim })` を同じ guard（`!dryRun && !noNotify && !io.noNotify`）で追加。
- 日次レポート文（`formatBalanceLine` を足している行の隣）に `signals.aiReceipts.report` を追記。
- テスト（`cost-improve-loop.test.mjs`）は `io.scanAiReceipts` / `io.alertAiReceipts` をスタブして「呼ばれる」「失敗しても本体が止まらない」を確認。

### 4. `tools/cost-report.mjs` を複数組織対応にする
- `fetchAdminCostReport({ startingAt, adminKey, adminKeys, fetchImpl })`: `adminKeys` が `[{ label, key }]` で渡されたら各キーで `/v1/organizations/me`（org 名）と cost_report を取り、`{ available, totalUsd, byModel, byDay, byOrg: { "<org名>": { totalUsd, byDay } } }` を返す。`adminKey` だけの旧呼び出しは従来どおり動く（後方互換）。
- `budget-status.mjs` の `collectBudgetStatus`: `cost-monitor.env` の `ANTHROPIC_ADMIN_KEY` に加えて `ANTHROPIC_ADMIN_KEY_<LABEL>`（例 `ANTHROPIC_ADMIN_KEY_SEISAKU`）を全部拾って `adminKeys` として渡す。`formatBudgetStatus` に `Developer Platform: $X（org: オージャスト $a / よろしく… $b）` の形で byOrg を出す。

### 5. `tools/budget-status.mjs` に「払った額（領収書）」を加える
- `calculateBudgetStatus({ ..., receipts })` に任意引数 `receipts = { anthropicMtdUsd, otherMtdUsd, byVendor }` を追加。
- 変動 MTD の計算: Anthropic 分は `max(developerPlatform.totalUsd, receipts.anthropicMtdUsd)`（領収書は前払いチャージなので使用額と一致しない。大きい方を採用し、二重計上しない）。他ベンダーの領収書 `otherMtdUsd` は executor 台帳と重なりうるので合計には足さず、`sources.receipts` として表示だけする。
- `collectBudgetStatus` は `~/.claude/ai-receipts.jsonl` を読んで当月(JST)の receipt 行から receipts を作る（無ければ `{anthropicMtdUsd:0, otherMtdUsd:0, byVendor:{}}`）。
- `formatBudgetStatus` に `領収書(Gmail・全アカウント): Anthropic $X / その他 $Y` の1行を追加。

### 6. テスト
- `tools/ai-receipt-scan.test.mjs`（node:test）: 下のフィクスチャで parse / summarize / evaluate / buildReceiptQuery を検証。
- `tools/cost-report.test.mjs`（無ければ新設）: adminKeys 2本で byOrg が出ること、1本が HTTP 401 でも他方は available なこと。
- `tools/budget-status.test.mjs`: receipts の max 採用。
- 実行: `node --test tools/ai-receipt-scan.test.mjs tools/cost-report.test.mjs tools/budget-status.test.mjs tools/cost-improve-loop.test.mjs tools/no-undistributed-imports.test.mjs` と `node tools/selftest-guards.mjs`。

#### フィクスチャ（実メールから。テストに埋め込む）
- 領収書 from `"Anthropic, PBC" <invoice+statements@mail.anthropic.com>` to `seisaku-team@orgiast.jp` subject `Your receipt from Anthropic, PBC #2666-1376-2870` body（抜粋・空白正規化後）: `Receipt from Anthropic, PBC $22.00 Paid on October 16, 2026 with - 1109 (invoice illustration [...]) Receipt #2666-1376-2870 One-time credit purchase Qty 1 $20.00 Subtotal $20.00 Total excluding tax $20.00 JCT - Japan (10%) $2.00 Total $22.00 Amount paid $22.00 Download receipt (...)` → vendor anthropic / kind receipt / amountUsd 22 / card `- 1109` → last4 1109 / receiptNo `2666-1376-2870`。
- 件名 `$17.36 payment to Anthropic, PBC was unsuccessful` from `failed-payments@mail.anthropic.com` → kind failed_payment / amountUsd 17.36。
- 件名 `Auto-reload was paused on your Anthropic account` 本文 `Auto-reload has been turned off for your organization because the most recent auto-reload payment didn't go through.` → kind autoreload_paused。
- 件名 `Auto-reload went through on another saved card` 本文 `The latest $10.93 auto-reload for よろしくお願いします。's Individual Org went through on JCB ending in 7945 because your default card, Visa ending in 5406, was declined.` → kind autoreload_other_card / amountUsd 10.93 / org `よろしくお願いします。's Individual Org` / card `JCB 7945`。
- 件名 `[Action needed] Your Claude API access is turned off` snippet `Your access to the Claude API has been disabled because your organization &#39;よろしくお願いします。&#39;s Individual Org&#39; is out of usage credits.` → kind api_off / org 復元後 `よろしくお願いします。's Individual Org`。
- 件名 `Your organization has reached its usage credits spend limit` to kim@ → spend_limit_reached（vendor anthropic、org null）。

## 守ること
- 会話本文・秘密値をログに出さない。メール本文は台帳に保存しない（parse 結果の構造化フィールドだけ）。
- 既存の `gmail-search.mjs` / `notify-kim.mjs` / `is-entry.mjs` / `env-kv.mjs` を再利用し、新しい認証経路や秘密を増やさない。
- 新規 .mjs の import 先は `tools/` 配下のみ（`no-undistributed-imports.test.mjs` が検査する）。
- `fs.writeFileSync` の前に `mkdirSync({recursive:true})`。BOM を書かない。
- Windows でも動くパス処理（`path.join`、`os.homedir()`、`process.env.ORGIAST_HOME` 優先）。
- push / commit はしない。作業ツリーに変更を残すだけ。
- 完了報告には「作成/変更したファイル一覧」「テストコマンドと結果の要約（件数のみ）」を書く。ログ全文は貼らない。
