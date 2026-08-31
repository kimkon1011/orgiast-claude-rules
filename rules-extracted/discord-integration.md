# Discord Application 命名・共有 MCP コネクタ 詳細

ONBOARDING.compressed.md §2.5 / §2.6 の詳細。

## 2.5 Discord Application 名の禁止語

Discord Developer Portal（`https://discord.com/developers/applications`）で新規 Application を作る案内をするときは、名前に以下を含めない:

1. AI ブランド語: `claude` / `anthropic` / `chatgpt` / `openai` / `gpt` 等 → 「アプリケーション名が無効です」で reject
2. `discord` 自体: → 「申込み名に「discord」を含めることはできません」で reject

Discord は (a) 主要 AI サービスの impersonation と (b) Discord 自身の impersonation を両方禁じている。kim の Portal に残る `ClaudeInboxBridge` は禁止強化前の遺物で、現時点では新規作成不可。

第一候補として案内すべき命名パターン:
- `clawd-...` — 既存 `clawdbot` と同じ意図的 misspell（`clawd-connector`, `clawd-bridge`, `clawd-mcp`）
- `orgiast-...` — organization prefix（`orgiast-mcp-bridge`, `orgiast-chat-bot`）
- `kim-...` — owner prefix（`kim-mcp-bridge`）
- `<purpose>-bridge` / `<purpose>-connector` — 中立な機能名（`chat-bridge`, `mcp-connector`）

⚠ Vercel project 名 / GitHub repo 名 / README 内の表記には `claude` や `discord` を含めても問題ない（Discord 側を介さない）。Discord Application 名にだけ この制約を適用する。

## 2.6 Discord 操作は共有 MCP コネクタを使う

オージャストには `discord-mcp-connector` という共有 MCP サーバが稼働中（Vercel デプロイ、kim 管理）。orgiast guild の全 channel 読み書き / メンバー一覧 / リアクション / ファイル添付など 16 tools を提供。Discord に何かしたい時はこのコネクタを 必ず 使う（自前で Bot を立てない、`discord.py` などをローカルで動かさない）。

コネクタ情報:

| 項目 | 値 |
|---|---|
| URL | `https://discord-mcp-connector.vercel.app/api/mcp` |
| 認証方式 | OAuth 2.1 + Dynamic Client Registration（自動） |
| 承認 password | `797099a090a6b88bc69cfe8bfdabd87347f4c52668486685bdc6c2cebe858c9d` |
| Discord Bot | `clawd-connector`（orgiast guild に追加済み） |
| 提供 tools | send_message / reply_message / send_dm / list_messages / search_messages / list_guilds / list_channels / get_channel / list_members / search_members / get_member / add_reaction / remove_reaction / upload_attachment / list_dms（要 user token）/ read_dm（要 user token） |

⚠ 承認 password は orgiast 内部限定の共有 secret です。社外（外注スタッフ・外部レビュアー・公開リポジトリ）に絶対漏らさないこと。漏れた場合は kim@orgiast.jp に即連絡 → ローテーション対応。

### Claude Code (CLI) からの使い方

PowerShell で以下を 1 回実行（user スコープなので全プロジェクト共通で使える）:

```pwsh
claude mcp add -s user --transport http discord https://discord-mcp-connector.vercel.app/api/mcp
```

初回 tool 使用時にブラウザが開いて承認ページに飛ぶので、上の 承認 password を貼って Approve。以降は OAuth refresh で自動継続（30 日サイクル）。

確認:
```pwsh
claude mcp list
# → discord が "✓ Connected" になっていれば OK
```

### Claude.ai（Web / Desktop）からの使い方

1. https://claude.ai/customize/connectors を開く
2. カスタムコネクタを追加 → 名前 `Discord`、URL `https://discord-mcp-connector.vercel.app/api/mcp` のみ入力 → 追加
3. 自動で承認ページにジャンプ → 承認 password を貼って Approve
4. 接続完了。プロジェクト（オージャストに質問など）の「チャット」スロットでこのコネクタを選べる

### よくある質問

- Q: Bot 経由のメッセージ送信は誰の発言として記録される？ A: `clawd-connector` Bot として残ります（orgiast guild の audit log）。誰が呼んだかは Discord 側からは見えないので、業務上重要な投稿は本人アカウントで二次共有してください。
- Q: 自分の個人 DM を読み取れる？ A: 現状は NO（user token 未設定のため）。要件があれば kim に相談 → ToS リスクを承知の上で個別追加。
- Q: 新しい tool が欲しい A: kim に相談、または `c:\Users\uers\Downloads\CLAUDE.md配布\discord-mcp-connector\lib\tools\` 配下に追加して PR / push。

## 2.6.1 Discord のチャンネルIDは user に聞かない（絶対ルール / 2026-08-31 kim 指示）

kim 指示:「**ほかのアカウントのパソコンもすべて、今後はこの Discord からチャンネルIDをひっぱってきて、ユーザーに取得させないようにして**」。

チャンネルID が必要になったら、**user に「開発者モードでIDをコピーして貼って」と依頼してはならない**。次の順で自動取得する:

1. `node ~/orgiast-claude-rules/tools/discord-channel-id.mjs "<チャンネル名の一部>"`
   （クラウド台帳の `Discordチャンネル` タブを引く。全PCで動く＝Bot トークン不要）
2. 候補が複数出たら **user には「どれ？」とだけ聞く**（IDを調べさせるのではなく、名前で選ばせる）
3. 台帳に無い新設チャンネルは kim 機の夜間バッチが翌朝までに載せる。急ぐなら `--refresh`（Bot トークンを持つPCのみ有効）

台帳: https://docs.google.com/a/orgiast.jp/spreadsheets/d/1soai_gMbH0C-67J8680Y26Y7KJWkV87sFZxCgDQ2BbI/edit
（`Discordチャンネル` タブ。`用途・何のチャンネルか【手入力】` 等の【手入力】列は人が自由に書ける欄で、機械は上書きしない）
