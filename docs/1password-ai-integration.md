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

## 通知を出さずに設定を確かめる（Windows）

金さんに「Windows Hello」や「1Password CLI と連携」をオンにするよう依頼する前に、この手順で現状を確認する。`op` コマンド（`op account list` / `op vault list` / `op signin` など）は使わない。アプリ連携がオンだと、これらは Windows Hello の確認を画面に出す。確認を省略して未確認のまま依頼に回すことも禁止する。

確認先（000 で 2026-11-18 実測。値は出さずキー名だけ先に確認し、該当する真偽値だけ読む。`authTags` など他の値は表示しない）:

- ファイル: `%LOCALAPPDATA%\1Password\settings\settings.json`
- 形式: ネストではなく、ドット付きのキー名がフラットに並ぶ（例: `"developers.cliSharedLockState.enabled": true`）

| アプリの設定 | キー | true の意味 |
|---|---|---|
| 設定 > セキュリティ > Windows Hello | `security.authenticatedUnlock.enabled` | オン（補助確認: `security.authenticatedUnlock.deviceBasedUnlock` と `security.authenticatedUnlock.useHardware`） |
| 設定 > 開発者 > 1Password CLIと連携 | `developers.cliSharedLockState.enabled` | オン |
| 開発者向け MCP 連携 | `developers.mcpIntegration.enabled` | オン |

PowerShell 例（既知の真偽値だけ出力する。`authTags` は出さない）:

```powershell
$p = "$env:LOCALAPPDATA\1Password\settings\settings.json"
$h = Get-Content -Raw -Path $p | ConvertFrom-Json -AsHashtable
@(
  'security.authenticatedUnlock.enabled',
  'security.authenticatedUnlock.deviceBasedUnlock',
  'security.authenticatedUnlock.useHardware',
  'developers.cliSharedLockState.enabled',
  'developers.mcpIntegration.enabled'
) | ForEach-Object { "$_=$($h[$_])" }
```

判断:

- 該当キーが `True` なら、その設定の依頼は出さない。確認結果だけ報告する。
- `False` またはキーが無いときだけ、オンにする依頼を出してよい。確認結果を依頼文に書く。
- ファイルが読めないなど、どうしても確かめられないときは「未確認」と明記し、「すでにオンなら何もしなくてよい」と書いたうえで、この節の手順も一緒に出す。

2026-11-18 の 000 では、上記の手順だけで Windows Hello を出さずに、Windows Hello と CLI 連携がすでにオンだと確認できた。

## 金さんに頼む前の確認（通知が出ない方法で必ず先に確認する）

- デスクトップアプリの設定は `%LOCALAPPDATA%\1Password\settings\settings.json` を読む。値の表示はしない。キー名と真偽だけ見る。
  - Windows Hello: `security.authenticatedUnlock.enabled`
  - CLI連携: `developers.cliSharedLockState.enabled`
  - MCP連携: `developers.mcpIntegration.enabled`
- `op` コマンドはそれ自体が Windows Hello の確認を金さんの画面に出す。確認目的で `op` を叩かない。
- 「未確認」の項目を金さんへのボタン一覧に入れない。確認できないなら、確認できない理由を書く。

## Windows Hello を出す作業の決まり

- 事前に金さんへ「いつ・何回・何のために出るか」を伝え、在席を確かめてから始める。
- 最初の1回（`op whoami`）が失敗・タイムアウトしたら、その場で全体を中止する。後続の `op` を続けて呼ばない（呼ぶたびに確認が出る）。
- 2026-11-18 18:21〜18:26 JST、この決まりがなかったため確認が約5回出て全てタイムアウトした（取り込みは0件）。
