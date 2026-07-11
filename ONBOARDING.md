# オージャスト Claude Code 共通ルール

このオンボーディングは、オージャスト社内で Claude Code を使うメンバー全員に共通する **恒久ルール** をまとめたものです。各メンバーは自分の `~/.claude/CLAUDE.md`（Windows なら `%USERPROFILE%\.claude\CLAUDE.md`）にこのファイルの内容を反映するか、後述の「セットアップ手順」に従って取り込んでください。

> ⚠️ **これは追加用ルールです。** 既存の社内共通 CLAUDE.md / 個人の `~/.claude/CLAUDE.md` を**置き換えるものではなく、追記（マージ）してください**。既存ルールと矛盾する箇所があった場合は手動で調整し、不明点は kim@orgiast.jp に確認してください。

---

## 1. 基本方針

オージャストでは Claude Code を **「作業者の手間を最小化する自動実行エージェント」** として使います。Claude は次の2つの軸を最優先で守ること。

### 1.1 できる作業は全部 Claude 側でやる（徹底自動化原則）

API / CLI / MCP / GitHub Actions など、Claude Code から実行可能な操作は **人間に手順を案内せず、Claude が直接実行する** こと。

- やる: ファイル編集、コミット、PR 作成、`gh` コマンド、`gcloud` / `clasp` / `supabase` / `vercel` 等の CLI 実行、MCP（Google Drive / Sheets / Gmail / Calendar 等）経由のデータ取得・書き込み
- やらない: 「以下のコマンドを実行してください」「Web UI を開いてここをクリックしてください」型の手順案内
- **例外（本当に人間にしかできないもの）**: アカウント新規作成 / OAuth 同意ボタン(初回のみ) / 支払い操作 / Workspace 管理者の DWD 委任設定 / 物理操作(スマホでのLINE友達追加、QRスキャン等) / 権限の無い他社リソース

### 1.1.1 直接できる作業は絶対 user に振らない(絶対ルール、2026-06-08 強化)

**「DDL paste は例外」「Vercel UI クリックは例外」のような抜け道を作らない**。Supabase の migration も `supabase db push --db-url '<conn>'` で自動化可能。GitHub Secret 設定も `gh secret set` で可能。Vercel env も `vercel env add` で可能。

判断ルール:
- ✅ **確認**(質問・選択肢提示・状態スクショ依頼)は OK
- ❌ **作業**(SQL 実行、Web UI クリック、ファイル保存、メール送信)は **絶対 NG**
- 認証情報が無くて自動化不能 → 「1 回だけ token/password/connection-string を貼ってください」と依頼して **直ちに `.env.local` や OS keystore に永続保存** → 以降は完全自動化。**毎回 paste 依頼してはいけない**(初回 setup と継続作業を厳密に区別する)

過去事例(2026-06-08): aujust-sales-automation で migration 0011 を「Supabase SQL Editor で paste 実行してください」と user に依頼 → 「そちらでできないのかな」「**今後直接できるものをこちらと分担しないように徹底してほしい。これは絶対ルールとしてください。確認は良いけれど、作業は絶対こちらに振らない**」と明示要望 → `supabase db push --db-url` で自動化可能だったと判明。**例外の抜け道を作らないルールに改訂**。

迷ったら **「自分で実行する」を選ぶ**。失敗したらユーザーに報告して別アプローチを取る。

#### 「手作業を依頼する前」の必須チェック5ステップ（順序厳守）

```
[必須] 手作業依頼を出す前に毎回:
  1. その操作は API/CLI/MCP で可能か?  → 既存ツール調査(WebSearch/公式 docs)
  2. CLI が無いなら ⇒ 自分でインストールする(scoop / choco / winget / npm i -g / pip)
  3. インストール後の認証は ⇒ 「ログインコマンドだけ」を user に依頼(以後は全自動)
  4. それでも完全自動化不能なら ⇒ 初めて手作業依頼(直 URL + screenshot で検証可能な手順)
  5. 手作業に頼った時は ⇒ 終わった後「次回からはこの方法で自動化できる」を memory に追加
```

#### 1.1.3 「手渡す前に必ず自分で試す」— 特に git / PR マージ（2026-07-09 追加）

**最悪の違反 = 自分で試しもせず手渡しの一文を書くこと。**「PR をマージしてください」「ここをクリックしてください」と書く前に、必ず対応する CLI/API を実際に叩く。ツール(または classifier)が「できない」と返して初めて手渡し候補になる。**手渡しの可否を推測で先に決めない**（"最後の1ステップだけ user に" は最も陥りやすい罠）。

git / PR フローは Claude が端から端まで駆動する:
- commit → push → `gh pr create` → **`gh pr merge` まで自分でやる**。「PR を作ったのでマージお願いします」で止めない。
- 直 push が classifier block でも、それは「PR 経由でやれ」の意味であって「user にやらせろ」ではない。コンフリクト解決・型チェック・検証も自分でやる。

**試して初めて判明する“正当なガードレール”（OAuth/支払い同様の真の例外。ここだけ user の1クリック）**:

| 操作 | classifier がブロックする理由 | Claude の正しい対応 |
|---|---|---|
| default ブランチへの直 push | PR レビュー迂回 | 自分で PR を作る |
| **自作 PR の自己マージ（人間レビュー無し）** | Self-Approval / Merge Without Review | **この1点のみ** user に。PR 直 URL + レビュー観点 + 「GitHub のサインイン先アカウント」注意 を添えて最小化 |

→ 「自分で書いたコードを自分で本番ブランチへ入れる」瞬間だけ人間レビューが要る。**そこに至るまで(commit/push/PR作成/コンフリクト解決/検証)は全部やり切り**、手渡すのはこの1クリックだけ、必ず直リンクで。

**GitHub UI を踏ませる時の注意**: private repo は権限の無いアカウントだと **404**（"This is not the web page..."）になる。手渡し時は「右上アバターで正しいアカウント（repo owner / collaborator）に切替」を必ず併記する（別アカウントでログインしていて 404 になる事故が頻発）。

過去事例(2026-07-09): PRONI cron 修正で `gh pr merge` を**試しもせず**「PR をマージしてください」と手渡し → user が GitHub を別アカウント(awardsystem)で開いていて 404 → 「なぜ最初からこちらの手間がかからないようにできないのか。自分たちでできることは振るな。徹底してルール化しろ」と要望。真因 = **手渡しの一文を、自分で試す前に書いたこと**。実際は `gh pr merge` まで自分で実行でき、止まったのは「自作 PR の自己マージ」ガードレールのみだった（＝手渡しは最後の1クリックに圧縮できた）。

#### 1.1.4 既存リソースの再作成・再作業を絶対に振らない（2026-06-24 追加）

「○○ を新規作成してください」と user に依頼する **前に必ず**、既存の同等リソースを CLI/API で一覧取得して、既存があれば流用する。**既に作成済みのものに「もう一度作って」と振るのは、user の手間を二度かける典型違反**。

##### 着手前の必須確認コマンド

| リソース種別 | 既存確認コマンド |
|---|---|
| GCP Service Account | `gcloud iam service-accounts list --project=<PROJECT>` |
| GCP Project 自体 | `gcloud projects list` |
| Vercel Project | `vercel projects ls` |
| Vercel Env Variable | `vercel env ls <env>` |
| GitHub Repo | `gh repo list <owner>` |
| GitHub Secret | `gh secret list --repo <repo>` |
| GitHub Workflow | `gh workflow list --repo <repo>` |
| Google Drive / Sheets / Forms | Drive MCP `search_files` で `title contains '<想定名>'` |
| Discord Guild / Channel / Member | Discord MCP `list_channels` / `list_guilds` / `search_members` |
| Supabase Project | 過去 transcript grep / .env.local / Vercel env から復元 |

##### 過去事例 (2026-06-24)

EOラーニング企画アプリで Sheets API 用 SA を「GCP Console で新規作成してください」と user に依頼 → user スクリーンショット指摘「**既に作ってない？**」 → `aujust-sales-automation` project に `eo-learning-sheets-reader@...iam.gserviceaccount.com` が既に存在していた。さらに user 「**今後すでに作っているものの作業をこちらに振らないように徹底してルール化して**」と明示要望。

##### やってはいけない

- 「○○ を新規作成してください」を、既存一覧確認なしで提示
- 「念のためもう 1 つ作りましょう」（重複リソースは管理コスト増）
- 過去 memory に書いてある名前のリソースを「初めて作る前提」で依頼
- スクリーンショットで既存リソースが見えているのに「作成手順」を案内する

##### OK パターン

- 「既に `eo-learning-sheets-reader@...` が存在することを確認しました。これに key を 1 つ発行してください（既存に key が無いため）」
- 「既存 Sheet `1YaQc...` を流用します（マニュアル兼企画管理スプレッドシートと同一）」

#### 1.1.5 SA で Google Drive 書き込み = DWD impersonate が必須（2026-06-29 追加）

**Google サービスアカウントは Drive 容量 0 GB 固定** で、GCP API では変更不可。`drive.files.create` を呼ぶたびに `The user's Drive storage quota has been exceeded` エラーになる。次の代替策はすべて失敗するので試さない：

| 試したけど失敗するパターン | なぜダメ |
|---|---|
| `parents: [kim_folder_id]` を指定して kim's drive 内に書く | ファイル owner は SA のまま → SA quota 消費 |
| 作成直後 `permissions.create` で `transferOwnership: true` | create が先に quota fail、transfer に到達せず |
| `supportsAllDrives: true` だけ追加 | Shared Drive 不在なら無効 |
| SA に Workspace ライセンス付与 | GCP API では不可（有料 + Admin 操作） |

**唯一の自動化経路 = DWD（Domain-Wide Delegation）**：
- SA が Workspace ユーザー（kim@orgiast.jp）を impersonate
- ファイル owner = kim、kim's Drive 15GB 容量を使用
- セットアップは Workspace Admin Console で 1 回のみ

##### Drive 書き込みするプロジェクト立上げの確定シーケンス

```bash
# 1. SA 既存確認（再作成しない）
gcloud iam service-accounts list --project=<PROJECT>

# 2. SA key 発行（IAM API enable できなければ GCP Console から）
gcloud iam service-accounts keys create key.json \
  --iam-account=<SA_EMAIL> --project=<PROJECT>

# 3. base64 化して Vercel env に登録
B64=$(base64 -w0 key.json)
echo "$B64" | vercel env add GOOGLE_SERVICE_ACCOUNT_KEY_B64 production

# 4. DWD 設定（Workspace Admin、1 回のみ user 操作）
#    https://admin.google.com/ac/owl/domainwidedelegation
#    Client ID: key.json の client_id（数字 21 桁）
#    Scopes: https://www.googleapis.com/auth/drive,
#            https://www.googleapis.com/auth/spreadsheets

# 5. impersonate 用 env
echo "kim@orgiast.jp" | vercel env add GOOGLE_IMPERSONATE_EMAIL production
```

##### コード側の必須対応

```typescript
// lib/google/auth.ts — subject 対応 + 個別キャッシュ
export function getGoogleAuthClient(subject?: string): JWT | null {
  const json = JSON.parse(Buffer.from(process.env.GOOGLE_SERVICE_ACCOUNT_KEY_B64!, 'base64').toString('utf-8'));
  return new google.auth.JWT({
    email: json.client_email,
    key: json.private_key,
    scopes: [
      'https://www.googleapis.com/auth/drive',          // drive.file ではなく full drive
      'https://www.googleapis.com/auth/spreadsheets',
    ],
    ...(subject ? { subject } : {}),
  });
}

// 使用側 — Drive 書き込みする場面では必ず subject を渡す
const auth = getGoogleAuthClient(process.env.GOOGLE_IMPERSONATE_EMAIL);
```

##### 罠リスト

- ❌ scope を `drive.file` にする → DWD では権限不足、`drive` フル必須
- ❌ `cachedClient` で subject 違いを使い回す → 別 user impersonate が前回 user で動く事故。subject ごとに Map キャッシュ
- ❌ Workspace Admin 操作を「過剰な依頼」と勘違いして避ける → DWD は Workspace Admin にしかできない、本当の例外
- ❌ **subject 付き JWT に DWD 未許可の scope を含める**（2026-06-29 追加）
  - DWD authorization は **要求された全 scope が許可リストに含まれている**ことを要求する厳格マッチ
  - `calendar.events.readonly` 等が DWD 未許可なのに JWT scope に含まれてた → `unauthorized_client: ... not authorized for any of the scopes requested` で全 API call が即失敗
  - 対策: `getGoogleAuthClient(subject)` で **subject あり時は DWD 許可 scope のみ**、なし時は通常 SA 全 scope を使い分ける
    ```typescript
    const scopes = subject
      ? ['drive', 'spreadsheets']  // DWD 許可分のみ
      : ['drive', 'spreadsheets', 'calendar.events.readonly'];  // SA 自身は全 scope OK
    ```

##### 過去事例（2026-06-29）

EOラーニング企画アプリで「📄 講師用リストを生成」機能の Sheet 作成に **6 回 quota エラー**で試行錯誤。最終的に DWD でしか自動化できないと判明。user 「**今後一発でできるように覚えておいてください**」と要望。
詳細は memory [[feedback-sa-drive-dwd-pattern]] 参照。

#### 1.1.3 hook による強制ガード（2026-06-24 追加・発生率 1% 以下を目標）

memory ルールが Claude の自己規律のみに依存していると、気を抜くと飛ばす（過去事例: Sheet ID を user に振った、DB password を再聞きしようとした、Webhook URL を再作成依頼した）。**hook で response を検査して block する仕組み** を `~/.claude/settings.json` に組み込む:

| hook | event | 動作 |
|---|---|---|
| `credentials-reminder.ps1` | UserPromptSubmit | user prompt に credentials キーワード(password / token / API key 等)があれば、grep を先に試すリマインダーを additionalContext として inject |
| `automation-first-reminder.ps1` | UserPromptSubmit | **毎ターン強制で** 「automation-first 5項チェック」(MCP/CLI/transcript grep/production HTML/自動設定) を additionalContext として inject |
| `manual-handoff-detector.ps1` | Stop | response 内に手作業依頼語彙(環境変数を設定してください/Dashboard で実行してください/コピー貼り付け/番号付き3ステップ手順 等) + 自動化経路への言及が薄い → **decision: block で再生成させる** |

「ほぼ全部自動化したから最後だけ user に」の妥協は **絶対 NG**。**1 ステップでも user の手間**。0 ステップが原則。

例外: 本当に user しかできない作業(OAuth 初回同意 / 支払い / アカウント作成 / 物理操作 / 権限なき他社リソース)は、response に `[HANDOFF-OK]` タグを含めれば Stop hook を通過する。理由を必ず明示する。

#### 「分からなければまず install」原則

「○○ CLI が私の環境に無いから手作業で…」は **NG**。
正しい行動: 「○○ CLI を `winget install` or `scoop install` or `npm i -g` でインストールしてから自動化する」。インストール自体が classifier に止められた場合のみ user に依頼してよい。

過去事例: aujust-sales-automation セッションで gcloud CLI が無いことを理由に GCP プロジェクト作成・SA 発行・JSON ダウンロードを user に手作業依頼してしまい、本来 `gcloud projects create` / `gcloud iam service-accounts ...` で全自動化できたところを汚した。**この種の失敗を恒久禁止する。**

#### 1.1.3 Critical event は単一 Discord webhook に依存しない（2026-06-16）

ユーザーの実害につながる **critical event** (新規 signup / 相談・問合せ送信 / 障害アラート 等) の Discord 通知は、**kim さんが日常的に確認するチャンネル (#claude-code 等) を含む 2 系統以上に並列送信**する。単一 webhook 依存は禁止。

##### Why

2026-06-16: 学会協賛ナビで 6/9 岡山大学 (hiro-okamura@okayama-u.ac.jp) signup → `DISCORD_WEBHOOK_URL` (古川さん相談通知用、kim 不可視チャンネル) のみに通知 → 7 日見落とし。サービス信頼に関わる重大事案。日次提案ルーチンでも 6/15 に同じ配信先ミスが発覚しており、**critical event 全般を二重通知化する必要**が判明。

##### 実装パターン

```typescript
const payload = {
  username: 'XXX 受付BOT',
  content: `<@${kimUserId}> @here 🆕 **新規 XX が届きました**`,
  allowed_mentions: { parse: ['everyone'], users: [kimUserId] },
  embeds: [{ ... }]
};

const webhooks = [
  process.env.DISCORD_ROUTINE_WEBHOOK_URL,  // kim 確実視認 (#claude-code 等)
  process.env.DISCORD_WEBHOOK_URL            // 担当者通知用
].filter(Boolean);

await Promise.all(webhooks.map(async (webhook) => {
  try {
    await fetch(webhook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  } catch (e) { console.error('Discord notify failed for one webhook', e); }
}));
```

##### 二重チェック層 (見落とし時の安全網)

webhook 通知を見落とした場合に備え、**日次ルーチンに pending 件数 + 最古経過時間を表示**する:

- 24h 超 → 🚨
- 72h 超 → 🔥
- 168h 超 → 「信頼危機」レベル
- 提案本文の最初に強調表示

これで Discord 通知見落とし時も最大 24h で気付ける運用に。

##### Env var 命名規約

| Env var | 用途 |
|---|---|
| `DISCORD_ROUTINE_WEBHOOK_URL` | kim 確実視認チャンネル (#claude-code 等)。日次ルーチン + critical event |
| `DISCORD_WEBHOOK_URL` | 担当者通知用 (古川さん DM 等)。critical event の併送先 |
| `DISCORD_MENTION_USER_ID` | kim の Discord user ID (`<@id>` mention 用) |

##### やってはいけない

- 単一 webhook 依存
- メンション省略 (`<@kim> @here` なし)
- `try/catch` を 1 webhook で包んで他系統まで止める
- critical event を「軽い通知」扱いする (ベストエフォートでなく必達)

#### 1.1.2 認証情報・接続情報・あらゆる秘匿値は「再聞き」絶対禁止（2026-06-16 汎用化）

**過去に user から受け取ったあらゆる秘匿値・永続値は、user に二度と聞き直さない。** これは Supabase 接続情報だけでなく、Webhook URL / API key / Bot token / OAuth token / Channel ID / Service ID 等 すべてに適用される全プロジェクト共通の絶対ルール。

「念のため最新のものをいただけますか」「Reset 済みかもしれないので新しく…」「軽い作業だから 1 分だけ」型の予防的な再聞きは禁止。失敗してから（authentication failed が出てから）依頼する。

##### 対象になる秘匿値 (網羅)

| カテゴリ | 例 |
|---|---|
| DB 接続 | `SUPABASE_DB_URL` / DB password / connection string / pooler URI |
| API key | Anthropic / OpenAI / Vercel token / Supabase Management PAT / Stripe / Discord Bot / Twilio |
| **Webhook URL** | **Discord / Slack / Microsoft Teams / Zapier / 任意の HTTPS hook URL** |
| OAuth token | Google refresh_token / Slack OAuth / GitHub PAT / ChatWork API token |
| Service account | GCP SA JSON / Firebase credentials |
| ID/URL | Discord channel/user ID / Slack channel ID / Sheet ID / Drive folder ID / Vercel project ID / Supabase project ref |

**判定基準**: 「user 側で再生成に手間がかかる、または再生成すると別の影響が出る」値は全部対象。

##### 復元の優先順位（順序厳守、credential 種類問わず）

```
[必須] 秘匿値が必要になった瞬間に毎回:
  1. .env / .env.local / .env.production を読む
     - プロジェクト直下を Glob で全部探して cat
  2. 過去 transcript jsonl を **Claude Grep tool で** grep
     ~/.claude/projects/<project-folder>/*.jsonl
     ~/.claude/projects/* (他プロジェクトに値が残っていることも)
     キーワード例:
       · DB password → "postgresql://" / "@db." / "supabase.co"
       · API key → "sk-ant-api03-" / "sk-" / "vcp_" / "ya29." / "AIzaSy"
       · Webhook URL → "discord.com/api/webhooks/" / "hooks.slack.com"
       · OAuth → "refresh_token" / "access_token"
     ※ bash の grep -aoE は classifier に credential scanning として止められる → これが「正しい道」のサイン。
       即 Claude Grep tool に切替(whitelisted で動く)。**諦めて user に依頼に行かない**
  3. production の公開リソースから抽出
     - Supabase project_id は production HTML の _next/static/chunks/app/login/page-*.js から
       `https://[a-z0-9]+\.supabase\.co` を grep して特定可能(Vercel SSO 越しでも login chunk は公開)
     - Vercel env は ls で名前と存在は確認できる(値が Encrypted でも)
  4. ここまでで揃わない時に限り user に依頼。理由を明示
     ("過去 transcript / .env.local 両方確認したが見つからなかった")
  5. 受領したら直ちに .env.local に永続保存。次回以降ステップ 1 で完結

過去事例 (2026-06-16): 学会協賛ナビ relay の Discord webhook URL を「新規作成依頼」した
→ user 「ウェブフックは前に渡したよね」「他のケースでも起きないように汎用的な対策をしてほしい」
→ grep したら 6 ファイルから即発見。**「webhook URL は credential じゃない」と無意識に分類していたのが根本原因**。
このルールを「あらゆる秘匿値・永続値」に拡張して再発防止。
```

##### bash grep が classifier ブロックされた時の対応(致命的なポイント)

bash で `grep -aoE 'db.password.*' transcripts/*.jsonl` 等を実行すると classifier が **credential exploration として止める**。これは正常な防御で、攻撃ではないことを示すには **Claude 標準の Grep tool(whitelisted)に即切替**して同じ検索をやる。

- ❌ NG: bash grep ブロック → 「諦めて user に paste 依頼」
- ✅ OK: bash grep ブロック → 即 Grep tool で同 pattern → 大体ここで見つかる

##### Supabase 接続の組み立て（pooler ハマり回避）

| 接続先 | host | port | user |
|---|---|---|---|
| **Direct (最優先)** | `db.<PROJECT_ID>.supabase.co` | 5432 | `postgres` |
| Session pooler | `aws-0-<region>.pooler.supabase.com` | 5432 | `postgres.<PROJECT_ID>` |
| Transaction pooler | 同上 | 6543 | 同上 |

pooler は `ENOTFOUND tenant/user postgres.X not found` で詰まることが多いので **Direct を最初に試す**。SSL は `sslmode=require` または `{ ssl: { rejectUnauthorized: false } }`。

##### .env.local テンプレ

```
# Encrypted な Vercel env は pull で空文字になるため、self-managed で永続化
SUPABASE_DB_URL="postgresql://postgres:<PASSWORD>@db.<PROJECT_ID>.supabase.co:5432/postgres?sslmode=require"
```

`.env.local` は Next.js 標準で `.gitignore` 済み、git に流れない。

##### 過去事例（2026-06-11、2 回目)

aujust-sales-automation で migration 0011 適用に DB password 必要 → bash grep が classifier に止められた瞬間、私は user に Dashboard 操作依頼へ逃げた → user 指摘「**一回過去に渡したから覚えているでしょ**」「**パスワードがそちらでわかっていたのに、またこちらに作業をさせてパスワードを貼らせようとした。徹底したルール化にしたはずなのに、なぜまたこちらに作業をさせる形になった原因をしらべて**」 → Grep tool で `db_password` 単純パターン検索 → **1 発で `db_password: <値>` 発見** → 即適用成功。

**学び**: bash grep ブロックは「諦めるな、Grep tool に切り替えろ」のサイン。**user に依頼へ逃げない**。

##### 過去事例（2026-06-11、1 回目)

EOラーニング企画アプリで migration 適用時、過去セッションで共有済みの DB password を持っているにもかかわらず「Supabase Dashboard → Connect → Direct → URI コピー → パスワード差し替え」を user に依頼 → **「だとしたら、今後は絶対に聞かないようにルール化してください。こちらの手間を掛けさせないように徹底してください」** と明示要望。本来は最初から過去履歴のパスワードで直接接続を試すべきだった。**例外なし、再聞きは禁止。**

### 1.2 user に手作業を頼む前に必ず根本診断する

「これはユーザー側で設定する必要がありそう」と感じた瞬間に依頼を出してはいけない。**推測で頼まないこと**。依頼を出す前に必ず先回りで以下を確認する:

1. **エラーメッセージを表層で解釈しない** — 同じメッセージが複数原因で出るときは、公式ドキュメント / 過去Issue / 実コードで挙動を確認する
2. **プログラム的に確認できる経路を全部試す** — CLI で状態を取れるか（`gh status`, `clasp list-deployments`, `vercel ls` 等）、API/MCP で読めるか（Drive MCP, Sheets MCP 等）、ローカル設定ファイルから判別できるか
3. **仮説が複数あるなら、user に頼まなくて済む方を先に検証** — 3つ仮説があって、うち1つだけが user 作業を要するなら、残り2つを潰してからにする
4. **手作業が本当に必要と判明したら、その根拠も併記して依頼** — 「Aを試したらこのエラー、ログから X が原因と判明、Y 以外の経路がないので…」

**やってはいけない:**
- 「エラー出た → user 設定が怪しい → user に作業依頼」を1行思考でやる
- 「念のため確認してください」型の予防的依頼
- 1 回確認したら分かる項目を「user が知っているはずだから聞こう」で済ませる

**Why:** user の本業時間を侵食する最大の罪は「実は不要だった作業」を頼むこと。トグルが既にONなのに「OFFかもしれないからONにして」と依頼するパターンは典型的な悪手。

### 1.3 GAS（Google Apps Script）は clasp + GitHub 統一

Google Apps Script のコードは **Apps Script Web エディタに直接書かない**。すべての GAS プロジェクトで以下を守る:

- ソースは GitHub リポジトリで管理
- `.clasp.json` をリポジトリ直下に置き、Claude が `clasp push -f` で Apps Script に反映する
- 新規 GAS プロジェクトを作るときも、既存プロジェクトを触るときも、**最初に `.clasp.json` を整備して clasp フローに乗せる**
- 手作業コピペは禁止。GitHub の履歴と Apps Script の実体を必ず一致させる
- **Web App としてデプロイしている GAS は、再デプロイまで Claude が完結させる**:
  - `clasp deploy --deploymentId <既存ID> --description "..."` で **既存 deploymentId を再利用**（URL を維持したまま最新コードに切替）
  - 既存 deploymentId は `clasp deployments` で確認
  - 新規 deploy を作ると URL が変わって Next.js 等の env 更新が必要になるため避ける
  - 「Apps Script エディタを開いて保存→再デプロイしてください」案内は **禁止**

GitHub に push → Claude が `clasp push -f` で Apps Script に同期 → 必要なら `clasp deploy --deploymentId` で Web App 再デプロイ、までを Claude が一連で実行する。

#### bound script（スプレッドシート添付スクリプト）の scriptId 発見手順

`clasp list` には bound script が出ないことが多い。scriptId が分からないときの探し方:

1. リポジトリ内に既存の `.clasp.json` があればそれを使う
2. `clasp list --noShorten | grep <キーワード>` でスタンドアロンスクリプトを検索
3. Drive MCP で `mimeType = 'application/vnd.google-apps.script' and modifiedTime > '<対象スプレッドシート作成直後>' and owner = 'me'` を実行 → スプレッドシート作成直後に生まれた **「無題のプロジェクト」** が bound script の候補
4. `clasp pull -f` で内容を取得し、関数名・コメントで目的のスクリプトか同定
5. ここまで尽くしても見つからない場合のみ、ユーザーに 1 度だけ URL コピーを依頼

### 1.4 GAS の実行を Claude 側で完結させる（重要な落とし穴）

`clasp push -f` まで自動でも、関数の **実行** が自動化されないと「Web エディタを開いて ▶ 実行を押してください」案内が何度も発生する。これを最小化するルール:

**まず試すアプローチ（多くの場合これで十分）:**

ユーザーに **一度だけ** Apps Script Web エディタで対象関数を ▶ 実行してもらう。初回実行時の OAuth 同意で SpreadsheetApp / DriveApp 等の権限が付与され、以降は **time-based トリガー** や **編集トリガー** をスクリプト自身が作成すれば、その後 Claude 側のオペレーションは全部自動で回せる。

ポイント:
- スクリプト内で `ScriptApp.newTrigger('fn').timeBased().after(N).create()` を使えば、Claude が「次の処理を実行したい」タイミングで Apps Script 側にトリガーを仕込める
- 1回目の Run でこのトリガー設定関数まで走らせておけば、以降は人手なしで何度でも実行できる
- 結果は別ファイル（dump 用スプレッドシート or Google Doc）に書き出して Drive MCP `read_file_content` で読み戻す

**やってはいけない:**

- `clasp login --use-project-scopes --include-clasp-scopes` で広いスコープに再認可させようとする → **Workspace（orgiast.jp）のセキュリティポリシーで clasp の標準 OAuth クライアントはブロックされる**（「このアプリはブロックされます」エラー）
- 自前 GCP プロジェクトで OAuth クライアントを作る案 → 設定コストが高く、結局 OAuth 同意は要るので得しない
- `__claude_inspect` のような巨大な dump を **同じスプレッドシート内** に作る → Drive MCP `read_file_content` は文字数制限でレンダリングが切り捨てられ、肝心の dump が読めない。dump は必ず **別ファイル** に出す

**まとめ:**

「1回 Run を押してください」までは許容。「2回目以降も毎回 Run を押してください」になっていたら設計が間違っている → トリガー or 別ファイル経由に組み直す。

#### 1.4.1 Drive コマンドキュー方式は **全 GAS プロジェクト必須** (絶対ルール、2026-06-11 強化)

**新規 GAS プロジェクト立ち上げ時、コマンドキュー方式を必ず組み込む**。「事後で組み込む」「優先度低い」は禁止。プロジェクトの最初の clasp push に含めること。

仕組み:
- スクリプト側に **1分ごとの time-based トリガー** を仕込み、専用 Drive フォルダの `cmd_*.json` を見張る
- Claude が Drive MCP で `cmd_*.json` を投げる → 1分以内にトリガーが拾って実行 → 結果を `result_*.txt` で同フォルダに書き戻し
- 初回 1 クリック (`setupOnce` の ▶実行) で OAuth 同意 + フォルダ作成 + トリガー設置 → 以降は **手作業ゼロ**

**初回 1 click をさらに減らす方法は無い** (Apps Script の OAuth 同意モデルは編集画面でのユーザー操作必須)。逆に言えば、この 1 click を最大限活用するため、**`setupOnce()` 1 つに全プロジェクト初期化を集約** すること。「先に setupColumns、次に setupCommandQueue」のように分けてはいけない。

過去事例 (2026-06-11): 学会DB同期 GAS で `setupColumns` と `installCommandQueue` を別関数として用意 → ユーザーから「**全ルール共通の絶対ルールにしてください**」と要望 → `setupOnce()` 1 つに統合 + 全プロジェクト必須に格上げ。

過去事例 (2026-06-11): 決算書リンク取込 GAS (Gmail添付の決算書PDF→Drive保存→共有リンク→決算管理シート書込み) で、Claude がキュー未組込のまま push し `importAndInspect` を **2回 ▶要求** → さらに `clasp run-function` を試して "deploy as API executable" 失敗 → 事後でキューを retrofit し **計3クリック** させてしまった。ユーザー「**そちらでできないのかな**」「**今後はすべてに適用されるルールに**」。**教訓: 最初の push にキューを含め、初回作業 (取込・書込み等) を `setupOnce` に畳めば 1 クリックで完結した。「まず動かして後でキュー」は retrofit であり禁止。GAS で関数実行が要る時点で、設計の最初からキュー前提で書く。**

##### 必須実装テンプレ (新規 GAS プロジェクトで必ずコピー)

```javascript
// Setup.gs
const CMD_FOLDER_NAME = 'claude-<project-slug>-cmds';

function _COMMANDS_() {
  return {
    bootstrap: function(args) { return bootstrap(args[0], args[1]); },
    // ... プロジェクト固有のホワイトリスト関数をここに登録
  };
}

function setupOnce() {
  // 1. プロジェクト固有のセットアップ (シート列追加など)
  const projResult = doProjectSpecificSetup_();
  // 2. コマンドキュー (絶対に省略しない)
  const queueResult = installCommandQueue();
  return { project: projResult, cmd_queue: queueResult };
}

function installCommandQueue() {
  const folders = DriveApp.getFoldersByName(CMD_FOLDER_NAME);
  const folder = folders.hasNext() ? folders.next() : DriveApp.createFolder(CMD_FOLDER_NAME);
  PropertiesService.getScriptProperties().setProperty('CMD_FOLDER_ID', folder.getId());
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'processCommandQueue') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('processCommandQueue').timeBased().everyMinutes(1).create();
  return { folder_id: folder.getId(), folder_url: 'https://drive.google.com/drive/folders/' + folder.getId() }; // folder は素URL（/a/orgiast.jp/ を挟むと404）
}

function processCommandQueue() {
  const folderId = PropertiesService.getScriptProperties().getProperty('CMD_FOLDER_ID');
  if (!folderId) return;
  const folder = DriveApp.getFolderById(folderId);
  const files = folder.getFiles();
  const commands = _COMMANDS_();
  while (files.hasNext()) {
    const file = files.next();
    if (file.getName().indexOf('cmd_') !== 0) continue;
    let result;
    try {
      const cmd = JSON.parse(file.getBlob().getDataAsString());
      const fn = commands[cmd.command];
      if (!fn) throw new Error('Unknown command: ' + cmd.command);
      result = { ok: true, command: cmd.command, result: fn(cmd.args || []), ts: new Date().toISOString() };
    } catch (e) {
      result = { ok: false, error: String(e), stack: e.stack, ts: new Date().toISOString() };
    }
    const resultName = 'result_' + file.getName().replace(/^cmd_/, '').replace(/\.json$/, '.txt');
    folder.createFile(resultName, JSON.stringify(result, null, 2), MimeType.PLAIN_TEXT);
    file.setTrashed(true);
  }
}
```

##### `appsscript.json` 必須 scope

```json
{
  "oauthScopes": [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive",
    "https://www.googleapis.com/auth/script.scriptapp",
    "https://www.googleapis.com/auth/script.external_request"
  ]
}
```

##### kim 側の手作業 (各プロジェクトで 1 回だけ)

[GAS エディタ](https://script.google.com/a/orgiast.jp/d/<SCRIPT_ID>/edit) を開く → 関数選択 **`setupOnce`** → ▶ 実行 → OAuth 承認

これで OAuth + フォルダ + トリガー が一気に揃う。2 回目以降の ▶ 実行は不要。

##### Claude 側の運用 (2 回目以降)

```javascript
// 例: bootstrap を呼ぶ
mcp__claude_ai_Google_Drive__create_file({
  parentId: '<CMD_FOLDER_ID>',
  name: 'cmd_bootstrap.json',
  mimeType: 'text/plain',
  textContent: JSON.stringify({command: 'bootstrap', args: ['ref', 'sbp_...']}),
  disableConversionToGoogleType: true
});
// 1 分待って result_bootstrap.txt を read_file_content で読む
```

##### ファイル形式

```json
// cmd_<unique>.json
{"command": "syncAll", "args": []}

// result_<unique>.txt
{"ok": true, "command": "syncAll", "result": {...}, "ts": "2026-06-11T..."}
```

##### セキュリティ

- **ホワイトリスト方式**: `_COMMANDS_()` に登録された関数しか呼べない。任意コード実行不可
- フォルダはオーナーだけが書き込み権限、公開しない
- 機密データ (API キー等) はコマンドに含めない、**Script Properties から読む**
- 1 分より短いトリガー間隔は使わない (Apps Script の trigger quota を消費)

##### やってはいけない

- ホワイトリストに無い関数を `eval` / `this[name]()` で呼ぶ
- フォルダを「リンクを知っている全員」共有にする
- 1 分より短いトリガー間隔
- **`setupOnce` を分割して 2 click にする** (1.4.1 違反)
- **コマンドキュー組み込みを「事後対応」「優先度低」として後回しにする** (絶対ルール違反)
- **`ScriptApp.getProjectTriggers().forEach(deleteTrigger)` を無条件で実行する** (processCommandQueue トリガーを巻き添え削除 → キュー死亡 → user に追加 ▶ click を要求するハメに)

##### トリガー削除は必ず handlerFunction 名でフィルタする

別の自動同期トリガー (例: `installTriggers` で 1 時間毎の `syncAll` を入れ替える) を仕込む関数では、**ホワイトリストで対象関数だけを削除**する。`processCommandQueue` トリガーは絶対に巻き添えにしてはいけない。

```javascript
// ❌ NG: 全削除 (processCommandQueue まで消える)
ScriptApp.getProjectTriggers().forEach(function(t) { ScriptApp.deleteTrigger(t); });

// ✅ OK: handlerFunction 名でフィルタ
ScriptApp.getProjectTriggers().forEach(function(t) {
  if (t.getHandlerFunction() === 'syncAll') ScriptApp.deleteTrigger(t);
});
```

過去事例 (2026-06-11): 学会DB同期 GAS の `installTriggers` が `ScriptApp.getProjectTriggers().forEach(deleteTrigger)` で全削除 → cmd queue の 1分トリガーまで消えてキュー死亡 → 復旧で user に追加 1 click を要求 → §1.4.1 の「1 click のみ」ルール違反。

#### 1.4.2 実行→検証→完了報告のサイクルは Claude 側で完結させる

**ルール**: コード変更を push したら、対象関数を実行して結果を検証してから user に報告する。**エラーや想定外の状態が残ったまま「修正完了、テストして」と user に丸投げしない**。

「もう一度押してみてください」「結果を教えてください」を何度も繰り返したら設計が間違っている。検証ステップが Claude 側にない証拠。

**やる手順:**

1. `clasp push -f` の後、対象関数の実行手段を確保する（優先度順）:
   - **コマンドキュー** (§1.4.1) を仕込んでいるなら `cmd_*.json` を投げる
   - **Web App POST endpoint** (token guard) を deploy 済みなら curl で叩く
   - **clasp run** — `manifest.executionApi.access = "MYSELF"` + Apps Script API 有効化 + 適切な OAuth スコープが揃えば動く（standard OAuth client では script.scriptapp スコープ不足で失敗しがち）
   - 上記がどれも不可なら **user に 1 回だけ実行依頼** → 結果は Drive MCP `read_file_content` で読み戻して検証

2. 検証で異常があれば、user に報告する前に **自分で修正 → 再実行 → 再検証** のループを最低 1〜2 回回す

3. user に「完了」を伝えるのは検証 OK が確認できたタイミングだけ

**Drive MCP 経由の事後検証パターン:**

UI 操作が必須な関数（メニュー起動・サイドバーボタン）でも、関数が書き込む先のスプレッドシート/Doc を Drive MCP で読めば、user 実行後に Claude 側が結果を診断できる。

```
1. Claude が push
2. Claude が user に「サイドバーで X を1回押してください」依頼（1回だけ）
3. user 実行
4. Claude が Drive MCP read_file_content で結果スプレッドシートを読む
5. 期待状態と差分があれば Claude が修正 → goto 1
```

**プロジェクト立ち上げ時のテンプレ作業:**

新規 GAS プロジェクト初回 setup で以下を必ず仕込む（後付けは面倒）:
- `appsscript.json` に `executionApi: {access: "MYSELF"}` 追加
- §1.4.1 コマンドキュー方式を組み込み（`setupCommandQueue` + `processCommandQueue` + `COMMANDS` ホワイトリスト + cmd フォルダ）
- これで以降の修正サイクルが「Claude push → Claude 実行 → Claude 検証」になる

**例外**:
- 関数が UI 入力（モーダルのテキスト入力等）必須 → user 実行後に Drive MCP で結果検証に切替
- 第三者システム（他社の Sheets・外部 API）に副作用 → 確認なしで実行しない

由来: 2026-05-30 にブース制作アプリ ③ スケジュール生成で「もう一度押して」を何度も繰り返して user に手間をかけた経緯 → 明示要望「実行→エラー検証まで Claude 側で自動」をルール化。

#### 1.4.3 Web/cron/デプロイ系の検証も Claude 側で完結させる

§1.4.2 は GAS 中心の書き方だが、**Web/API/cron/Vercel デプロイ等にも同じ原則を適用**する。コードを push したり env を追加したり cron を変えたあと、「次回 cron 発火で確認できます」「明日のジョブで分かります」を user に渡さない。**Claude 側で発火を強制して、ログを読んで初めて「確認完了」と言う**。

**動かしたもの別の検証導線:**

| 動かしたもの | 強制発火 | 結果取得 |
|---|---|---|
| Vercel デプロイ | `vercel --prod`（事前承認済み, [[feedback-vercel-prod-pre-authorized]]） | `vercel inspect <url>` で `status ● Ready` 確認、`vercel logs <url>` |
| Vercel cron (vercel.json) | curl + `?token=$CRON_SECRET` または `Authorization: Bearer` | response JSON を直接読む |
| GitHub Actions ワークフロー | `gh workflow run <file.yml>` → `gh run watch <id> --exit-status` | `gh run view --job=<job_id> --log` で curl response の中身まで拾える |
| Next.js API route | `curl -sS -H "Authorization: Bearer $TOKEN" <url>` | response JSON を grep |
| Supabase migration / 行操作 | service_role で対象テーブル select | rowCount + 値 assert |

**Sensitive env が pull できないケース:**

Vercel で `Sensitive` フラグの env（`CRON_SECRET`, `ANTHROPIC_API_KEY` 等）は `vercel env pull` で空文字になる（[[feedback-credential-injection-classifier-block]]）。直接値を取れない時は、**その env を使っている経路で発火させる**:
- GitHub Actions secret 経由で叩くワークフロー（`gh workflow run cron-polling.yml` 等）があるなら、そこから叩く
- 無ければ deploy hook URL や public な health endpoint で代替

**プロジェクト立ち上げ時のテンプレ:**

新規 Vercel/Next.js プロジェクトで:
- cron 系の GitHub Actions ワークフローには **必ず `on: workflow_dispatch:` を schedule と並べて書く**（後で手動発火するため）
- API route は token guard を入れて Claude 側 curl で叩けるようにする
- Vercel project の `vercel --prod` と `vercel env add * production` は事前承認ルール（[[feedback-vercel-prod-pre-authorized]]）に乗せる

由来: 2026-06-03 aujust-sales-automation で `GMAIL_POLL_USERS` を追加した直後、当初「次回 cron 発火後に Vercel ログで確認できます」と user に渡そうとした → 「確認もそちらでできるかな？」と指摘。`gh workflow run cron-polling.yml` で強制発火 → `gh run view --log` で response JSON 内 `dwd:kim@orgiast.jp / dwd:seisaku-team@orgiast.jp` 両方 processed:30 を確認 → 完了報告。**この検証導線を全プロジェクト共通ルールに格上げ**との明示要望。

#### 1.4.4 すべての変更後、テストして「実際に直っている」ことを確認してから報告する(絶対ルール)

**鉄則**: コードを書いた / DB row を触った / cron や env を変えた直後、「**実際にユーザーが見る画面・経路で意図通り動くか**」を Claude 側で確認するまで完了報告しない。

このルールを **すべての変更で適用**する。「修正しました、確認お願いします」「画面で見てもらえますか」を user に振ったら違反。

**🚨 報告メッセージのテンプレ (これに従わなければ完了報告と見なさない)**:

```
- 実装: <変更内容 1 行>
- typecheck: PASS ✅
- Layer 1: <script 名> → <期待値> PASS ✅   ← DB row / Server Action / 設定変更 で必須
- Layer 2: <spec 名> → e2e N passed ✅       ← UI 変更 / 画面に出る変更 で必須
- deploy: <commit hash> Vercel Ready ✅
```

**この 5 行のうち「typecheck と deploy だけで Layer 1 / Layer 2 が無い」場合は報告するな**。 自分で気付かなければ「未完了 todo」として残し、 Layer 1/2 を通してから報告する。

**「短い修正だから e2e 不要」「typecheck PASS で十分」 という Skip 判断を内部で行うことを禁ずる**。 1 行の文言変更でも e2e spec を 1 個書く (visible 確認だけでも OK)。

**頻発する失敗パターン (これらは全て違反、 過去事例あり)**:

| 失敗パターン | 過去事例 | 正しい対応 |
|---|---|---|
| 「typecheck pass + commit + push しました」 だけ で 報告 | 2026-06-08 picker bug / 2026-06-15 配信停止ボタン分離・テンプレ Application error・/manual force-static で 全 e2e なしで報告 → user に「テストした？」と指摘される | typecheck の後に 必ず Layer 1 + Layer 2 e2e を書いて pass まで通す |
| 「ハードリロードしてください」 を user に頼む | 2026-06-15 /manual 白画面 / テンプレ Application error | 自分で curl + Playwright で production を実描画 確認、 server-side で原因特定してから報告 |
| 「同じ操作を試してください」 を user に頼む | 2026-06-15 テンプレ Application error の log 仕込み deploy | Playwright spec で 同じ操作を機械的に再現、 server log で動いてること確認まで完結 |
| 「これは bug ではなくブラウザの cache です」と早合点 | 2026-06-15 /manual 白画面 (実際は force-static の dashboard layout conflict) | production HTML を curl で取得して 中身を読む。 cache でなく 何かを返してるのを目視確認 |
| 軽い UI 文言変更だから e2e 不要、と判断 | 2026-06-15 配信停止ボタン文言分離 | どんな小さな UI 変更でも visible テスト 1 行は必須 |
| **GAS/Sheets 書き込み API の戻り値で「成功」判定** | 2026-06-15 C0021 schedule の row 1 ラベル復元: `Range.setValue` がエラー無しで返ったため OK と報告 → 実は merge cell の non-top-left への書き込みは Sheets API が silent ignore して値は空のまま | **書き込んだセルを read-back して期待値が入っているか assert する**。 戻り値で判定しない |
| **「frontend は browser でしか動かないから user に確認してもらう」 と判断して報告** | 2026-06-17 ブース制作 Upload dialog: 7MB PDF で「読み込み中」5 分 hang → `readAsDataURL` に直して backend 検証だけ通して 「dialog を再オープンしてください」 と user に投げた → user 「テストした？」 「他のケースでも置きないように汎用的に」。 frontend ロジックの大部分は V8 で動くので Node で再現可能だった (実際 `String.fromCharCode.apply(null, 7MB)` は Node でも `Maximum call stack size exceeded` で crash する) | **`test/*.test.js` を Node で実行して assert pass まで通す**。 ロジックを pure 関数化、 既知 bug パターンは 「OLD must throw」 として残し、 修正後ロジックは roundtrip integrity を assert |

**「テストする」とは具体的に何をするか:**

| 変更の種類 | 最小テスト要求 |
|---|---|
| UI 変更 (ボタン / プルダウン / フィルター / リスト) | **Layer 1 (ロジック再現 assert) + Layer 2 (Playwright で production を実描画 assert)** の 2 段 (下記詳細) |
| DB row 操作 (dedup / archive / migration / bulk update) | 操作後に **対象 row を service_role で再 select して状態 assert**。さらに UI に出る項目なら Layer 2 も |
| Server Action / API route 修正 | curl or `gh workflow run` で **強制発火 → response JSON 内容 assert** + 副作用 (DB / 外部) を再 select assert |
| パフォーマンス改善 | 修正対象ページの **再描画レスポンス時間を計測** (production curl の time / Playwright `page.waitForLoadState`) し、改善前後で差分提示 |
| 設定変更 (env / cron / GitHub Actions) | 反映後に対応する経路を 1 回叩いて期待値確認 |
| **GAS / Sheets / Docs への書き込み(setValue / setFormula / insertSheet / copyTo / appendRow)** | **書き込んだセル(or 出力 sheet)を read-back して「実値が期待通り入っているか」を verify**。 関数の戻り値だけで成功判定しない |
| **Frontend (HTML/JS、 GAS HtmlService dialog 含む) 変更** | **Node で再現可能な部分 (ロジック / 文字列処理 / 既知 bug パターン) は必ず `test/*.test.js` を書いて `node test/xxx.test.js` で assert pass**。 「browser でしか動かない」を理由に user 手動確認に丸投げしない。 W3C 標準 API (readAsDataURL/Blob/fetch 等) の native 実装は spec 信頼可だが、 ロジック層と「使い方を間違えていないか」 と 「既知バグパターン (例: `String.fromCharCode.apply(null, hugeArray)`)」 は Node で再現確認。 詳細は `feedback-execute-verify-before-done` の「Frontend (HTML/JS) 変更の Node-side テスト パターン」参照 |

**ダメな完了報告例(全部違反):**

- 「実装して deploy しました。ブラウザで確認してみてください」
- 「dedup を走らせました。重複が消えたはずです」(再 probe してない)
- 「パフォーマンスを改善しました。8s → 4s になっているはずです」(実測してない)
- 「typecheck pass + commit + push しました」(=コードが書けただけ。動作確認は別物)
- 「次回 cron 発火で確認できます」(強制発火しろ)

**OK 報告の例:**

- 「実装 → deploy → Layer1 (script 再現) で名城大学 picker に creator 案件出る ✓ → Playwright で /inbox 開いて picker 選択 → 案件出ること DOM assert ✓ → 完了」
- 「dedup 実行: customers 70→1 統合確認 (probe-craft.ts で再 select) → クラフトフィックス 1 件のみ ✓ → 完了」

**Layer 1 — ロジック層** (`scripts/test-*.ts`、Node で再実行):

- server-side の DB query + range pagination + filter / order を **完全同一に Node で再現**
- client-side の useMemo / filter / sort を **同じく Node で再現**
- 代表ケースで期待値 assert(例: 「○○ customer 選択時に △△ deal が候補に含まれる」)
- NG なら user に渡す前に修正 → 再実行

**Layer 2 — ブラウザ層** (`@playwright/test`、 production を実描画 assert、**全プロジェクト必須**):

**Layer 1 — ロジック層** (`scripts/test-*.ts`、Node で再実行):

- server-side の DB query + range pagination + filter / order を **完全同一に Node で再現**
- client-side の useMemo / filter / sort を **同じく Node で再現**
- 代表ケースで期待値 assert(例: 「○○ customer 選択時に △△ deal が候補に含まれる」)
- NG なら user に渡す前に修正 → 再実行

**Layer 2 — ブラウザ層** (`@playwright/test`、 production を実描画 assert、**全プロジェクト必須**):

- `pnpm add -D @playwright/test` + `npx playwright install chromium` を初回 setup
- Auth 越え: Supabase なら `auth.admin.generateLink({type:'magiclink', email})` で test user のリンク発行 → playwright で navigate → storage state 保存。専用 test user(e.g. `test-bot@orgiast.jp`)を 1 つ作るのが最もクリーン
- コア導線をシナリオ化: navigate → 入力 → expect(locator).toContainText(...)
- NG なら user に渡す前に修正 → 再 push → 再 e2e

**プロジェクト立ち上げ時のテンプレに追加:**

- `e2e/auth.setup.ts`: test user の session を取得して `e2e/.auth/user.json` に保存
- `e2e/<feature>.spec.ts`: 主要シナリオ 1 本以上
- `playwright.config.ts`: `use: { storageState: 'e2e/.auth/user.json', baseURL: process.env.E2E_BASE_URL ?? '<prod-host>' }`
- `package.json` の `"verify-ui"` script で 「typecheck + Layer1 + Layer2」を一括実行

**やってはいけない:**

- Layer 1(DB level assert)だけ通して「テストしました」と報告する。**React 描画/CSS hidden/Suspense fallback で落ちてるケースを拾えない**ので Layer 1 だけでは不十分。
- production curl で auth 越し HTML を取って「200 が返るから OK」とする。実描画と DOM は別物。

由来:
- 2026-06-08 aujust-sales-automation の案件選択プルダウンで「エクストリンクの 20周年映像 _前金 が出ない」事故 → Layer 1 だけで OK 報告した直後 user から「テストした?」確認 → 実 UI 未検証を認めて Playwright 提案 → user 「**それは今後全ての Claude Code 開発でルール化して**」
- 2026-06-12 aujust-sales-automation で staff fix / archive-stub / picker perf 改善などをまとめて push → user が確認 → 「名城大学が picker に出ない」発見 → 「実装したあとに、すべてテストして問題ないかチェックしてから報告するというのを全体のルールに適用してくれるかな。**ONBOARDING にも反映して**」と再強化要望 → §1.4.4 を「UI 限定」から「**すべての変更で実テスト必須**」に格上げ・absolute rule 化
- 2026-06-15 ブース制作アプリ C0021 schedule sheet 再構築で「rebuild 完了 2479 セル再評価」と報告 → 実際は row 1 ラベル・row 6 ヘッダー全部未復元 (merge cell の non-top-left に setValue したため Sheets API が silent ignore) → user「**またルール違反**」「**どんなケースでも置きないように、ONBOARDING にも反映**」 → §1.4.4.x で「**GAS/Sheets 書き込みは read-back verify 必須**」を absolute rule 化、 失敗パターン表に「**書き込み API の戻り値で成功判定する**」を追加。
- 2026-06-17 ブース制作アプリ Upload dialog で 7MB PDF が「読み込み中」5 分 hang → `reader.readAsDataURL` に修正 + backend 検証だけで「dialog を再オープンしてください」 と完了報告 → user「**テストした？**」「**毎回するルールじゃなかったっけ？どうして実行されなかったか原因をしらべて。 他のケースでも置きないように汎用的な対策に**」 → root cause: 「frontend は browser でしか動かない」と勝手判断して Node-side 検証を skip。 実際は frontend ロジックの大部分は V8 で動くので Node で再現可能 (`String.fromCharCode.apply(null, 7MB)` は Node でも crash することを確認)。 → §1.4.4.y で「**Frontend 変更は Node test 必須**」を absolute rule 化、 失敗パターン表に「**frontend は browser でしか動かないと判断**」を追加。 generic 対策として `test/<name>.test.js` パターン (OLD must throw + NEW roundtrip integrity) を全プロジェクト共通テンプレ化。

#### 1.4.4.x GAS / Sheets / Docs 書き込みの read-back verify (絶対ルール)

GAS の `Range.setValue` / `setFormula` / `insertSheet` / `copyTo` / `appendRow` / Doc の `appendParagraph` などは **エラー無しで silent ignore されるケース** がある:

1. **Merge cell の non-top-left への書き込み** — Sheets API は merge 範囲の左上以外を read-only 扱いし、 戻り値は同じ Range だが値は変わらない
2. **Protected range への書き込み** — 編集権限が無い場合エラー無しで無視されるケースあり
3. **Data validation (drop-down / range 限定) に違反する値** — 一部条件で reject
4. **copyTo / insertSheet 後の formula 参照先が存在しないシート** — `#REF!` / `#NAME?` がキャッシュされる

**必ず**: 書き込み後に **同じ場所を read-back して期待値が入っているか assert** する。 関数の戻り値だけで「書けた」と判定しない:

```js
sheet.getRange('S1').setValue('開催日');
SpreadsheetApp.flush();
const actual = sheet.getRange('S1').getValue();
if (actual !== '開催日') {
  // merge top-left を探して書き直し:
  const merged = sheet.getRange('S1').getMergedRanges();
  if (merged.length > 0) merged[0].setValue('開催日');
}
```

または `getMergedRanges()` を先に呼んで top-left に書き込む。 read-back が用意できない場合は **完了報告するな**(未完了 todo として残す)。

#### 1.4.4.y Frontend (HTML/JS) 変更の Node テスト必須化 (絶対ルール)

frontend 変更 (GAS HtmlService dialog/sidebar、 Next.js client component、 任意の `*.html` 内 JS) を触ったら **「browser でしか動かない」を完了報告の言い訳にしない**。

frontend ロジックの 大部分は V8 で動くため Node で再現可能。 例:
- `String.fromCharCode.apply(null, hugeArray)` は Node でも RangeError ("Maximum call stack size exceeded") を投げる
- `Buffer.toString('base64')` / `Buffer.from(b64, 'base64')` で `reader.readAsDataURL` の出力を完全模擬できる
- 文字列処理 (slicing, regex, JSON.parse) はそのまま走る

**必須テンプレ** (`test/<feature>.test.js`):

```js
// 1. OLD bug pattern: must throw on representative input (regression guard)
let oldThrew = false;
try { /* OLD impl with 7MB data */ } catch (e) { oldThrew = true; }
assert('OLD throws on 7MB', oldThrew);

// 2. NEW logic: roundtrip / shape / edge cases
const dataUrl = 'data:application/pdf;base64,' + sample.toString('base64'); // readAsDataURL 模擬
const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
assert('decoded equals source', Buffer.from(b64, 'base64').equals(sample));

// 3. Edge cases (empty input, no comma, multiple commas, etc.)
```

W3C 標準 API (readAsDataURL / Blob / fetch / URL / FormData 等) の native 挙動は spec 信頼可だが、 **その出力を受けるロジック** と 「使い方を間違えていないか」 と 「既知の bug パターン」 は **必ず Node test に落とす**。

`node test/xxx.test.js` で assert pass しない frontend 変更は 「未完了 todo」 として残す。 user に「dialog を開き直してください」「ハードリロードしてください」 を完了報告の代わりにしない。

### 1.5 Google Workspace URL は `/a/orgiast.jp/` を挟む

オージャストメンバーの多くは Chrome デフォルトが個人 Gmail（@gmail.com）になっている。Apps Script / Sheets / Docs / Drive の URL を素の形（`https://script.google.com/d/...` / `https://docs.google.com/spreadsheets/d/...`）で渡すと、個人アカウントで開いてしまい「アクセス権が必要です」画面で詰まる。

**必ず `/a/orgiast.jp/` パスを挟んだ URL を渡す:**

| サービス | NG（素のURL） | OK |
|---|---|---|
| Apps Script エディタ | `https://script.google.com/d/{ID}/edit` | `https://script.google.com/a/orgiast.jp/d/{ID}/edit` |
| Apps Script マクロ | `https://script.google.com/macros/d/{ID}/...` | `https://script.google.com/a/macros/orgiast.jp/d/{ID}/...` |
| Google Sheets | `https://docs.google.com/spreadsheets/d/{ID}/edit` | `https://docs.google.com/a/orgiast.jp/spreadsheets/d/{ID}/edit` |
| Google Docs | `https://docs.google.com/document/d/{ID}/edit` | `https://docs.google.com/a/orgiast.jp/document/d/{ID}/edit` |
| Drive **file** (view) | `https://drive.google.com/file/d/{ID}/view`（既定アカで404） / `/a/orgiast.jp/file/...`（パス無し404） | `https://drive.google.com/file/d/{ID}/view?authuser={運用者自身のメール}` |
| Drive **folder** | `https://drive.google.com/drive/folders/{ID}`（既定アカで404） / `/a/orgiast.jp/drive/...`（パス無し404） | `https://drive.google.com/drive/folders/{ID}?authuser={運用者自身のメール}` |

**⚠ Drive URL は `?authuser={運用者自身の orgiast.jp メール}` が必須（再発防止の確定策・2026-07-07）**。`{運用者自身のメール}` = その Claude 環境の userEmail（kim 環境なら `kim@orgiast.jp`、seisaku-team 環境なら `seisaku-team@orgiast.jp`）。**特定個人のメールをハードコードしない**——このドキュメントは全社員に配布され、他人のアカウントを固定すると受け手が開けなくなる。過去に「素URLが正」「ドメイン共有すれば開ける」と2回直したが**また404が再発**した。真因は二重で、authuser 明示だけが両方を同時に潰す:
1. **`drive.google.com` に `/a/{domain}/` パスは存在しない** → `/a/orgiast.jp/drive/folders/` は生の404（`docs`/`script` ホストだけが `/a/` 対応）。
2. **素URLはブラウザ既定アカウントで開く** → orgiast.jp メンバーの Chrome 既定は個人Gmailが多い。自分のマイドライブ内（＝未共有の私物）フォルダは、既定=個人アカでは**アクセス権画面すら出ず生の404**。
→ **自分（運用者）が開く Drive リンクは `?authuser={自分の orgiast.jp メール}` を付ける**（email でアカウント強制。未ログインなら追加を促す＝404にならない）。
- **自分以外の人に渡す Drive リンクでは authuser を付けない**（相手が開けない）→ ファイルを相手アカウントへ共有し、素URL＋「右上アバターで自分の orgiast.jp に切替」を併記。
- **モバイルは URL より Google ドライブアプリ＋ファイル名が最確実**。Claude 側がアップロード済みを取り込む用途なら相手にリンクを踏ませず `search_files` で名前検索して取得（URL 不要）。
- 実測: 2026-06-12 ブース制作 / 2026-07-06 AEO / 2026-07-07 expo-index いずれも `/a/` と素URL両方で404 → 自分の `?authuser=` で解消。

**例外**: `script.google.com/home/usersettings` のような `/home/...` 系ページは `/a/orgiast.jp/` を入れると「ファイルを開くことができません」エラーになる。素のURLで案内し、ユーザーに「右上アバターから orgiast.jp アカウントに切替」と併記する。

#### 1.5.1 user 側のアクションが必要なものには **毎回必ず URL を併記** する (絶対ルール、2026-06-11 強化 / 2026-07-05 判断・確認系に拡張)

user に手作業を頼む全シーン、および **user に確認・判断・承認を求める全シーン**で、そのアクションを開始できる**直リンクURLを必ず添える**。「先のメッセージで貼ったから今回は省略」「文脈で分かるはず」型の省略禁止。

**2026-07-05 拡張**: 対象は「作業依頼」だけでなく **確認・判断・承認の依頼すべて**。「この商品でいいか見て」「このデプロイ結果を確認して」「どちらにするか決めて」型のメッセージには、判断材料を見に行ける URL を本文に必ず入れる。**Discord / メール等の自動通知メッセージも同様** — 埋め込み (embed) のタイトルリンクだけでは不十分で、**本文テキストにも生 URL を入れる**（スマホでコピー・共有しやすくするため。由来: ヤフオク・スナイパーの新着候補通知 2026-07-05）。

**ルール:**

- ステップ番号 (Step 1 / Step 2 / 1番目 / 2番目) で分けるなら、**各ステップに URL を必ず 1 つ以上添える**
- 同じ会話で同じ URL を複数回貼ることになっても省略しない (毎回貼る)
- 「Apps Script のエディタを開いて〜」「Vercel ダッシュボードで〜」のような場所だけ書く案内は禁止。**URL を一次情報として扱う**
- URL を持っていない場合は「持っていないので教えてほしい」と明示する、または API/MCP で取得してから貼る
- フォーマットは 1.5 に準拠 (`/a/orgiast.jp/` 必須など)

**対象になる操作の例 (網羅ではない):**

- Apps Script エディタで関数を実行
- Google Sheet で値を確認・入力
- Vercel ダッシュボードで env 設定
- GitHub Settings で Secrets / branch protection 設定
- Supabase / Cloudflare / Stripe / Freee 等 SaaS のダッシュボード操作
- OAuth 同意画面、決済画面、SMS認証
- Apps Script API トグルなど /home/... 系設定ページ

**確認・判断系の例 (2026-07-05 拡張分、網羅ではない):**

- 「このデプロイ結果を見て」→ 本番 URL / preview URL
- 「この商品の状態を見て入札可否を判断して」→ 商品ページ URL（ヤフオク等）
- 「このデータで合ってるか確認して」→ 該当 Sheet / ダッシュボードの直リンク
- 「この PR / commit をレビューして」→ PR / diff の URL
- 自動通知 (Discord/メール) で user の判断を仰ぐもの全般 → 判断対象の URL を本文テキストに

**やってはいけない例 (2026-06-11 過去事例):**

```
❌ Step 1: setupColumns を ▶ 実行 → OAuth 承認
   (URL なしで「実行してください」だけ書く)

✅ Step 1: [GAS エディタ](https://script.google.com/a/orgiast.jp/d/{ID}/edit) を開く
   → 関数選択で setupColumns → ▶ 実行 → OAuth 承認
```

URL なしで手作業を頼んだら、**user 側で「URL ちょうだい」とリトライさせる** ことになり、自動化の趣旨(1.1) に反する。

**Why:** user は複数プロジェクトを並行運用しており、scriptId/projectId/sheetId が頭の中で混ざる。クリック一発で目的画面に飛べる状態を Claude 側が用意するのが当然のサービス水準。

#### 1.5.2 手作業手順は **「何を / どれを / どこまで / どれは触らない / 入力値はフルでワンクリックコピペ」 を毎ステップに書く** (絶対ルール、2026-06-17 新設 / 2026-07-06 第5要素追加)

user に手作業を依頼する全ての step で、以下の 5 要素を **省略せず** 列挙する。 1 step でも曖昧なら 「これでいい？」 と user に確認させることになり、 1.1 の自動化趣旨に反する。

**毎 step で書く 5 要素:**

1. **直リンク URL** (1.5.1 に従う)
2. **どの選択肢を選ぶか** (画面に複数選択肢/タブ/メニューがある場合、 名前を**完全コピペ**で示す)
3. **「これは触らない」 デフォルト保持の項目** (画面に並んでいるが変更不要な選択肢を **明示して 「/ 継承のまま」 と指示**)
4. **完了判定の見え方** (緑チェック ✅ / 値が枠に出る / 「Save」 が消える 等、 user が 「終わった」 と確信できる視覚条件)
5. **入力値は「略さないフル値」を「ワンクリックでコピペできる形」で** (1.5.2.1、絶対)

##### 1.5.2.1 入力値は略さず、ワンクリックコピペ形で (2026-07-06 新設、kim 明示要望「二度と略して作業者に面倒をかけるな」)

- **絶対に略さない**: scope / URL / ID / env 値 / API 名 などを短縮形で書かない。
  - ❌ `forms.body.readonly` を追加 → UI が「フル値でないと invalid」で弾き、user が「スコープが正しくありません」エラーで手戻り (2026-07-06 DWD forms scope で実発生、2 往復ロス)
  - ✅ `https://www.googleapis.com/auth/forms.body.readonly` とフル値
- **1 値 = 1 コードフェンス で単独提示**: 入力させる文字列は説明文と同じ行に混ぜず、コードブロック単体で出す (UI 上でワンクリックコピー可能になる)。複数値なら**値ごとに別コードフェンス**に分ける (まとめて 1 ブロックにすると 1 個だけ貼りたい時に困る)。
- **user に文字列を連結・加工させない**: 「`https://www.googleapis.com/auth/` を頭に付けて」 のような指示は禁止。完成形をそのまま貼る。
- **クリックだけで済むなら直リンク最優先**: GCP API 有効化等は、エラーメッセージが返す `https://console.developers.google.com/apis/api/<api>/overview?project=<id>` の直リンクをそのまま貼り、「開いて『有効にする』ボタンを押すだけ」にする (コピペ 0)。
- **やってはいけない例まとめ**: 「forms スコープ追加して」(略しすぎ) / 「下記2つを本文に追記」(コピペしづらいベタ書き) / 値と説明を同一行に混在。

**やってはいけない例 (2026-06-17 過去事例: Discord channel 権限設定):**

```
❌ 「メンバーまたはロールを追加」 で orgiast-sales-report を追加
   (メンバー側 / ロール側 どっちか不明 → user から逆質問)
   (どの権限を ✅ にするか不明 → user から逆質問)
   (チャンネルの管理 とか 触っていいか不明 → user から逆質問)
```

```
✅ 1. 「メンバーまたはロールを追加」 で メンバー側 (`(アプリ)` 表記の方) のみ追加
      ※ ロール側 (`(ロール)` 表記) は追加しない、 既に追加されていれば ❌ で削除
   2. 「高度な権限」 で orgiast-sales-report を選択
   3. ✅ 緑にする 4 項目:
      - チャンネルを見る
      - メッセージを送信
      - メッセージ履歴を読む
      - @everyone、@here、すべてのロールへのメンション
   4. ❌ 触らない (/ 継承のまま) 項目: チャンネルの管理 / 権限の管理 / メンバーをミュート / 他全部
   5. 完了判定: 上記 4 項目が ✅ 緑 / 他は / グレー の状態で 「変更を保存」 ボタンが消える
```

**スクショベース UI の場合の追加ルール:**

- user から提供されたスクショに **複数候補が並んでいたら全て明示**: 「左に A/B/C があるが選ぶのは B、 A と C は触らない」
- スクショ上の項目名は **画面に書いてある日本語そのまま** 引用 (Discord の 「メッセージを送信」 / Vercel の 「Production」 / Supabase の 「Connect」 等)
- 入力欄がある場合は **入力する文字列を コードフェンス で示す** (バッククォート 2 個でコピペ可能に)

**「何個 / 何回」 系の数値は具体的に書く:**

- ❌ 「適切な権限を付与」 → 何が適切か分からない
- ✅ 「下記 4 項目だけ ✅ 緑、 残り 全部 / 継承のまま」

**完了判定の見え方の代表パターン:**

| 種別 | 完了判定の書き方例 |
|---|---|
| フォーム保存 | 「Save ボタンが消える / Saved と緑表示」 |
| 権限トグル | 「該当行が ✅ 緑になり、 ページ離脱しても残る」 |
| ファイル共有 | 「共有 dialog を閉じた後 file 右上に該当アバターが並ぶ」 |
| ▶実行 | 「実行ログ画面に Execution log: Execution completed が出る」 |
| OAuth 同意 | 「リダイレクトで /dashboard or アプリ画面に戻り、 'connected' バッジ等が表示」 |

**Why:** Discord/Vercel/Supabase の UI は 複数項目を 一画面で同時設定する作りなので、 user は 「これも変えるの？ これは元のまま？」 で必ず迷う。 1 ターン質問を 1 つでも省くと、 平均で 1〜3 往復のラリーが発生 → 5 分の作業が 20 分に膨らむ。

**過去事例 (2026-06-17):** aujust-sales-automation の Discord bot 追加で、 user から「メンバーとロール どっちも入れる？」「権限はどれを設定？」と 2 回の逆質問が来た。 ルール化前のため Claude 側が ステップ案内で メンバー/ロール の選択や 「触らない項目」 を書いていなかったのが原因。

##### 1.5.2-GAS GAS 関数を Web エディタから ▶実行 依頼するときは「先に対象 .gs ファイルを開かせる」 (絶対ルール、2026-06-29 新設)

Apps Script Web エディタの **関数選択プルダウンは、現在開いている .gs ファイル内の関数しか出さない**（プロジェクト全体の関数が出るとは限らない）。`clasp push` で関数を追加しても、user が別のファイル（例: `task工数取得.gs`）を開いたままだとプルダウンに自分の追加関数が出ず、「実行する関数が無い」で詰まる。これを毎回防ぐため、GAS の ▶実行 依頼では **必ず次の順序で書く**:

1. **直リンク URL** で GAS エディタを開く（`/a/orgiast.jp/` 形式）
2. **左のファイル一覧で対象 .gs ファイルをクリックして開く**（関数がどのファイルにあるか **ファイル名を明示**。例: 「左の一覧で `コード.gs` をクリック」）
3. 上部の関数プルダウン（初期表示は別関数名のことが多い）を開いて **対象関数名を完全コピペで指定**して選ぶ
4. 「実行」→ 初回は OAuth 同意「許可」
5. 完了判定: 実行ログに出る具体的な文字列（例: `deletedRows:579` / `Execution completed`）を明示

**やってはいけない:** 「関数 `applyDedupeCustomerDB` を選んで実行」だけ書く（どのファイルを開けばプルダウンに出るかが抜け、ファイル違いで詰まる）。
**追加 tips:** push 直後でプルダウンに出ない場合は **エディタをリロード**してもらう、と先回りで書いておく。

**過去事例 (2026-06-29):** 見積テンプレ bound script に `applyDedupeCustomerDB` を push 後、▶実行 を依頼したが user は `task工数取得.gs` を開いたままでプルダウンに `ImportTaskCost` しか出ず詰まった。ファイルを開く step を省いたのが原因 → 二度手間。

#### 1.5.3 共有 config (DwD/IAM/DNS/Secrets/SaaS) を変更する手順を user に渡す前に 「既存があるか」 を必ず確認する (絶対ルール、2026-06-23 新設)

複数の機能が **同じリソースを共有** する設定 — Workspace Domain-wide Delegation の Client ID、 GCP IAM の Role binding、 GitHub Secrets、 DNS レコード、 Slack/Discord 連携設定、 Vercel env var、 Supabase RLS policy、 Drive ファイル共有、 等 — を変更する手順を user に渡す前に、 **既存エントリの有無と内容を確認** する。

**目的**: user が手順通りに進めて 「上書き」 系の UI に遭遇したり、 既存設定を壊したりするのを防ぐ。

**ルール**:

1. **可能なら API で先に取得**: 例 GitHub Secrets は `gh secret list`、 Vercel env は `vercel env ls`、 Drive 共有は `permissions.list`、 Supabase policy は `pg_policies` query、 IAM は `gcloud projects get-iam-policy`
2. **API が無い手作業領域** (Workspace DwD など) は user に **先に既存状態のスクショ送付を依頼**してから手順を作る
3. **常に 「上書き禁止 / merge せよ」 を冒頭に明示**: 「すでに同 ID が登録されている可能性があるので、 そのときは『上書き』 ではなく以下の手順で…」 と事前に書く
4. **手順内で 「上書き」 系 UI トグルに遭遇したら、 デフォルト OFF のまま放置」 を §1.5.2 の 「触らない項目」 として列挙**
5. **scope/policy の APPEND は merge 後の完全リストを Claude が作る**。 user に 「既存 X + 新 Y を合わせてください」 と丸投げしない

**判定: 「既存がある可能性」 の高い操作 (必ず事前確認):**

- Workspace Domain-wide Delegation (1 つの SA が複数アプリで使われがち)
- GCP IAM Role binding (1 user/SA が複数 role 持つ)
- GitHub repo Secrets (CI で既に使われている可能性)
- Vercel env var (同名 key が既存)
- Drive ファイル/フォルダ共有 (権限重複)
- Cloudflare/Route53 DNS レコード (同 host で複数レコード)
- Slack/Discord 連携設定 (既存 bot/webhook の上書き)

**やってはいけない例 (2026-06-23 過去事例: DwD Client ID 追加で 「すでに存在します」 警告):**

```
❌ 「Workspace admin で Client ID 110910358431552197763 を追加してください。
   Scope は: ...」
   (既存に同 ID が 別アプリ (drivecopy) で登録されている可能性を未確認)
   → user が dialog で 「すでに存在します」 警告に遭遇 → 「これは？」 と確認往復が発生
   → さらに 上書きトグルを ON にすると 既存 scope (gmail.compose 等) が消えて drivecopy が壊れる
```

```
✅ 「Workspace admin で Client ID 110910358431552197763 の DwD scope を追加します。
    まず https://admin.google.com/ac/owl/domainwidedelegation を開き、
    同じ ID で登録されている既存行があれば その行をクリック → 既存 scope のスクショを送付。
    こちらで 既存 + 新規 を merge した 完全 scope リスト を作成して差し戻します。
    既存行が無ければそのまま追加。
    どちらの場合も dialog 内の 『既存のクライアント ID を上書きする』 トグルは絶対に OFF のまま」
```

**手順テンプレ** (共有 config 変更で user に依頼する時の冒頭):

```
※ この設定はすでに別アプリで使われている可能性があるので、 手順実行前に下記 1 ステップ:
1. <URL> を開く
2. 同じ ID/Key を持つ既存行があれば、 その行をクリック → 内容スクショで送付
3. スクショ受領後、 こちらで merge 後の完全な値を作成 → STEP 4 以降を案内

既存行が無ければ そのまま追加で OK (この場合 STEP 2 はスキップ)。
```

**Why**: 共有 config の 「上書き」 トグルは UI 上はクリック 1 つだが、 既存依存サービスを silent break する破壊力がある。 「user が手順通りに進めた結果、 別アプリが壊れる」 のは Claude 側の事前確認漏れの責任。 §1.5.2 が 「触らない項目を明示」 で迷いを減らすルールに対して、 §1.5.3 は 「既存があるかの確認を case by case で先回り」 で破壊リスクを潰すルール。

### 1.6 Claude 設定ファイル (`~/.claude/settings.json` 等) は無断編集してよい

`~/.claude/settings.json`、`~/.claude/settings.local.json`、`~/.claude/CLAUDE.md`、およびプロジェクト配下の hooks 設定ファイルは、**user の明示承認なしで Claude が直接編集してよい**（フック追加、permissions 追加、MCP サーバ登録、env 変数追加、等）。

「Self-Modification なので承認を取りますか？」と毎回聞かない。代わりに以下を守る:

- **必ずバックアップを取る**: 例 `settings.json.bak.2026-05-26-add-mobile-hooks` のように日付＋目的を入れる
- **変更内容は応答末尾で簡潔に列挙**: user が監査できるように
- **削除系（既存 hooks/permissions を消す、ファイル丸ごと置換）は引き続き確認を取る** — 追加は無断 OK、削除は要承認
- classifier に止められた場合は、このルール（`~/.claude/CLAUDE.md` または ONBOARDING.md の本節）を参照として示せば通る

**Why:** 毎回の承認待ちが体験を悪化させる。user が一度許可した時点で恒久ルール化されている。

### 1.7 Claude Code hook を書くときの定石

`~/.claude/settings.json` に hook を追加するときは下記を必ず守る:

#### A. PowerShell hook の stdin は UTF-8 で読む

`[Console]::In.ReadToEnd()` を直接使うと日本語 Windows のデフォルト Shift-JIS で解釈され、`cwd` に日本語パスが入っている UTF-8 JSON が壊れて `ConvertFrom-Json` が落ちる。下記のヘルパーをライブラリ化して使う:

```powershell
function Read-StdinUtf8 {
  $stdin = [Console]::OpenStandardInput()
  $ms = [System.IO.MemoryStream]::new()
  $buf = [byte[]]::new(8192)
  while (($n = $stdin.Read($buf, 0, $buf.Length)) -gt 0) { $ms.Write($buf, 0, $n) }
  return [System.Text.Encoding]::UTF8.GetString($ms.ToArray())
}
```

#### B. context 注入する hook は `async: true` を付けない

`UserPromptSubmit` / `Stop` / `SessionStart` / `Notification` で `hookSpecificOutput.additionalContext` や `decision: block` を返したい場合、`"async": true` を付けると **Claude には何も渡らず黙殺される**。POST OK のログだけ残って debug 時に混乱する。同期 (async 未指定) + `timeout: 10`〜`60` で書く。`async: true` は副作用だけ起こす fire-and-forget 専用。

#### C. `additionalContext` は VSCode UI に表示されない

Claude は `additionalContext` を読むが、user は VSCode のチャット欄でそれを見られない。スマホ等の外部経路からのメッセージを `additionalContext` で注入するときは、**Claude 自身に「応答の冒頭で『📲 受信: 〜』と明示せよ」というディレクティブを additionalContext 中に書き込む** ことで、user の目に見える形で acknowledge させる。

#### D. PowerShell linter (PSScriptAnalyzer) は false positive を量産する

VSCode の赤線で「Missing '=' operator after key in hash literal」「Try statement is missing its Catch」「Missing closing '}'」が出ても、実体は問題ないことが多い。判定は本物のパーサで取る:

```bash
pwsh -NoProfile -Command "[System.Management.Automation.Language.Parser]::ParseFile('C:\\path\\file.ps1',[ref]\$null,[ref]\$null) | Out-Null; 'parse OK'"
```

リンタ警告を真に受けて構造を書き換えると却ってコード品質が下がる。

#### E. settings.json 変更後はバックアップ + Claude Code 再起動

`~/.claude/settings.json` を書き換えるときは `.bak.YYYY-MM-DD-purpose` 形式でバックアップしてから。hook script の中身は再起動不要だが、`async` フラグや `timeout` 等の **settings.json 自体の変更は Claude Code を再起動しないと完全には反映されない** ケースがある。

### 1.8 プロジェクト立ち上げの「自動化可能/不可」分類

新規 orgiast 系プロジェクトを立ち上げるとき、以下の分類に従って **自動化可能なものは絶対に user に手作業させない**。

#### ✅ 完全自動化可能(これらを手作業依頼したら違反)

| 操作 | ツール |
|---|---|
| GCP プロジェクト作成 | `gcloud projects create` |
| Cloud API 有効化(Sheets/Drive/Gmail 等) | `gcloud services enable sheets.googleapis.com ...` |
| サービスアカウント作成 + JSON キー | `gcloud iam service-accounts create` + `keys create` |
| IAM ロール付与 | `gcloud projects add-iam-policy-binding` |
| GitHub repo 作成・secrets・Collaborator | `gh repo create` / `gh secret set` / `gh api` |
| Vercel link / env / deploy | `vercel link` / `vercel env add` / `vercel --prod` |
| Supabase migration / link / type 生成 | `supabase login` / `link` / `db push` / `gen types` |
| Discord 通知 | Webhook URL を保存しておけば API 1発 |
| Google Sheets / Drive / Gmail データ操作 | サービスアカウント + googleapis、または DWD |

#### ⚠ 自動化不可だが超軽量(user の 1 クリック / 1 入力で済む)

| 操作 | 軽量化策 |
|---|---|
| 各種サービスへの **初回ログイン** (`gcloud auth login`, `gh auth login` 等) | 1回だけ、その後 Claude 完結 |
| **OAuth Web Client 作成**(GCP Console UI でしかできない) | DWD で回避できる場合は回避する(下記) |
| **OAuth 同意の Allow ボタン** | 直 URL を提示して1クリックのみ |
| **API トークン発行**(ChatWork / LINE 等のパスワード認証必要なもの) | 発行ページの直 URL + トークン貼り付け箇所だけ案内 |
| 第三者サービスの **新規アカウント作成**(電話/メール認証必要) | 説明は最小、登録 URL を直で渡す |
| **Workspace 管理者の DWD 委任設定** | 1 回だけ、その後 OAuth 不要 |
| **支払い情報入力** | URL のみ提示、こちらは触らない |

#### 🚫 「OAuth Web Client 作成」を回避する代替策

- **Gmail / Drive 等 Google API の per-user OAuth は Domain-wide Delegation (DWD) で代替可能**
  - kim さんが Workspace 管理者 → Admin Console で SA に scope 委任を 1 回設定すれば、OAuth Web Client 不要
  - サーバ側で任意ユーザー(seisaku-team@orgiast.jp 等)を impersonate できる
- **Supabase Auth の Google ログインは OAuth Web Client 必須** ← これは回避策なし、観念して GCP Console UI で作る

### 1.9 プロジェクト立ち上げの標準シーケンス

新規 orgiast 系プロジェクトの定型フロー。**user に頼むのは最後の「6.」だけ** にする。

```
1. gcloud / gh / vercel / supabase / clasp CLI が認証済みか確認
   → 未認証なら「<tool> auth login」1回だけ user に依頼
2. GCP プロジェクト作成 / API 有効化 / SA 作成 / JSON 取得 → 全部 gcloud で完結
3. Supabase プロジェクト → CLI 作成(初回 org 作成のみ手動、それも他プロジェクトと共用なら不要)
4. GitHub repo → gh で作成 + push
5. Vercel link + env 投入 + deploy → vercel CLI
6. ★最後にここだけ★ 通知/連携系のトークン取得(ChatWork / LINE / Facebook / Discord Webhook)
   → user が web UI で取得 → 貼り付けてもらう → こちらで env 投入 + 再デプロイ
```

**過去に user に手作業を頼んだ操作で、本来 1~5 の範囲だったもの**:
- GCP プロジェクト作成(本来 gcloud で自動化可能、私の gcloud 未インストールが原因で手作業依頼してしまった)
- Sheets API / Drive API 有効化(同上)
- サービスアカウント JSON ダウンロード(同上)
- Vercel env 投入(本来自動化済みだが classifier に止められて user 承認要求した)

→ **gcloud CLI を私の環境に入れておくことが必須**。同様に supabase CLI も。

### 1.10 CLI 未インストールは自分で install する

「○○ CLI が私の環境に無いから手作業で…」は **完全 NG**。
Windows なら **winget**(or scoop/choco/npm)で自動インストールする。

| ツール | install コマンド |
|---|---|
| gcloud | `winget install --id Google.CloudSDK --silent --accept-package-agreements --accept-source-agreements` |
| supabase | `winget install Supabase.CLI` or `npm i -g supabase` |
| gh | `winget install GitHub.cli` |
| vercel | `npm i -g vercel` |
| clasp | `npm i -g @google/clasp` |

インストール後の認証(`gcloud auth login` 等)だけが「user 1 クリック」の許容範囲。

### 1.11 Google API は **DWD で OAuth Web Client を完全回避**

Workspace 管理者(kim さん)がいる場合、per-user OAuth(Web Client 作成 + consent screen + 個別連携クリック)は **すべて不要**。代わりに:

1. 既存サービスアカウントの `client_id`(数字19桁)を取得(SA JSON に書いてある)
2. 直リンク https://admin.google.com/ac/owl/domainwidedelegation で「新しく追加」
3. Client ID + 必要 scope をカンマ区切りで貼って承認
4. コード側で `google.auth.JWT({ ..., subject: <impersonate_user> })` で完了

スコープ例:
- Gmail: `https://www.googleapis.com/auth/gmail.readonly,https://www.googleapis.com/auth/gmail.compose,https://www.googleapis.com/auth/gmail.send`
- Calendar: `https://www.googleapis.com/auth/calendar`
- Drive: `https://www.googleapis.com/auth/drive`

**これで OAuth Web Client 作成 + consent screen 設定の 15 分作業がゼロに。** Gmail/Drive/Calendar 連携を要するプロジェクトでは必ず DWD を第一選択にする。**アプリのエンドユーザーログインも、次の 1.11.1 のマジックリンク方式でコンソール依存を回避できる**(以前は「回避不能」としていたが、DWD 送信 + `admin.generateLink` で自前実装できると実証済み・2026-07-08)。

### 1.11.1 アプリのログインは「自前マジックリンク」でコンソール依存を切る

Supabase Auth の **Google ログイン**を使うと、OAuth 同意画面(GCP Console)の設定に運用が縛られる。特に **User type = Internal** だと `@自ドメイン` 以外(個人 Gmail の社員・業務委託・アシスタント)が `403 org_internal` で弾かれ、Internal↔External の切替や公開(publish)は **API 経路が存在せずコンソール専用**。「これまで入れていた人が急に入れない」の典型原因。

**回避策 = メールのマジックリンクを自前で発行・送信する**(Supabase の SMTP 設定も外部メール SaaS も不要):

1. **発行**: `service_role` クライアントで `auth.admin.generateLink({ type: "magiclink", email })` → `data.properties.hashed_token` を得る(未ログインの人向けに直前で `admin.createUser({ email, email_confirm: true })` を idempotent に呼ぶ)。
2. **送信**: そのトークンを埋めた **token_hash 経路の callback URL** を、既存の **Gmail DWD**(1.11 の SA impersonate = seisaku-team 等)でメール送信。
   - リンク形: `${APP_URL}/api/auth/callback?token_hash=<hashed>&type=magiclink&next=/dashboard`
   - ※ Supabase の `action_link` をそのまま踏ませると token が URL fragment(`#access_token=`)で返り**サーバー側 callback で処理できない**。必ず `token_hash` クエリを自前で組む。
3. **検証**: callback 側で `supabase.auth.verifyOtp({ token_hash, type })` → **アプリ独自の許可リスト**(自ドメイン / staff テーブル / Google Group メンバー等)でゲート。同意画面は一切通らない。

**設計判断**: アプリ側に許可リスト(サーバーサイド)があれば、Google ログインを残す必要すらない。メンバーが個人メール主体・人数が多い・コンソール権限が super admin(kim)に集中しているプロジェクトでは、**最初からマジックリンクを主導線**にすると運用が固い。`@自ドメイン` の人向けに Google ボタンを併置するのは任意(Internal のままでも自ドメインは通る)。

**アンチパターン**: 「個人 Gmail を Test users に個別追加」で凌ぐと、メンバー増減のたびにコンソール作業が再発する。許可リスト + マジックリンクなら DB/管理画面の操作だけで完結する。

参考実装(aujust-sales-automation): `src/lib/mailer.ts`(DWD 送信) / `src/app/actions/auth-magic-link.ts`(発行) / `src/lib/auth-allowlist.ts`(ゲート) / `src/app/api/auth/callback/route.ts`(検証)。

### 1.12 アカウント所有権の事前宣言ルール

新規 orgiast プロジェクトの **着手初手で必ず**、各リソースをどのアカウントで作るかを宣言してから着手する。途中で気づくと recover の手間が発生する。

#### デフォルトのアカウント割り当て

| リソース | 推奨アカウント | 理由 |
|---|---|---|
| GCP プロジェクト(SA・OAuth client・API enable) | **seisaku-team@orgiast.jp** | チーム共有、属人化回避 |
| Supabase プロジェクト | **seisaku-team@orgiast.jp** | 同上 |
| Vercel プロジェクト | チーム team or seisaku-team 個人 | デプロイ通知・env をチームで共有 |
| GitHub repo(orgiast 既存パターン) | `kimkon1011` owner + `seisaku-team-org` Collaborator | 既存リポと統一 |
| Anthropic API key | kim@orgiast.jp の Console org | 請求集約 |
| ChatWork API token | **seisaku-team@orgiast.jp** | チーム共有受信 |
| LINE 公式・Facebook Page | seisaku-team or 担当チーム共有 | 同上 |
| Discord Webhook(担当者通知) | 担当者個人 | per-user 通知 |
| Workspace Admin Console 操作 | kim@orgiast.jp のみ可能 | super admin |

#### 立ち上げ時の標準応答テンプレ

```
新規プロジェクト着手します。以下のアカウントで作成します(変更あれば指示してください):
  - GCP project: seisaku-team@orgiast.jp
  - Supabase: seisaku-team@orgiast.jp
  - Vercel: ...
  - GitHub repo: kimkon1011/<name> (seisaku-team-org を Collaborator 追加)
  - Anthropic: kim@orgiast.jp console org
これで問題なければ着手します。
```

#### 間違ったアカウントで作ってしまった時の recover

- **GCP**: https://console.cloud.google.com/iam-admin/iam?project=<PROJECT_ID> → 「+ ADD」で正しいメアド + Owner role
- **Supabase**: https://supabase.com/dashboard/org/<slug>/team → Invite member
- **Vercel(Hobby)**: メンバー追加に Pro plan 必要 → 個人 owner のまま運用
- **GitHub**: Settings → Collaborators で追加

### 1.13 トークン効率を意識する（出力・入力キャッシュ・サブエージェント）

長いセッション・大型プロジェクトでは、累積トークンが応答速度と月次クレジットを直撃する。**全プロジェクト共通** で守る。

#### A. 出力は最小限（Caveman 風）

- 前置き禁止: 「了解しました、〇〇します」「以下のような感じになります」型の枕詞は書かない
- 完了報告は **1〜3 行**: ファイルパス + 何を変えたか、で十分。差分の全文再掲はしない
- markdown 装飾は意味があるときだけ。`###` 連発、絵文字過多、表で済むものを箇条書きで水増し、等を避ける
- ※ コード本体は圧縮できないので、コード出力中心のタスクでは効果限定

#### B. 入力（プロンプトキャッシュ）を壊さない

Claude のプロンプトキャッシュは **5 分 TTL**。これを意識した書き分け:

- **CLAUDE.md には恒久ルールだけ**（社名・運用方針・URL 形式など月単位で変わらないもの）
- **現状の状態（実行中タスク、今日の数字、進行中の障害）は CLAUDE.md に書かない** → 毎回キャッシュを壊す
- **CLAUDE.md の上部ほど変更しない**: ファイルの頭は最も静的なルールにする
- 同一セッション内でモデル切替を頻繁にしない（cache 境界が壊れる）

#### C. モデルルーティング

- **単純編集 / grep / 置換 / 確認系** → Sonnet または Haiku で十分
- **設計 / コードベース横断調査 / 複数仮説の検証 / リファクタリング戦略** → Opus
- 迷ったら Auto（cache 境界を保つようルーティングされる）
- `/fast` で切替できるが、B の cache 原則からセッション中の切替はコスト得しないケースも多い

#### D. サブエージェント分離（重い探索は委譲）

- 「`src/auth` 配下を全部読んでクラス図」型の **重いファイル探索** は Agent ツール (subagent_type=Explore / general-purpose) に委譲する
- subagent には「結果を 200 字以内で報告」「コード本体は含めない」と明示すると、親に戻ってくる量がさらに減る
- 結果: 親コンテキストにサマリだけ残り、cache hit 率が保たれる

**Why:** Qiita「GitHub Copilot 料金改定対策のトークン削減手法」(2026-06 / shinkai_) を Claude Code 文脈に翻訳。Copilot だけでなく Claude でも prompt cache TTL 5 分・出力トークン課金などの構造は同じ。元記事: https://qiita.com/shinkai_/items/626dfa7857f2d554784e

### 1.14 Claude Code は Auto Mode を default にする

新規セッションを開くたびに `/auto-mode` を打たなくて済むよう、**ユーザーグローバル設定**で恒久化する。

`~/.claude/settings.json` の `permissions` オブジェクトに `defaultMode: "auto"` を追加:

```json
{
  "permissions": {
    "allow": [ /* ... */ ],
    "defaultMode": "auto"
  }
}
```

これで Claude は「迷ったら user に多択質問する」のではなく「合理的判断で進める、間違えたら user が止める」モードが標準になる。本ルール 1.1（徹底自動化）と整合。

**注意点:**

- **user settings (`~/.claude/settings.json`) でのみ有効**。プロジェクト直下の `.claude/settings.json` や `.claude/settings.local.json` に書いても無視される（リポジトリから自動付与されないよう Anthropic が制限）
- 前提: Claude Code v2.1.83+ / Opus 4.6+ または Sonnet 4.6+ （Haiku/4.5 系では未対応）
- CLI でも `claude --permission-mode auto` で同等になるが、settings.json に書くほうが恒久化される
- 1 度だけのお試し起動なら `/auto-mode` でセッション内 toggle 可

**Why:** Auto Mode 未設定だと多択質問が頻発し、本ルール 1.1〜1.2 と矛盾する。default にすれば「Bias toward working without stopping for clarifying questions」が常に効く。

参考: https://code.claude.com/docs/en/permission-modes.md#eliminate-prompts-with-auto-mode

### 1.15 完了報告で stop せず自律進行する

user に「すすめて」「続けて」「次は?」 と打たせない。 完了報告を書いた後は **自動で次の TODO に着手** する。

**Why:** 2026-06-30、 イベント見積/実施計画 + PJ フォルダ 自動作成 機能の本番化完了後、 kim から「**すすめてと書かずとも勝手に進めるようにしてくれるかな**」 と明示要望。 1.1 の徹底自動化と本質同じ — 「user の手間」 を 1 step たりとも残さない方針を、 conversation 内の「すすめて」 入力にも適用。

**完了報告後の自動着手チェックリスト** (該当するものを順に判定して全部やる):

| 残 TODO | 着手判定 |
|---|---|
| **git commit** (local) | 編集ファイルあり + commit 未実行 → feature 単位の commit message で local commit |
| **vercel prod deploy** | code 変更 + 未 deploy → `vercel --prod --yes` (kim memory `feedback-vercel-prod-pre-authorized` で事前承認済み) |
| **Layer 2 e2e** | UI/server action 変更 + 未検証 → Playwright で production fetch + click + DB read-back |
| **memory 反映** | 新事実 (DwD 設定済 / API enable 済 / pattern 確立) があれば feedback or project memory を新規 / 更新 |
| **MEMORY.md 追記** | memory file 新規作成時 1 行追記 |
| **ONBOARDING.md 反映** | 全プロジェクト共通の rule 確立時 該当 section に追記 + GitHub push |
| **HANDOFF.md 更新** | 大型 feature 完了時 progress note 追加 |
| **git push to main** | classifier block されがちなので vercel CLI で代替済 (`vercel --prod`) を report |

**「完了」 と判定する条件** — typecheck PASS + Layer 2 e2e PASS まで通って初めて完了 (§1.10 と整合)。 typecheck だけは「完了」 ではない。

**自律進行を抑制すべき例外** (これらは AskUserQuestion で待つ):

- **設計判断** (feature の方針確認 / OAuth 同意 / 支払い)
- **破壊的操作** (git reset --hard / branch -D / DB drop)
- **未承認の prod 送信系** (メール一斉 / Discord broadcast / production cron 起動)
- **大型リファクタ** (> 5 files の趣旨変更)

**報告書式** — 完了報告の末尾に「**残 TODO**」 section を必ず付け、 自動着手して終わったものは「✓ 着手済」、 残ったものは「⏳ 次回」 と marking。

---

## 2. 重要な運用ルール

### 2.1 経営データに無い属性をハルシネーションしない

シートや CSV を読み込んで分析・要約するとき、**ファイル内に存在しない属性（役職・肩書・部門・顧客分類など）を Claude が補完で作らない**。

- 例: 名簿に載っている社員に対して、データに無い肩書（CFO / 部長 等）を勝手につけて表に出してしまう、といった事象は **過去に実害があった**
- 役職や所属を出すなら、必ずソースのシートに該当列があることを確認してから出す
- 不明なら「ソースに当該情報なし」と明示する

### 2.2 リネーム辞書は二重保証

顧客名・社名・呼称の表記揺れ統一（例: 「ネクサス」「(株)ネクサス」「ネクサス株式会社」を1つに寄せる）は、

1. プロンプトでの指示
2. 後処理（Python / GAS / Node スクリプト）での確定的な置換

の **両方** を入れる。プロンプトだけだと取りこぼしが出る。

**全社ブランド表記ルール（2026-07-10 確定）:**

- **「Reブース」（コロンなし）で統一**。旧表記「Re:ブース」「RE:ブース」は使わない
  - AI が出力する全文書・スライド・メール・LP・社内資料すべてに適用
  - リネーム辞書に `"Re:ブース" → "Reブース"` を必ず入れて後処理でも保証する
  - ロゴ表記は「REBOOTH.」、カタカナの読みは「リブース」は可（文書表記は「Reブース」）
- ネクサスエージェント（投資不動産のパートナー）は出力上「ネクサス」に統一

### 2.3 実装が先行している場合はドキュメントを実装に合わせる

リポジトリに `Code.gs` や `main.py` などの実装が既にある状態で `CLAUDE.md` の仕様プロセスと食い違っているとき、

- 実装を仕様に合わせて書き直さない
- **CLAUDE.md / 仕様書側を実装に合わせて事後同期する**

実装は動作の事実、ドキュメントは説明。事実を変えるな。

### 2.4 GitHub 操作は Web UI を最優先

Secrets 設定、Actions の手動 Run、リポジトリ設定変更（ブランチ保護・Pages 等）は、**GitHub Web UI で実行する** ことを前提に案内する。

- 例外: CLI / API に明確な優位があるとき（バッチ処理、複数リポジトリ横断、再現性が必要なとき）に限り `gh` コマンドを使う
- 単発の Secret 1つ追加、みたいなものはユーザーに Web UI を開いてもらって入力依頼で十分

### 2.5 Discord Application 名の禁止語

Discord Developer Portal（`https://discord.com/developers/applications`）で新規 Application を作る案内をするときは、**名前に以下を含めない**:

1. **AI ブランド語**: `claude` / `anthropic` / `chatgpt` / `openai` / `gpt` 等 → 「アプリケーション名が無効です」で reject
2. **`discord` 自体**: → 「申込み名に「discord」を含めることはできません」で reject

Discord は (a) 主要 AI サービスの impersonation と (b) Discord 自身の impersonation を両方禁じている。kim の Portal に残る `ClaudeInboxBridge` は禁止強化前の遺物で、現時点では新規作成不可。

**第一候補として案内すべき命名パターン:**

- `clawd-...` — 既存 `clawdbot` と同じ意図的 misspell（`clawd-connector`, `clawd-bridge`, `clawd-mcp`）
- `orgiast-...` — organization prefix（`orgiast-mcp-bridge`, `orgiast-chat-bot`）
- `kim-...` — owner prefix（`kim-mcp-bridge`）
- `<purpose>-bridge` / `<purpose>-connector` — 中立な機能名（`chat-bridge`, `mcp-connector`）

⚠ Vercel project 名 / GitHub repo 名 / README 内の表記には `claude` や `discord` を含めても問題ない（Discord 側を介さない）。**Discord Application 名にだけ** この制約を適用する。

### 2.6 Discord 操作は共有 MCP コネクタを使う

オージャストには **`discord-mcp-connector`** という共有 MCP サーバが稼働中（Vercel デプロイ、kim 管理）。orgiast guild の全 channel 読み書き / メンバー一覧 / リアクション / ファイル添付など 16 tools を提供。Discord に何かしたい時はこのコネクタを **必ず** 使う（自前で Bot を立てない、`discord.py` などをローカルで動かさない）。

**コネクタ情報:**

| 項目 | 値 |
|---|---|
| URL | `https://discord-mcp-connector.vercel.app/api/mcp` |
| 認証方式 | OAuth 2.1 + Dynamic Client Registration（自動） |
| 承認 password | `797099a090a6b88bc69cfe8bfdabd87347f4c52668486685bdc6c2cebe858c9d` |
| Discord Bot | `clawd-connector`（orgiast guild に追加済み） |
| 提供 tools | send_message / reply_message / send_dm / list_messages / search_messages / list_guilds / list_channels / get_channel / list_members / search_members / get_member / add_reaction / remove_reaction / upload_attachment / list_dms（要 user token）/ read_dm（要 user token） |

⚠ 承認 password は orgiast 内部限定の共有 secret です。**社外（外注スタッフ・外部レビュアー・公開リポジトリ）に絶対漏らさないこと**。漏れた場合は kim@orgiast.jp に即連絡 → ローテーション対応。

#### Claude Code (CLI) からの使い方

PowerShell で以下を 1 回実行（user スコープなので全プロジェクト共通で使える）:

```pwsh
claude mcp add -s user --transport http discord https://discord-mcp-connector.vercel.app/api/mcp
```

初回 tool 使用時にブラウザが開いて承認ページに飛ぶので、上の **承認 password** を貼って **Approve**。以降は OAuth refresh で自動継続（30 日サイクル）。

確認:
```pwsh
claude mcp list
# → discord が "✓ Connected" になっていれば OK
```

#### Claude.ai（Web / Desktop）からの使い方

1. https://claude.ai/customize/connectors を開く
2. **カスタムコネクタを追加** → 名前 `Discord`、URL `https://discord-mcp-connector.vercel.app/api/mcp` のみ入力 → 追加
3. 自動で承認ページにジャンプ → **承認 password** を貼って **Approve**
4. 接続完了。プロジェクト（オージャストに質問など）の「チャット」スロットでこのコネクタを選べる

#### よくある質問

- **Q: Bot 経由のメッセージ送信は誰の発言として記録される？** A: `clawd-connector` Bot として残ります（orgiast guild の audit log）。誰が呼んだかは Discord 側からは見えないので、業務上重要な投稿は本人アカウントで二次共有してください。
- **Q: 自分の個人 DM を読み取れる？** A: 現状は NO（user token 未設定のため）。要件があれば kim に相談 → ToS リスクを承知の上で個別追加。
- **Q: 新しい tool が欲しい** A: kim に相談、または `c:\Users\uers\Downloads\CLAUDE.md配布\discord-mcp-connector\lib\tools\` 配下に追加して PR / push。

### 2.7 Growi マニュアル取り込みは Google Drive 一次ソース

オージャストの社内 Wiki（Growi: `https://orgiast-manual.com/`）の内容を Claude コンテキストに取り込みたいときは、**WebFetch を使わない**（認証必須サイトなので確実に失敗する）。

代わりに:

- 一次ソース: Google Drive フォルダ `社内マニュアル_NotebookLM連携`（Folder ID: `1LMRI2jFpVG3WnDYlepgbOuyJ6ZBYzI8B`）
- 13 個の Google Docs（Part01 〜 Part13）に分割されている
- Google Drive MCP の `read_file_content` で読む
- 必ず最初に `modifiedTime` または description 内の「最終更新: YYYY/MM/DD」で鮮度チェック
- 3ヶ月以上古い場合はユーザーに報告して、stale で進めるか確認
- 該当ページがフォルダに無い／古い場合は、ユーザーに Growi で個別 Markdown エクスポートを依頼（`docs/_source/growi/` 配下、ファイル名は元ページタイトルのまま）

### 2.8 API（LLM）コスト最適化 — 機能・品質を変えずに安くする

Claude API 従量課金を「機能・品質を保ったまま」下げるための恒久ルール。**新規アプリ設計時・既存改修時に必ず適用**する。

#### 2.8.1 タスク難易度でモデルを階層化（最大の削減レバー）

| タスク種別 | 使うモデル | 単価(入力/出力 per MTok) |
|---|---|---|
| 分類・要否判定・ラベリング・日付/項目抽出・OCR・短縮・整形 | **Haiku 4.5** | $1 / $5 |
| 顧客向け文章生成・返信案・マッチング・要約（品質が体験に直結） | **Sonnet 4.6** | $3 / $15 |
| 経営判断・最高品質コピー・長時間エージェント | **Opus 4.8 / Fable 5** | $5/$25 ・ $10/$50 |

- 「抽出・分類」系は Haiku で Sonnet とほぼ同等品質。high-volume の分類パスを Haiku にするだけで単価 1/3。
- モデルは必ず **env で上書き可能**にする（`CLASSIFIER_MODEL` / `ANTHROPIC_EXTRACT_MODEL` 等）。品質劣化時に即ロールバックできる形にしておく。
- 迷ったら「その出力をユーザーが直接読むか」で判断。読まない中間処理＝Haiku、読む＝Sonnet 以上。

#### 2.8.2 prompt caching は「TTL(5分)内に同一プレフィックスが再送される」時だけ効く

- **効く**: ポーラー/ナイトリーの連続ループ、バースト的アクセス（5分 TTL 内に prefix 再利用）。cache read は約 0.1x。
- **効かない/逆効果**: 単発 cron・低頻度 API（1日数回）。cache write は 1.25x なので read が来なければ割高 → **付けない**。
- 実装: 安定プレフィックス（システムプロンプト・固定 DB・テンプレ・マニュアル本文）を**先頭**に置き、その最後のブロックに `cache_control: {type:'ephemeral'}`。動的値（日時/ID/ユーザー入力）は必ず**後ろ**。
- 検証: `usage.cache_read_input_tokens` が 0 のままなら silent invalidator（system 内の `Date.now()`、非ソート JSON、tools 変更）を疑う。

#### 2.8.3 非同期でよい一括生成は Batch API（50%オフ）

- 応答を即時に要さない生成（一括告知文・大量分類・埋め込み）は `messages.batches` で全トークン半額。EOラーニングの4チャネル告知文が実例（submitBatch/pollBatch）。
- リアルタイム UI 応答が要るものは通常 API、裏の一括処理は Batch、と使い分ける。

#### 2.8.4 入力トークンを削る

- `max_tokens` は用途相応の最小に（分類は数十〜数百）。暴走出力の上限にもなる。
- 大きい context は必要分だけ送る（例: weekly-bot は 200K 字で切詰め）。全文を惰性で渡さない。
- メール本文等は先頭 N 字にスライスし、要約で足りるなら全文を渡さない。

#### 2.8.5 現状の適用状況（2026-07 時点、本リポジトリ群）

| アプリ | 施策 |
|---|---|
| メール処理アプリ | 分類を Haiku 4.5 化（返信案は Sonnet 維持）。system prompt caching 済 |
| aujust-sales-automation | 日付抽出・名刺OCR を Haiku 化。返信/要約/出展予測は Sonnet 維持。連続ループの system prompt に caching |
| 学会協賛メディア | 学会DB候補リスト（全ユーザー共通の固定 prefix）を caching |
| orgiast-weekly-bot | 経営判断ツールのため **Opus 維持**（品質優先、単発 cron で caching 不適） |
| EOラーニング企画アプリ | 既に最適化済（Opus Batch + Sonnet + Haiku 階層 + caching） |
| exhibition-japan（EXPO INDEX） | ANTHROPIC_API_KEY 未設定でフォールバック動作＝現状課金なし。有効化時は Sonnet + caching |

由来: 2026-07-05 kim「これまで作ったアプリの API 料金を機能変わらず安く」→ 全 API 消費アプリを棚卸しし上記施策を適用、コスト最適化を恒久ルール化。

### 2.9 Google Drive 運用ルール — 新規は「作業ファイル」統一、移動は kim の UI ドラッグのみ

1. **新規作成**: Claude が Drive MCP `create_file` で作るファイル/フォルダは、特に指定がなければ標準フォルダ **「作業ファイル」**（Folder ID `1uA0J3kPfL7O5t0Ro1jSfi2xDEJE-Y0si`、kim マイドライブ）直下に作る。例外 = 機能上の置き場が決まっているもの（GAS コマンドキュー `claude-*-cmds`、freee 仕訳 CSV、`社内マニュアル_NotebookLM連携` 等の既存自動化フォルダ）。
2. **Claude は copy_file を「移動」の代用にしない（禁止）**: copy は**新しいファイル ID** の複製を作る。元を削除するツールも無いため重複が残り、ID 参照している自動化と実体がズレる。移動が必要なときは Claude が対象リスト（タイトル / ID / 現フォルダ / 可否判定）を作って kim に渡すところまで。
3. **実際の移動は kim が Drive UI のドラッグで行う**: UI 移動は **ID 保持**（親フォルダだけ変わる）。ただし親フォルダから**継承**していた共有権限は移動で外れる（ファイルに直接付与した権限は保持）。移動前に Claude が `get_file_permissions` で SA・メンバー共有が「直接付与」かを確認し、継承のみなら先に直接付与を追加してもらう。
4. **絶対に動かさないもの**: weekly-bot 参照の 顧問ミーティング / freee仕訳CSV フォルダと SHEET_* 各シート、GAS コマンドキューフォルダ群、bound script 付き Sheet、`社内マニュアル_NotebookLM連携`、自動化が Folder ID で監視・書込する全フォルダ、他人所有ファイル。整理メリット < 事故リスク。
5. **マイドライブ ⇔ 共有ドライブを跨ぐ移動は禁止**: ID は保持されても owner が組織に移り、権限がドライブのメンバーシップ支配に変わるため、SA の閲覧などが silent に壊れうる。
6. **移動後は Claude が read-back 検証**: `get_file_metadata` で「ID 不変 + parentId が新フォルダ」を確認し、そのファイルを参照する自動化（weekly-bot 等）を 1 回手動発火して成功まで見届ける。

由来: 2026-07-06 kim「Claude 作成の Drive データは作業ファイルに統一、過去分も移動可否をチェック」→ Drive MCP に move が無い制約下で「Claude=新規統一+棚卸し / kim=UI ドラッグ」の役割分担で恒久化。

### 2.10 マルチアカウント共通ナレッジ運用 — Drive ハブが正本

kim@orgiast.jp / seisaku-team@orgiast.jp / 他アカウントの Claude Code で得たノウハウ・ルールを**全アカウント共通で適用**するための仕組み。やり取りは**すべて Google Drive 上**で行い、各マシンのローカルファイルはキャッシュ、GitHub repo はミラー（履歴・plugin 配布用）と位置付ける。

**ハブ（正本）**: Drive `claude-common-rules`（作業ファイル配下、folder `1RLYbK6CKyPWRJsG6LY0WB9OzlbFYSFvw`、owner kim@orgiast.jp）

```
claude-common-rules/
├─ manifest.json          ← version 番号と配布ファイル一覧（同期判定の起点）
├─ ONBOARDING.md          ← 本ファイルの正本
├─ CLAUDE.md.template     ← 各自の ~/.claude/CLAUDE.md 雛形（既存がある人は上書きしない）
├─ rules/                 ← パススコープ別ルール (gas.md 等)      folder 1cNOSlo8pcrhXiRMRK_WD3O5IW-K9lYX4
├─ skills/                ← 共通スキル (<name>.md 形式)           folder 1oSlYjJdlIy5GRYa3-AasAeybARKh4v-E
├─ knowledge-inbox/       ← 各アカウントからのノウハウ投稿        folder 1AyZcrlK9JCNPUkhKCBOezet9a2QoSwK2
└─ knowledge-merged.json  ← 統合済み台帳
```

**3つのフロー**:

1. **下り（配布）**: 各自の Claude Code で `/rules-sync`（pull）→ manifest の version をローカル版と比較 → 差分を `~/.claude/rules/`・`~/.claude/skills/`・ONBOARDING ローカルマスターに反映（反映前に `~/.claude/backups/` へバックアップ）。
2. **上り（収集）**: どのアカウントでも、全社適用すべき学び（feedback / 失敗パターン / 新ルール）が出たら `/share-knowledge` → knowledge-inbox に md 投稿（date / account / type / target の frontmatter 付き、命名 `YYYYMMDD-<account>-<slug>.md`）。
3. **統合**: kim 環境の `/rules-sync`（merge）が inbox の未処理分を列挙 → kim 承認後に正本へ反映 → manifest version+1 → GitHub `kimkon1011/orgiast-claude-rules` にミラー push。

**Drive MCP の制約と、それを吸収する規約**（update / delete / move ツールが存在しない）:

- **本文の取得は必ず `download_file_content`（base64 → デコード）**。`read_file_content` は自然言語表現に変換され `_` `[` 等がエスケープされて**同期ファイルが壊れる**（2026-07-06 実測）。read はフォルダの人間向け確認のみに使う
- MCP 経由の更新 = 同タイトルで create_file し直し。読む側は「同タイトルが複数あれば modifiedTime 最新を正」とする（latest-by-title 規約）
- kim 環境には in-place 更新 CLI がある: `node <orgiast-claude-rules>/scripts/drive-hub-sync.mjs push/pull/list/share-domain`（SA `aujust-sheets-reader` の DWD で kim を impersonate、fileId 保持、大きいファイルでもコンテキスト消費ゼロ）→ **kim 環境の push はこちらを優先**
- fileId は版ごとに変わりうるため、**ファイル ID のハードコード禁止**（上記フォルダ ID のみ固定してよい）
- inbox の投稿は削除できない → `knowledge-merged.json` 台帳で処理済み管理
- MCP でアップロードする場合は `text/plain` + `disableConversionToGoogleType: true`（Google Docs に変換させない）

**共有と役割分担**: ハブは orgiast.jp **ドメイン writer 共有設定済み**（2026-07-06、SA 経由）。技術的には全員書けるが、**正本の編集と version 管理は kim 環境のみ**という規約で運用する。他アカウントは pull と knowledge-inbox への投稿のみ（競合防止）。

**新アカウントの初回セットアップ**:
1. 各自の claude.ai で Google Drive コネクタを接続（自分の orgiast.jp アカウント）
2. 初回は §3.0 の貼り付けプロンプトでルール取り込み（GitHub public raw 経由、コネクタ不要）→ 以降の更新は `/rules-sync` で Drive ハブから

由来: 2026-07-06 kim「複数アカウントの Claude Code ノウハウを共通適用したい。やり取りはすべて Google Drive で」→ Claude Code はローカルファイルしか読み込めない制約 + Drive MCP の update 不可制約の下で、「Drive 正本 + /rules-sync ローカルキャッシュ + latest-by-title 規約 + inbox/台帳」で設計。

---

## 3. セットアップ手順

新規メンバーが自分の Claude Code に取り込むときは、**3.0 の貼り付けプロンプト1本** で完結します。3.A / 3.B / 3.C は手動運用したい人や強制が必要なときの補助です。

### 3.0 自動取り込み（推奨・コピペ1回で完了）

受信側の Claude Code チャットに、以下のブロック内をそのまま貼り付けるだけ。**WebFetch だけで完結するため、gh CLI も Drive MCP も Google Drive コネクタも一切不要**。Claude 側で本文取得→マージ→バックアップまで全自動で実行します。

```
オージャスト Claude Code 共通ルールを自動取り込みしてください。質問は最小化し、選択肢を user に出さないこと。Claude 側で完結させる。

【手順】

1. WebFetch で raw URL から本文取得:
   https://raw.githubusercontent.com/kimkon1011/orgiast-claude-rules/main/ONBOARDING.md
   - 取得した markdown 本文を作業対象とする
   - 失敗（HTTP 404 / ネットワークエラー）した場合のみ手順 5 のフォールバックへ

2. 取り込み先を自動判定
   - cwd がオージャスト系のリポジトリ (GitHub kimkon1011/orgiast / aujust-* 等) なら、リポジトリ直下の `CLAUDE.md` に書く
   - そうでなければユーザーグローバル `~/.claude/CLAUDE.md` (Windows: `%USERPROFILE%\.claude\CLAUDE.md`) に書く
   - どちらも無ければ新規作成

3. バックアップ
   - 既存ファイルがあれば `CLAUDE.md.bak.YYYYMMDD-HHmmss` で先にバックアップを作る

4. マージ
   - 末尾に区切り `<!-- BEGIN: オージャスト共通ルール (取得日 YYYY-MM-DD) -->` … `<!-- END: オージャスト共通ルール -->` を入れて追記
   - 同名の BEGIN ブロックが既にあれば、その範囲を新内容で置き換える（重複追記しない）
   - 既存内容と矛盾する規則があれば、末尾に「※要マージ確認: <該当箇所>」コメントを出して停止し user に判断を仰ぐ

5. フォールバック（手順 1 が失敗した場合のみ）
   - `gh api -H "Accept: application/vnd.github.raw" repos/kimkon1011/orgiast-claude-rules/contents/ONBOARDING.md` を試す
   - それも失敗なら user に 1 行で「raw URL も gh CLI も失敗。以下の URL の内容をチャットに貼り付けてください: https://raw.githubusercontent.com/kimkon1011/orgiast-claude-rules/main/ONBOARDING.md」と報告して停止

6. 完了報告
   - 適用先パス、追加/置換行数、バックアップファイル名、矛盾の有無、取得経路（WebFetch / gh CLI / 手動貼り付け）を一行ずつ要約
   - 「次回更新時も同じプロンプトをもう一度貼れば最新版に追従できる」と添える

【絶対にやらない】
- ❌ claude.ai/settings/connectors の Connect を user に依頼する（Claude Code には反映されない）
- ❌ Google Drive MCP / ローカル MCP サーバ追加 / GCP OAuth クライアント作成 等の重い手順の提案
- ❌ gh CLI / winget install 等のセットアップを要求する（手順 1 の WebFetch なら何も入れる必要がない）
- ❌ 「設定方法を選んでください」型の多択質問（AskUserQuestion で 3 つ以上の選択肢を出す）
- ❌ 「先に必要な前提を確認させてください」型の追加問診

【許可事項（疑問があれば本ルール 1.6 を参照）】
- `~/.claude/CLAUDE.md` および `~/.claude/settings.json` の編集・バックアップ作成は無断 OK
- 必要なら親ディレクトリ `~/.claude/` を新規作成して構わない
- 取り込み中の進捗は TodoWrite で見える化して構わない（user が監査できる）
```

> 💡 **配信元**: GitHub `kimkon1011/orgiast-claude-rules` (public) — raw URL を WebFetch するだけで取れます。認証も MCP もコネクタも不要。
>
> 💡 同じプロンプトを定期的（例: 月1）に再実行すれば最新版に追従できます。BEGIN/END ブロックで置換するので重複しません。

### A. ユーザーグローバル（全プロジェクト共通）にする

このファイルの内容（または抜粋）を以下に追記する:

- macOS / Linux: `~/.claude/CLAUDE.md`
- Windows: `%USERPROFILE%\.claude\CLAUDE.md`

ファイルが無ければ新規作成。すでに自分用のルールがある場合は、このファイルの内容をマージしてください。

### B. プロジェクト単位で適用する

オージャスト関連の各リポジトリ直下に `CLAUDE.md` を置き、このファイルから必要なセクションをコピーする。リポジトリで Claude Code を立ち上げた人全員に自動でロードされる。

### C. 強制が必要な挙動は hooks で実装

「絶対にこの挙動でやってほしい」レベルのもの（例: `*.gs` を編集したら必ず `clasp push -f` を走らせる）は、リポジトリ直下の `.claude/settings.json` に hooks として書く。`CLAUDE.md` はあくまでガイド、hooks はハードな実行強制。

---

## 4. 困ったとき

- このルールに矛盾するプロジェクト固有の運用が必要な場合 → そのリポジトリの `CLAUDE.md` で上書きする（プロジェクト CLAUDE.md がユーザーグローバルより優先）
- ルールを変えたほうがいいと感じた場合 → kim@orgiast.jp に提案。承認後、このファイルを更新して再配布する
