<!-- lane: codex -->
# 目的
orgiast-claude-rules（cwd=このリポジトリ）に Discord 取込 GHA workflow `discord-capture.yml` を作成する。
PR #219（aujust-sales-automation）の Discord ingest API 向け外部ポーリング機構。

# 制約
- cwd 外に worktree/ディレクトリを作らない
- main へ push しない・force push しない・ブランチ削除しない・ファイル削除しない・自動マージしない
- Claude API（@anthropic-ai/sdk・api.anthropic.com・claude-*）をアプリから呼ばない
- 外部送信・課金・権限変更（secrets の set 含む）はしない
- detached HEAD なら feat/discord-capture-yml ブランチを cwd 内で切って作業する（push はしてよいが main 以外）

# 背景（事実）
- Discord ingest API（PR #219 OPEN）: POST /api/external/discord-ingest
  - Auth: Authorization: Bearer CRON_SECRET
  - Body: { messages: [{ channel_id, external_message_id: "discord:{channelId}:{messageId}", sender_identifier, sender_display_name, subject?, body, received_at, attachments? }] }
  - max 200 messages / request
- Vercel は Gateway WebSocket 不可のため GHA ポーリングが必要
- このリポの secrets 既存: DISCORD_BOT_TOKEN（あり）。APP_URL / CRON_SECRET は未登録 → workflow コメントで必須 secrets を明記するだけ（gh secret set は禁止）
- 参考: .github/workflows/fleet-triage.yml（checkout + node tools/...）
- 既存 fetch: tools/discord-digest.mjs の fetchMessages（再利用可）

# 作るもの
1. `.github/workflows/discord-capture.yml`
   - schedule: 15分ごと（*/15）+ workflow_dispatch
   - concurrency group: discord-capture / cancel-in-progress: false
   - permissions: contents: read
   - jobs: ubuntu-latest, timeout 10分
   - steps: checkout → setup-node 24 → `node tools/discord-capture.mjs`
   - env: DISCORD_BOT_TOKEN, APP_URL, CRON_SECRET, DISCORD_CAPTURE_CHANNEL_IDS（カンマ区切り）
   - 先頭コメントで必須 secrets と APP_URL 既定値例 https://aujust-sales-automation.vercel.app を書く
   - Claude API を呼ばない

2. `tools/discord-capture.mjs`
   - DISCORD_CAPTURE_CHANNEL_IDS を分割して各チャンネルから直近メッセージ取得（fetchMessages 再利用）
   - since: 環境変数 DISCORD_CAPTURE_LOOKBACK_HOURS（既定 2）または state ファイルがあれば増分
   - Discord 生メッセージを ingest API 形式へ変換
   - APP_URL/api/external/discord-ingest へ POST（Bearer CRON_SECRET）
   - dry-run: --dry-run なら POST せず変換結果の件数を JSON で stdout
   - チャンネル未設定・token/url/secret 欠落時は exit 0 で「skip: reason」を出し失敗にしない（secrets 未投入でも workflow 緑）
   - Claude API 不使用

3. `tools/discord-capture.test.mjs`（node:test）
   - 変換関数の単体テスト（external_message_id 形式・attachments・空 body スキップ）
   - fetch/POST はモック

# 完了条件（読み戻し必須）
- 上記3ファイルが cwd 内に存在
- `node --test tools/discord-capture.test.mjs` が exit 0
- `node tools/discord-capture.mjs --dry-run` が secrets なしでも exit 0（skip メッセージ）
- YAML が読めること
- 変更を feat/discord-capture-yml に commit（なぜを書く）
- push は feat ブランチのみ可。PR 作成は任意（マージ禁止）

# 禁止
- aujust-sales-automation リポの編集
- secrets の登録
- main push / merge
