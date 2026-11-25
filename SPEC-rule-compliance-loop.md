# SPEC: 手渡し品質ルール + ルール遵守監査ループ

kim 指示 (2026-08-28):
> 完結できることをユーザーの手間を掛けさせないで、それでクオリティが変わるなら
> ユーザーの手間を介入させて良い。ただし Claude code が効率化というだけの理由で
> ユーザーの手間を掛けさせないこと。てっていして実行されるようルール化して。
> またルール化したモノが実行されないことが多いので、それをチェックして
> 改善をループで回す仕組みを作って。

## 0. この SPEC が生まれた実測事例（テストケースとして必ず使う）

2026-08-28 のセッションで、Claude は御見積書スプレッドシートの編集を GAS 経由で行おうとし、
kim に **5ステップの手作業手順**（スクリプトを開く→ファイル選択→▶実行→OAuth同意3画面→完了報告）を提示した。

しかし同じ PC に、**追加操作ゼロで完結する経路**が既に存在していた:
`aujust-sales-automation/.env.local` の `GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON` +
ドメイン全体の委任(DWD)で `subject: "kim@orgiast.jp"` を impersonate して Sheets API 直叩き。
（`scripts/probe-estimate-kanri-tab.ts` に前例あり）

**既存 gate (`~/.claude/hooks/manual-handoff-detector.ps1`) はこれを止められなかった。** 理由:

```powershell
# L118 の抜け穴
if ($assistantText -match '(自動化|MCP|CLI).*(試し|失敗|不可|無理|できなかった|権限がない)') { exit 0 }
```
Claude の response に「`clasp run-function` は NOT_FOUND で不可（Workspaceポリシー制約）」と
1行あっただけで gate を通過した。**「試したと言う」だけで通り、試行が十分かは検査されていない。**

構造的欠陥は2つ:
1. **自己申告で通る**: 経路名を1つ挙げて「不可」と書けば無検査で通過
2. **品質の概念が無い**: 手渡しを一律「悪」として扱うため、正当な品質目的の介入も同じ扱いになり、
   分類する動機がなく、抜け穴を通る方向に圧力がかかる

→ この2点を潰すのが本 SPEC の目的。**回帰テストとして上記事例を必ず fixture 化する。**

---

## 1. ルール本文

### 正本: `~/Downloads/orgiast-claude-rules/ONBOARDING.md` に §1.1.1 として追記
既存 §1.1（徹底自動化原則）の直後、§1.2 の前に挿入する。
BEGIN/END マーカー方式（既存 ONBOARDING の慣習）に従い、既存節は書き換えない。

```markdown
### 1.1.1 手渡しの唯一の正当化理由は「品質」（絶対ルール / 2026-08-28 kim厳命）

**既定は user 手作業ゼロ。** user に手を動かしてもらってよいのは、
**その介入によって成果物の品質が上がるとき**だけ。

**許される手渡し（品質理由）**
- 経営判断・意思決定（受注/失注ステータス、単価の据え置き可否、優先順位）
- Claude が持っていないドメイン知識・暗黙知・好み（「この客はこう呼ぶ」「この端数は白布で埋める」）
- 法的・契約的責任を伴う承認（顧客提出物の最終確認、支払い）
- 人にしか物理的に不可能な操作（初回 OAuth 同意、APIキー発行、アカウント作成、物理作業）
- 中身を理解した上での同意が必要なもの（§1.1 の🛑上限。ここは減らしてはいけない）

**禁止される手渡し（効率理由）— これをやったら違反**
- 実装が面倒 / コードを書く量が多い / 時間がかかる
- **自動化経路の探索を打ち切った**（「試したが不可」と書いただけで、残り経路を調べていない）
- Claude 側のトークン・時間の節約
- 「最後の1ステップだけ user に」（§1.1 で既に禁止）

**手渡すときは必ず response に次の構造化ブロックを書く。これが唯一の通過条件。**

    **[手渡し判定]**
    - 品質理由: <なぜ人がやると品質が上がるのか。効率理由は不可>
    - 試した自動化経路: <具体的なコマンド/API/ツール名を3つ以上。結果も書く>
    - 未試行で却下した経路: <名前と、なぜ不可と判断したか>

「自動化を試したが不可でした」だけの一文は通過理由にならない。
経路名を具体的に列挙していない手渡しは違反として記録される。
```

### 短縮版: `~/.claude/CLAUDE.md`
`## トークン効率` の直前に **3行だけ**追記する（このファイルは毎リクエスト読まれるので長文禁止。
memory `feedback_claude_rules_dir_always_loaded` 参照）:

```markdown
## 手渡しは品質理由のみ
user に手作業を頼めるのは「人がやると品質が上がる」時だけ。実装が面倒/経路探索を打ち切った、は違反。
手渡す時は `**[手渡し判定]**` ブロック(品質理由 / 試した経路3つ以上を具体名で / 却下した経路)を必ず書く。全文: ONBOARDING §1.1.1
```

`~/.claude/rules/` には**置かない**（`paths:` の無い rules は常時ロードでトークンを食う）。

---

## 2. gate 改修: `tools/handoff-quality-gate.mjs`（新規・PowerShell版を置き換え）

`~/.claude/hooks/manual-handoff-detector.ps1` は `.bak-20260828-superseded` にリネームして残し、
settings.json の Stop hook 登録を新 gate に差し替える。

### 判定ロジック
1. `stop_hook_active` なら exit 0（無限ループ防止・既存踏襲）
2. transcript の直近 assistant text を取得（既存踏襲。50行 tail）
3. 手渡し語彙を検出（既存 `$handoffPatterns` を移植 + 「番号付き手順+依頼語尾」も移植）
   - 検出0件 → exit 0
4. **`[手渡し判定]` ブロックの構造検査**（ここが新規の核心）
   - ブロックが無い → `decision: block`
   - `品質理由:` が空 or 効率語彙（面倒/時間/トークン/手間を省/実装量/簡単に）を含む → `block`
   - `試した自動化経路:` に**既知経路カタログ**の語が **3つ以上**マッチしない → `block`
   - `未試行で却下した経路:` が無い → `block`
   - 全部満たす → exit 0（＋ `handoff-ledger.jsonl` に「品質手渡し」として記録）
5. **`[HANDOFF-OK]` タグは廃止**（無検査の抜け穴だった）。互換のため検出したら
   「このタグは廃止。`[手渡し判定]` ブロックを書け」と block する。
6. **旧L118の抜け穴は移植しない。** 「試したが不可」の自由文だけでは絶対に通さない。

### 既知経路カタログ（`tools/automation-routes.json` に外出し）
gate と監査ループが同じファイルを読む（memory `feedback_verify_must_measure_the_producers_model`:
検査側と生産側でモデルを共有する）。カテゴリ別に列挙。初期値:
- MCP: `Drive MCP` `Sheets` `Gmail MCP` `Calendar MCP` `Discord MCP` `search_files` `read_file_content` `create_file` `share_file`
- Google 認証: `サービスアカウント` `DWD` `ドメイン全体の委任` `impersonate` `subject:` `JWT` `GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON` `gcloud auth` `ADC`
- Google API: `Sheets API` `Drive API` `spreadsheets.values` `batchUpdate` `batchClear` `Apps Script API`
- GAS: `clasp push` `clasp run-function` `clasp create-script` `コマンドキュー` `setupOnce`
- CLI: `vercel env` `gh secret` `gh api` `supabase db push` `psql` `npm i`
- 復元系: `.env.local` `transcript grep` `Grep tool` `production bundle` `keyserve`
- 委譲: `codex-do.mjs` `llm-ask.mjs`

**このカタログの網羅性が gate の強さを決める。** 監査ループが「カタログに無い経路で
自動化できた事例」を見つけたら追記候補として提案する（§3 の改善ループ）。

### すり抜け記録
gate が exit 0 にした手渡しは `~/.claude/handoff-ledger.jsonl` に1行追記する:
`{ts, sessionId, verdict: "passed"|"blocked", reason, quality, routesMatched:[...], excerpt}`
**これが §3 の「gate をすり抜けた違反」を後から検出する唯一の材料**なので、必ず書く。

---

## 3. 本命: ルール遵守監査ループ `tools/rule-compliance-loop.mjs`

「ルール化したのに実行されない」を機械的に検出して、強制レベルを自動で上げ、
gate の抜け穴の修正案まで出すループ。既存 `tools/cost-work-loop.mjs` の
「warn → N日改善なければ block 自動昇格 → `~/.claude/*-enforce.json` に書く → hook が読む」
の構造をそのまま踏襲する（実績のあるパターン）。

### 3-1. ルール登録簿 `tools/rules-registry.json`
機械可読。1ルール = 1エントリ。初期登録は下記5件（増やしやすい形にする）。

```jsonc
{
  "rules": [{
    "id": "handoff-quality-only",
    "source": "ONBOARDING §1.1.1",
    "summary": "手渡しは品質理由のみ。効率理由・経路探索の打ち切りは違反",
    "detect": {
      "scope": "assistant_text",
      "violation": ["<手渡し語彙の正規表現>"],
      "exempt":   ["\\[手渡し判定\\][\\s\\S]*品質理由:"],
      "requireRoutes": 3
    },
    "gate": "handoff-quality-gate.mjs",
    "ledger": "~/.claude/handoff-ledger.jsonl",
    "enforcement": "warn",
    "thresholds": { "violationsToBlock": 3, "daysObserved": 3 }
  }]
}
```

初期登録する5ルール（すべて既存の実測された繰り返し違反）:
| id | 出典 | 違反の検出方法 |
|---|---|---|
| `handoff-quality-only` | ONBOARDING §1.1.1 | 手渡し語彙あり かつ `[手渡し判定]` 不備 |
| `id-with-name` | §1.5.2 | `C\d{4}` 等の内部IDが人間可読名の併記なしで出現 |
| `verify-before-done` | §deploy-verify | 「完了」「反映しました」に検証の実行記録が伴わない |
| `delegate-implementation` | §1.18 | Write/Edit で大きな実装を自分で打った（cost-work-loop の実測値を流用） |
| `no-fable5` | §1.16 | `model:"fable"` / `claude-fable-5` の使用 |

### 3-2. 走査
- 対象: `~/.claude/projects/*/*.jsonl` の直近 `--days`（既定7）
- ルールごとに `compliant` / `violation` をカウントし、違反は
  `{sessionId, ts, ruleId, excerpt(200字), gatePassed}` で保持
- `gatePassed` は `handoff-ledger.jsonl` と突き合わせて判定する:
  **gate が passed にしたのに監査で違反 → 「すり抜け」**。
  これが「ルール化したのに実行されない」の**直接指標**なので独立して集計・レポートする。

### 3-3. 強制レベルの自動昇格
- 直近 `daysObserved` 日で違反が `violationsToBlock` 以上、かつ改善トレンドが無い
  → そのルールの `enforcement` を `warn` → `block` に上げ、
    `~/.claude/rule-enforcement.json` に `{ruleId: {mode, reason, since}}` として書く
- gate 群は起動時にこのファイルを読み、`block` のルールは `decision: block` を返す
- 改善したら `block` → `warn` に自動降格（cost-work-loop と同じ双方向）
- **すり抜けが1件でもあれば昇格の閾値を待たずに即 block**（自己申告で通る状態は放置しない）

### 3-4. 抜け穴の改善案生成（ループの「改善」部分）
すり抜け事例が1件以上あったら、その事例（違反した response の抜粋 + gate が通した理由 +
実際に可能だった経路）を **Codex に委譲**して、gate の判定条件の修正案を生成させる。
- 出力先: `tools/rule-gate-patches/<ruleId>-<YYYYMMDD>.md`
- **自動適用しない。** 人がレビューして取り込む（gate を AI が自動書き換えするのは危険）
- 併せて `automation-routes.json` への追記候補も出させる
- 呼び出しは `node tools/codex-do.mjs --prompt-file <生成した指示ファイル>`（argv 渡し禁止。
  memory `feedback_codex_prompt_via_file_not_argv`）

### 3-5. レポートと可視化
- `~/.claude/rule-compliance.md` に書く。SessionStart hook で inject
- 内容: ルールごとに `遵守/違反/すり抜け` 件数、強制レベル、直近の違反例1件（セッションID付き）
- **前回と差分が無ければ通知しない**（memory `feedback_notifications_must_carry_new_information`）。
  ただし「すり抜け」は0→0でも「0件」と明記する（沈黙を正常と誤読させない）
- 差分があれば Discord へ通知

### 3-6. ループ自体の死活監視（これが無いとループが静かに死ぬ）
- `rule-compliance-loop.mjs` は実行ごとに `~/.claude/rule-compliance-state.json` に `lastRunAt` を書く
- 既存 `tools/cron-liveness-check.mjs` の監視対象に追加し、
  **2日以上走っていなければ SessionStart で警告**する
- memory `feedback_interactive_scheduled_task_silently_skipped` / `feedback_retry_thresholds_are_rate_dependent`:
  「回数」ではなく「異なる日数」で数えること

### 3-7. スケジュール
夜間バッチ（§2.8.1）。既存の夜間枠に相乗りし、Windows タスクは
`tools/run-hidden.vbs` 経由で黒い窓を出さない（memory `feedback_hide_scheduled_task_console_window`）。
既存 cron 群と同じ 1 ジョブに統合する場合は全ステップに `if: !cancelled()` 相当の
「前段失敗でも後続を走らせる」処理を入れる（memory `feedback_gha_step_silent_skip_on_prior_failure`）。

---

## 4. テスト（必須）

`tools/rule-compliance-loop.test.mjs` と `tools/handoff-quality-gate.test.mjs` を
`node:test` で書き、`node --test tools/` が通ること。

### 回帰テスト（§0 の実測事例を fixture 化）
1. **旧gateがすり抜けさせた実物**: 「`clasp run-function` は NOT_FOUND で不可（Workspaceポリシー制約）」+
   5ステップの手順 → **新 gate は block すること**（これが通ったら改修失敗）
2. 「`[手渡し判定]` 品質理由: 受注ステータスは経営判断のため / 試した経路: Sheets API・DWD impersonate・
   clasp run-function / 却下: …」→ **pass すること**
3. 「品質理由: 実装が面倒なので」→ **block すること**（効率語彙の検出）
4. `[HANDOFF-OK]` タグのみ → **block すること**（廃止タグ）
5. 試した経路が2つだけ → **block すること**（3つ未満）
6. すり抜けが1件ある状態 → 閾値未満でも `enforcement` が `block` になること
7. 完了報告の番号付きリスト（過去形・依頼語尾なし）→ **pass すること**
   （memory: 2026-08-05 の誤検知事例。再発させない）

### ループの自己検査
8. `rules-registry.json` の全ルールに `detect` と `gate` と `thresholds` が揃っていること
9. `automation-routes.json` の全カテゴリが空でないこと
10. `rule-enforcement.json` を書いた後、gate がそれを読んで挙動が変わること（結合テスト）

---

## 5. やってはいけないこと
- `~/.claude/rules/` に長文ルールを置く（常時ロードで毎リクエスト課金。§トークン効率）
- gate を AI に自動書き換えさせる（提案止まりにする）
- 既存 hook の登録を消す（`hook-selfcheck.mjs` / `REQUIRED_HOOKS` と競合。
  memory `feedback_distributed_hooks_never_registered_on_windows`）
- 既存 `manual-handoff-detector.ps1` を削除する（`.bak-` で残す）
- 通知の no-op 送信（差分が無ければ黙る。ただし「すり抜け0件」は明記する）
- 閾値を「試行回数」で数える（「異なる日数」で数える）
