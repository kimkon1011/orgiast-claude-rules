---
paths:
  - "**/*.gs"
  - "**/appsscript.json"
  - "**/.clasp.json"
---

# GAS 開発ルール（orgiast 全プロジェクト共通・絶対ルール）

## 1. clasp 統一
手作業コピペ禁止。反映は必ず `clasp push -f`。既存プロジェクトを触る時も `.clasp.json` を置いて統一。push 後に time-based トリガーは**古いコードで動き続ける**ので、トリガー再作成（Web App `?cmd=setup` 再踏み or setupOnce 再実行）+ `clasp deploy --deploymentId <ID>` で同一 URL を最新化。

## 2. コマンドキュー方式（省略禁止・retrofit 禁止）
Workspace ポリシーで `clasp run-function` と ANYONE_ANONYMOUS Web App が使えないため、**最初の clasp push に必ず組み込む**:

1. `Setup.gs` に `setupOnce()` を **1つだけ**（kim が ▶実行するのはこれのみ。プロジェクト固有初期化 + `installCommandQueue()` を内包。2クリック構成は禁止）
2. `_COMMANDS_()` ホワイトリスト（関数名→関数オブジェクトの map。`eval`/`this[name]()` 禁止）
3. `installCommandQueue()`: `claude-<project>-cmds` フォルダ作成 → folder ID を Script Property `CMD_FOLDER_ID` に保存 → 1分トリガー設置
4. `processCommandQueue()`: `cmd_*.json` を読みホワイトリスト関数のみ実行 → `result_<id>.txt` 書き戻し → cmd は setTrashed。**LockService.tryLock(0) + payload 読込直後の setTrashed** で並走二重実行を防止
5. `appsscript.json` oauthScopes: 最低 `spreadsheets`, `drive`, `script.scriptapp`（外部APIなら `script.external_request`）

Claude 側運用: Drive MCP `create_file` で `cmd_<unique>.json`（`{"command":"syncAll","args":[]}`、text/plain + disableConversionToGoogleType）→ 1分以内に実行 → `read_file_content` で `result_*.txt` を読む。

禁止: 1分未満のトリガー間隔 / フォルダのリンク共有 / 機密値をコマンドに入れる（Script Properties から読む）/ `installTriggers` 系での無条件 `getProjectTriggers().forEach(delete)`（キューのトリガーを巻き添えにする — handlerFunction 名でフィルタ必須）。

## 3. 書き込みは read-back verify 必須
`setValue`/`setFormula` は merge セルの non-top-left / protected range / データ検証違反で **silent ignore**。書いたら `SpreadsheetApp.flush()` → `getValue()` で実値 assert。数式が `#REF!`/`#NUM!` のまま残るなら `getFormulas→setFormulas` で強制再評価。

## 4. URL 提示
GAS エディタリンクは必ず `https://script.google.com/a/orgiast.jp/d/{SCRIPT_ID}/edit` 形式（素URL禁止、詳細は ~/.claude/CLAUDE.md）。

詳細テンプレ: memory `feedback_gas_command_queue.md` / ONBOARDING §1.4.1。新規立ち上げ手順は `/gas-project-setup` skill。
