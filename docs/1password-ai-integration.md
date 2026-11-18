aliases: [1Password, op, ワンパスワード, サービスアカウント, op run, op://, 鍵管理, APIキー]

# 1Password × 全AI 連携（下書き 2026-11-18）

秘密の値（パスワード・トークン・APIキー）は、チャット・ログ・コマンド引数・リポジトリ・AIの会話に一切出さない。AIが扱うのは `op://<保管庫>/<アイテム>/<フィールド>` という「参照」だけ。値は実行の瞬間に 1Password から子プロセスへ直接渡る。

## 方式の使い分け（公式ドキュメント準拠）

| 用途 | 方式 | Windows | 個人版 | 出典 |
|---|---|---|---|---|
| 夜間・定期タスク（無人） | サービスアカウント + `op run` / `op read` | ○ | ○（1,000回/日・アカウント全体、読取1,000回/時・トークン） | https://www.1password.dev/service-accounts/rate-limits |
| 金さんが手で使うターミナル | デスクトップアプリ連携（Windows Hello） | ○ | ○ | https://www.1password.dev/cli/app-integration |
| Claude Code / Codex / Cursor のMCP（Environments） | `1password-mcp` | ×（Mac/Linuxのみ） | ○ | https://www.1password.dev/environments/cursor-plugin |
| シェルプラグイン（`op plugin init claude/codex`） | bash/zsh/fish | ×（PowerShell非対応） | ○ | https://www.1password.dev/cli/shell-plugins |
| ブラウザで代わりにログインするAI（グロボ、Muse） | 1Password for Agents | ○ | ○（個人・ファミリーのみ） | https://support.1password.com/1password-for-agents/ |
| ChatGPT（Work / dots） | 1Password for Agents | 未提供（coming soon） | — | https://1password.com/blog/1password-for-ai-agents |

## 保管庫の決まり

- 保管庫名: `AI-Keys`（サービスアカウントは既定の Personal/Private 保管庫を読めないため専用保管庫が必須）。
- アイテム名 = 用途、フィールド名 = 環境変数名。例: `op://AI-Keys/openrouter/OPENROUTER_API_KEY`、`op://AI-Keys/gemini/GEMINI_API_KEY`。
- サービスアカウント `ai-fleet-read` は `AI-Keys` の読み取り専用。書き込み・他保管庫は付けない。

## .env の書き方（値ではなく参照を書く）

```dotenv
OPENROUTER_API_KEY=op://AI-Keys/openrouter/OPENROUTER_API_KEY
GEMINI_API_KEY=op://AI-Keys/gemini/GEMINI_API_KEY
```

実行は `op run --env-file .env -- <コマンド>`。`op run` は出力に値が出ると自動で伏字にする。

## 各PCでの起動（無人タスク）

サービスアカウントのトークンは既存の keyserve 経路（`tools/onboarding-sync.mjs`）で各PCの `~/.claude/keyserve.env` 相当に配る。チャット・Discord・引数には出さない。タスクは次の形にする。

```powershell
op run --env-file "$HOME\gb-offload\ai.env" -- claude -p ...
```

## 禁止

- `op read` / `op item get --reveal` の結果を画面・ログ・チャットに出す。
- 値を `.env` / `settings.json` / `mcpServers.env` に直書きする。
- サービスアカウントに書き込み権限や Personal 保管庫を付ける。

## 移行の順番

1. AI-Keys 保管庫とサービスアカウントを作る（金さん、1回）。
2. 000 で平文 `.env` の値を AI-Keys に取り込む（op CLI、ローカル完結。値は表示しない）。
3. 取り込んだ `.env` を `op://` 参照に置き換え、元ファイルは `.bak` に退避（削除は金さん承認後）。
4. 取り込んだ鍵は発行元でローテーションする（公式推奨。平文時代の露出は消えないため）。
