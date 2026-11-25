# gemini-api CLI の全PC配布

## 何を・どこへ・なぜ

`tools/install-gemini-api-cli.mjs` が公式リリースのSHA-256を検証し、Windowsは `%LOCALAPPDATA%\Programs\gemini-api\`、Linux/macOSは `~/.local/bin` へ導入する。既存の `~/.gemini/.env` のキーをOSキーチェーンへ安全に保存し、画像生成、PDF・画像・動画・音声の読解、文字起こし、Deep ResearchをClaude枠から安いGeminiへ振り分ける。新しいキーや契約は作らない。

## 確認

- `~/.claude/.gemini-api-cli-installed.json`: `ok`, `version`, `onPath`, `keyStored`, `skill`, `dryRun`, `errors` を確認する。キー値は保存されない。
- `gemini-api whoami`: マスク済み資格情報と採用された保存元を確認する。
- `node tools/install-gemini-api-cli.mjs --json`: 24時間ごとの更新確認、導入、オフライン検証結果をJSONで表示する。
- 実API確認は課金を伴うため、明示時だけ `--live-check` を追加する。

## 解除

1. `gemini-api auth logout` で保存済み資格情報を削除する。
2. Windowsは `%LOCALAPPDATA%\Programs\gemini-api\`、Linux/macOSは `~/.local/bin/gemini-api` を削除する。
3. Windowsのユーザー環境変数 `Path` から導入先だけを除去する。
4. `~/.claude/.gemini-api-cli-installed.json` を削除する。
