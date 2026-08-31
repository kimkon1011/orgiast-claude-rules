# GAS（Google Apps Script）clasp運用・コマンドキュー詳細

ONBOARDING.compressed.md §1.3 / §1.4 / §1.4.1 / §1.4.2 / §1.4.3 の詳細。

## 1.3 GAS（Google Apps Script）は clasp + GitHub 統一

Google Apps Script のコードは Apps Script Web エディタに直接書かない。すべての GAS プロジェクトで以下を守る:

- ソースは GitHub リポジトリで管理
- `.clasp.json` をリポジトリ直下に置き、Claude が `clasp push -f` で Apps Script に反映する
- 新規 GAS プロジェクトを作るときも、既存プロジェクトを触るときも、最初に `.clasp.json` を整備して clasp フローに乗せる
- 手作業コピペは禁止。GitHub の履歴と Apps Script の実体を必ず一致させる
- Web App としてデプロイしている GAS は、再デプロイまで Claude が完結させる:
  - `clasp deploy --deploymentId <既存ID> --description "..."` で 既存 deploymentId を再利用（URL を維持したまま最新コードに切替）
  - 既存 deploymentId は `clasp deployments` で確認
  - 新規 deploy を作ると URL が変わって Next.js 等の env 更新が必要になるため避ける
  - 「Apps Script エディタを開いて保存→再デプロイしてください」案内は禁止

GitHub に push → Claude が `clasp push -f` で Apps Script に同期 → 必要なら `clasp deploy --deploymentId` で Web App 再デプロイ、までを Claude が一連で実行する。

### bound script（スプレッドシート添付スクリプト）の scriptId 発見手順

`clasp list` には bound script が出ないことが多い。scriptId が分からないときの探し方:

1. リポジトリ内に既存の `.clasp.json` があればそれを使う
2. `clasp list --noShorten | grep <キーワード>` でスタンドアロンスクリプトを検索
3. Drive MCP で `mimeType = 'application/vnd.google-apps.script' and modifiedTime > '<対象スプレッドシート作成直後>' and owner = 'me'` を実行 → スプレッドシート作成直後に生まれた「無題のプロジェクト」が bound script の候補
4. `clasp pull -f` で内容を取得し、関数名・コメントで目的のスクリプトか同定
5. ここまで尽くしても見つからない場合のみ、ユーザーに 1 度だけ URL コピーを依頼

## 1.4 GAS の実行を Claude 側で完結させる（重要な落とし穴）

`clasp push -f` まで自動でも、関数の実行が自動化されないと「Web エディタを開いて ▶ 実行を押してください」案内が何度も発生する。これを最小化するルール:

まず試すアプローチ（多くの場合これで十分）:

ユーザーに一度だけ Apps Script Web エディタで対象関数を ▶ 実行してもらう。初回実行時の OAuth 同意で SpreadsheetApp / DriveApp 等の権限が付与され、以降は time-based トリガー や 編集トリガー をスクリプト自身が作成すれば、その後 Claude 側のオペレーションは全部自動で回せる。

ポイント:
- スクリプト内で `ScriptApp.newTrigger('fn').timeBased().after(N).create()` を使えば、Claude が「次の処理を実行したい」タイミングで Apps Script 側にトリガーを仕込める
- 1回目の Run でこのトリガー設定関数まで走らせておけば、以降は人手なしで何度でも実行できる
- 結果は別ファイル（dump 用スプレッドシート or Google Doc）に書き出して Drive MCP `read_file_content` で読み戻す

やってはいけない:

- `clasp login --use-project-scopes --include-clasp-scopes` で広いスコープに再認可させようとする → Workspace（orgiast.jp）のセキュリティポリシーで clasp の標準 OAuth クライアントはブロックされる（「このアプリはブロックされます」エラー）
- 自前 GCP プロジェクトで OAuth クライアントを作る案 → 設定コストが高く、結局 OAuth 同意は要るので得しない
- `__claude_inspect` のような巨大な dump を 同じスプレッドシート内 に作る → Drive MCP `read_file_content` は文字数制限でレンダリングが切り捨てられ、肝心の dump が読めない。dump は必ず 別ファイル に出す

まとめ:

「1回 Run を押してください」までは許容。「2回目以降も毎回 Run を押してください」になっていたら設計が間違っている → トリガー or 別ファイル経由に組み直す。

## 1.4.1 Drive コマンドキュー方式は 全 GAS プロジェクト必須 (絶対ルール、2026-06-11 強化)

新規 GAS プロジェクト立ち上げ時、コマンドキュー方式を必ず組み込む。「事後で組み込む」「優先度低い」は禁止。プロジェクトの最初の clasp push に含めること。

仕組み:
- スクリプト側に 1分ごとの time-based トリガー を仕込み、専用 Drive フォルダの `cmd_*.json` を見張る
- Claude が Drive MCP で `cmd_*.json` を投げる → 1分以内にトリガーが拾って実行 → 結果を `result_*.txt` で同フォルダに書き戻し
- 初回 1 クリック (`setupOnce` の ▶実行) で OAuth 同意 + フォルダ作成 + トリガー設置 → 以降は手作業ゼロ

初回 1 click をさらに減らす方法は無い (Apps Script の OAuth 同意モデルは編集画面でのユーザー操作必須)。逆に言えば、この 1 click を最大限活用するため、`setupOnce()` 1 つに全プロジェクト初期化を集約 すること。「先に setupColumns、次に setupCommandQueue」のように分けてはいけない。

過去事例 (2026-06-11): 学会DB同期 GAS で `setupColumns` と `installCommandQueue` を別関数として用意 → ユーザーから「全ルール共通の絶対ルールにしてください」と要望 → `setupOnce()` 1 つに統合 + 全プロジェクト必須に格上げ。

過去事例 (2026-06-11): 決算書リンク取込 GAS (Gmail添付の決算書PDF→Drive保存→共有リンク→決算管理シート書込み) で、Claude がキュー未組込のまま push し `importAndInspect` を 2回 ▶要求 → さらに `clasp run-function` を試して "deploy as API executable" 失敗 → 事後でキューを retrofit し 計3クリック させてしまった。ユーザー「そちらでできないのかな」「今後はすべてに適用されるルールに」。教訓: 最初の push にキューを含め、初回作業 (取込・書込み等) を `setupOnce` に畳めば 1 クリックで完結した。「まず動かして後でキュー」は retrofit であり禁止。GAS で関数実行が要る時点で、設計の最初からキュー前提で書く。

### 必須実装テンプレ (新規 GAS プロジェクトで必ずコピー)

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

### `appsscript.json` 必須 scope

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

### kim 側の手作業 (各プロジェクトで 1 回だけ)

[GAS エディタ](https://script.google.com/a/orgiast.jp/d/<SCRIPT_ID>/edit) を開く → 関数選択 `setupOnce` → ▶ 実行 → OAuth 承認

これで OAuth + フォルダ + トリガー が一気に揃う。2 回目以降の ▶ 実行は不要。

### Claude 側の運用 (2 回目以降)

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

### ファイル形式

```json
// cmd_<unique>.json
{"command": "syncAll", "args": []}

// result_<unique>.txt
{"ok": true, "command": "syncAll", "result": {...}, "ts": "2026-06-11T..."}
```

### セキュリティ

- ホワイトリスト方式: `_COMMANDS_()` に登録された関数しか呼べない。任意コード実行不可
- フォルダはオーナーだけが書き込み権限、公開しない
- 機密データ (API キー等) はコマンドに含めない、Script Properties から読む
- 1 分より短いトリガー間隔は使わない (Apps Script の trigger quota を消費)

### やってはいけない

- ホワイトリストに無い関数を `eval` / `this[name]()` で呼ぶ
- フォルダを「リンクを知っている全員」共有にする
- 1 分より短いトリガー間隔
- `setupOnce` を分割して 2 click にする (1.4.1 違反)
- コマンドキュー組み込みを「事後対応」「優先度低」として後回しにする (絶対ルール違反)
- `ScriptApp.getProjectTriggers().forEach(deleteTrigger)` を無条件で実行する (processCommandQueue トリガーを巻き添え削除 → キュー死亡 → user に追加 ▶ click を要求するハメに)

### トリガー削除は必ず handlerFunction 名でフィルタする

別の自動同期トリガー (例: `installTriggers` で 1 時間毎の `syncAll` を入れ替える) を仕込む関数では、ホワイトリストで対象関数だけを削除する。`processCommandQueue` トリガーは絶対に巻き添えにしてはいけない。

```javascript
// ❌ NG: 全削除 (processCommandQueue まで消える)
ScriptApp.getProjectTriggers().forEach(function(t) { ScriptApp.deleteTrigger(t); });

// ✅ OK: handlerFunction 名でフィルタ
ScriptApp.getProjectTriggers().forEach(function(t) {
  if (t.getHandlerFunction() === 'syncAll') ScriptApp.deleteTrigger(t);
});
```

過去事例 (2026-06-11): 学会DB同期 GAS の `installTriggers` が `ScriptApp.getProjectTriggers().forEach(deleteTrigger)` で全削除 → cmd queue の 1分トリガーまで消えてキュー死亡 → 復旧で user に追加 1 click を要求 → §1.4.1 の「1 click のみ」ルール違反。

## 1.4.2 実行→検証→完了報告のサイクルは Claude 側で完結させる

ルール: コード変更を push したら、対象関数を実行して結果を検証してから user に報告する。エラーや想定外の状態が残ったまま「修正完了、テストして」と user に丸投げしない。

「もう一度押してみてください」「結果を教えてください」を何度も繰り返したら設計が間違っている。検証ステップが Claude 側にない証拠。

やる手順:

1. `clasp push -f` の後、対象関数の実行手段を確保する（優先度順）:
   - コマンドキュー (§1.4.1) を仕込んでいるなら `cmd_*.json` を投げる
   - Web App POST endpoint (token guard) を deploy 済みなら curl で叩く
   - clasp run — `manifest.executionApi.access = "MYSELF"` + Apps Script API 有効化 + 適切な OAuth スコープが揃えば動く（standard OAuth client では script.scriptapp スコープ不足で失敗しがち）
   - 上記がどれも不可なら user に 1 回だけ実行依頼 → 結果は Drive MCP `read_file_content` で読み戻して検証

2. 検証で異常があれば、user に報告する前に 自分で修正 → 再実行 → 再検証 のループを最低 1〜2 回回す

3. user に「完了」を伝えるのは検証 OK が確認できたタイミングだけ

Drive MCP 経由の事後検証パターン:

UI 操作が必須な関数（メニュー起動・サイドバーボタン）でも、関数が書き込む先のスプレッドシート/Doc を Drive MCP で読めば、user 実行後に Claude 側が結果を診断できる。

```
1. Claude が push
2. Claude が user に「サイドバーで X を1回押してください」依頼（1回だけ）
3. user 実行
4. Claude が Drive MCP read_file_content で結果スプレッドシートを読む
5. 期待状態と差分があれば Claude が修正 → goto 1
```

プロジェクト立ち上げ時のテンプレ作業:

新規 GAS プロジェクト初回 setup で以下を必ず仕込む（後付けは面倒）:
- `appsscript.json` に `executionApi: {access: "MYSELF"}` 追加
- §1.4.1 コマンドキュー方式を組み込み（`setupCommandQueue` + `processCommandQueue` + `COMMANDS` ホワイトリスト + cmd フォルダ）
- これで以降の修正サイクルが「Claude push → Claude 実行 → Claude 検証」になる

例外:
- 関数が UI 入力（モーダルのテキスト入力等）必須 → user 実行後に Drive MCP で結果検証に切替
- 第三者システム（他社の Sheets・外部 API）に副作用 → 確認なしで実行しない

由来: 2026-05-30 にブース制作アプリ ③ スケジュール生成で「もう一度押して」を何度も繰り返して user に手間をかけた経緯 → 明示要望「実行→エラー検証まで Claude 側で自動」をルール化。

## 1.4.3 Web/cron/デプロイ系の検証も Claude 側で完結させる

§1.4.2 は GAS 中心の書き方だが、Web/API/cron/Vercel デプロイ等にも同じ原則を適用する。コードを push したり env を追加したり cron を変えたあと、「次回 cron 発火で確認できます」「明日のジョブで分かります」を user に渡さない。Claude 側で発火を強制して、ログを読んで初めて「確認完了」と言う。

動かしたもの別の検証導線:

| 動かしたもの | 強制発火 | 結果取得 |
|---|---|---|
| Vercel デプロイ | `vercel --prod`（事前承認済み, [[feedback-vercel-prod-pre-authorized]]） | `vercel inspect <url>` で `status ● Ready` 確認、`vercel logs <url>` |
| Vercel cron (vercel.json) | curl + `?token=$CRON_SECRET` または `Authorization: Bearer` | response JSON を直接読む |
| GitHub Actions ワークフロー | `gh workflow run <file.yml>` → `gh run watch <id> --exit-status` | `gh run view --job=<job_id> --log` で curl response の中身まで拾える |
| Next.js API route | `curl -sS -H "Authorization: Bearer $TOKEN" <url>` | response JSON を grep |
| Supabase migration / 行操作 | service_role で対象テーブル select | rowCount + 値 assert |

Sensitive env が pull できないケース:

Vercel で `Sensitive` フラグの env（`CRON_SECRET`, `ANTHROPIC_API_KEY` 等）は `vercel env pull` で空文字になる（[[feedback-credential-injection-classifier-block]]）。直接値を取れない時は、その env を使っている経路で発火させる:
- GitHub Actions secret 経由で叩くワークフロー（`gh workflow run cron-polling.yml` 等）があるなら、そこから叩く
- 無ければ deploy hook URL や public な health endpoint で代替

プロジェクト立ち上げ時のテンプレ:

新規 Vercel/Next.js プロジェクトで:
- cron 系の GitHub Actions ワークフローには 必ず `on: workflow_dispatch:` を schedule と並べて書く（後で手動発火するため）
- API route は token guard を入れて Claude 側 curl で叩けるようにする
- Vercel project の `vercel --prod` と `vercel env add * production` は事前承認ルール（[[feedback-vercel-prod-pre-authorized]]）に乗せる

由来: 2026-06-03 aujust-sales-automation で `GMAIL_POLL_USERS` を追加した直後、当初「次回 cron 発火後に Vercel ログで確認できます」と user に渡そうとした → 「確認もそちらでできるかな？」と指摘。`gh workflow run cron-polling.yml` で強制発火 → `gh run view --log` で response JSON 内 `dwd:kim@orgiast.jp / dwd:seisaku-team@orgiast.jp` 両方 processed:30 を確認 → 完了報告。この検証導線を全プロジェクト共通ルールに格上げとの明示要望。
