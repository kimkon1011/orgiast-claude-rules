---
paths:
  - "**/*.gs"
  - "**/appsscript.json"
  - "**/.clasp.json"
---

# GAS 開発ルール（orgiast 全プロジェクト共通・絶対ルール）

## 1. clasp 統一
手作業コピペ禁止。反映は必ず `clasp push -f`。共有作業ツリーから直接 push せず、`node C:/Users/uers/Downloads/orgiast-claude-rules/tools/gas-overlay-push.mjs --project <repo> --files <変更ファイル>` を使う（本番pull→変更ファイルだけ重ね→差分表示→push→read-back。他セッションの古いファイルで本番を巻き戻さないため。kim 承認 2026-09-29）。既存プロジェクトを触る時も `.clasp.json` を置いて統一。push 後に time-based トリガーは**古いコードで動き続ける**ので、トリガー再作成（Web App `?cmd=setup` 再踏み or setupOnce 再実行）+ `clasp deploy --deploymentId <ID>` で同一 URL を最新化。

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

## 5. google.script.run の数値表示は正規化する
クライアントで受信値を `v === null` だけで分岐しない。`google.script.run` の成功コールバックでサーバの `null` が `undefined` になる経路を前提に、数値表示は `null` / `undefined` / `""` / NaN / Infinity を次の `num()` で `null` に畳んでから分岐する。

```js
function num(v) {
  if (v === null || v === undefined || v === "") return null;
  var n = Number(v);
  return isFinite(n) ? n : null;
}
// 表示側: var x = num(row.attendees); el.textContent = (x === null) ? "—" : x + "人";
```

`Number()` を通す表示を重点的に確認する。文字列は `String(v ?? "")` 相当のエスケープ関数を通す。jsdom検証では実データfixtureのnullプロパティを再帰的に削除して再描画し、出力に `NaN` が含まれたら失敗させる。

```js
function dropNulls(o) {
  if (Array.isArray(o)) return o.map(dropNulls);
  if (o && typeof o === "object") {
    var r = {};
    for (var k in o) if (o[k] !== null) r[k] = dropNulls(o[k]);
    return r;
  }
  return o;
}
// 描画後: if (/NaN/.test(document.querySelector("#app").textContent)) process.exit(1);
```

**実害（2026-09-02）**: 在庫管理アプリで「実績 NaN個 / 予定比 NaN%」「NaN人」が表示された。Driveコマンドキューの `JSON.stringify` 経路ではnullが保たれ、単体テストや未加工fixtureでは再現しなかった。1件直したら同種を機械的に探す検証まで入れる。

## 6. ハイフン入りidは明示的に要素を取得する
`id="forecast-preview"` は `window["forecast-preview"]` であり、camelCaseの `forecastPreview` にはならない。**ハイフン入りidは必ず `document.querySelector("#forecast-preview")` 等で取得**し、暗黙のグローバル変数参照に頼らない。

- 画面変更後はブラウザ相当の環境で描画・操作を検証する。GASなら `Index.html` + `Style.html` + `Script.html` を連結してjsdomへ読み込み、実データを流して主要導線を操作する。`npm run render-check` 等の1コマンドにし、変更のたびに実行する。実ブラウザ確認もONBOARDING §1.4に従う。
- jsdomの `virtualConsole` で `jsdomError` と `console.error` を拾い、1件でもあればexit 1にする。単体テストpass・API正常・データ一致だけで画面が動くと判断せず、Claude側で検証を完結する。

**実害（2026-09-01）**: プレビュー更新の `forecastPreview.textContent = ...` が入力のたびにReferenceErrorになり、後続の追加ボタン有効化へ到達しなかった。単体テスト6ファイルと58件のデータ検証はすべて正常でも、既定の操作導線は使えなかった。
