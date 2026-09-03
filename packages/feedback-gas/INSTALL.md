# 導入手順（GAS 不具合・要望フォーム）

## 1. これは何をするパッケージか

対象の GAS アプリに「🐛 不具合・要望」フォームを1画面追加します。社員がフォームから送ると、①記録先スプレッドシートの「不具合要望」シートに自動で記録され、②開発担当の Discord に通知が飛びます。ログイン不要・トークン不要で開けるフォームです。

以下は非エンジニアでもそのまま実行できるよう、コマンドをそのまま貼り付けられる形で書いています。実際の作業は Claude Code に「このファイルの手順で feedback フォームを入れて」と頼めば、Claude が代行できます（clasp push・デプロイ・Script Properties 設定まで自動化可能）。

## 2. templates の2ファイルを対象アプリにコピーする

対象の GAS プロジェクト（clasp でローカル管理しているフォルダ）に、次の2ファイルをそのままコピーします。ファイルの中身は変更不要です。

- `packages/feedback-gas/templates/FeedbackRelay.js` → 対象アプリの `src/FeedbackRelay.js`
- `packages/feedback-gas/templates/FeedbackForm.html` → 対象アプリの `src/ui/FeedbackForm.html`

対象アプリの `src/ui/` フォルダが無い場合は先に作成してください。

コピーコマンド例（PowerShell、`<対象アプリのパス>` は実際のフォルダに置き換える）:

```powershell
Copy-Item "C:\Users\uers\Downloads\orgiast-claude-rules\packages\feedback-gas\templates\FeedbackRelay.js" "<対象アプリのパス>\src\FeedbackRelay.js"
New-Item -ItemType Directory -Force "<対象アプリのパス>\src\ui" | Out-Null
Copy-Item "C:\Users\uers\Downloads\orgiast-claude-rules\packages\feedback-gas\templates\FeedbackForm.html" "<対象アプリのパス>\src\ui\FeedbackForm.html"
```

## 3. doGet に1行足す

対象アプリの `doGet` 関数を開き、**token 検証より前**（関数の一番上）に次の1行を追加します。報告者は token を持っていないため、token チェックより前に分岐させる必要があります。

```javascript
function doGet(e) {
  var params = (e && e.parameter) || {};
  if (String(params.form || '') === 'feedback') return FeedbackRelay_serveForm(params);

  // ↓ここから既存の token 検証・画面振り分け処理（変更不要）
  ...
}
```

対象アプリに `doGet` が無い場合（フォーム専用の新規プロジェクト等）は、次の最小構成をそのまま追加してください。

```javascript
function doGet(e) {
  var params = (e && e.parameter) || {};
  if (String(params.form || '') === 'feedback') return FeedbackRelay_serveForm(params);
  return HtmlService.createHtmlOutput('このアプリには feedback フォーム以外の画面はありません。');
}
```

## 4. clasp push とデプロイ

対象アプリのフォルダで、ターミナルから以下を実行します。

```powershell
cd "<対象アプリのパス>"
clasp push -f
```

Web アプリとして未デプロイの場合は、GAS エディタで「デプロイ」→「新しいデプロイ」→ 種類「ウェブアプリ」→ アクセスできるユーザー「全員」で発行し、表示された `/exec` の URL を控えます（既にデプロイ済みなら `clasp deploy` で更新するだけで既存 URL のまま反映されます）。

## 5. Admin_setFeedbackRelay で設定を入れる

**このリポジトリは public のため、URL・シークレットの値はどこにも書きません。** 値は GAS の Script Properties に保存し、そこからだけ読みます。

`Admin_setFeedbackRelay(url, secret, appName, formUrl)` を1回だけ実行します。引数は以下の通りです。

- `url`: 全社共通の中継エンドポイント URL（既存の GAS アプリで動いている値を流用。分からなければ kim に確認）
- `secret`: 中継の共有シークレット（同上）
- `appName`: このアプリの表示名（例: `"予約管理アプリ"`）。通知やフォームの案内文に出ます
- `formUrl`: 手順4で控えた `/exec` URL（各画面に「🐛 不具合・要望」リンクを置く場合に使う。省略可）

**コマンドキューがあるアプリ**（実行パネル等から関数を呼べる仕組みがある場合）: 実行パネルから `Admin_setFeedbackRelay` を選び、上記の値を引数で渡して実行します。

**コマンドキューが無いアプリ**: GAS エディタ（`script.google.com/a/orgiast.jp/d/{スクリプトID}/edit`）を開き、関数選択プルダウンで対象を選べないため、エディタ下部の実行ログ用に一時的に次のような呼び出し専用関数を追加して1回だけ実行し、終わったら削除します。

```javascript
function _tmp_setFeedbackRelay() {
  Admin_setFeedbackRelay(
    'https://中継のURL',
    '共有シークレット',
    'このアプリの表示名',
    'https://script.google.com/.../exec'
  );
}
```

GAS エディタ上部の関数選択で `_tmp_setFeedbackRelay` を選び「実行」ボタンを押します（初回のみ権限承認のダイアログが出るので許可してください）。実行後、この関数は削除して `clasp push -f` し直してください（シークレットをコードに残さないため）。

記録先を既定（アクティブなスプレッドシート、シート名「不具合要望」）から変えたい場合は、Script Properties に `FEEDBACK_LOG_SS_ID`（スプレッドシートID）や `FEEDBACK_LOG_SHEET_NAME`（シート名）を追加で設定してください。

## 6. 動作確認

1. ブラウザで `<手順4の/exec URL>?form=feedback` を開き、フォームが表示されることを確認する
2. 適当なタイトルを入力して送信し、「送信しました。」と表示されることを確認する
3. 記録先スプレッドシートに「不具合要望」シートが作られ、送信内容が1行追加されていることを確認する
4. 開発担当の Discord に通知が届いていることを確認する
5. 設定だけを確認したい場合は、実行パネルまたは GAS エディタから `FeedbackRelay_ping()` を実行する（`hasUrl` / `hasSecret` が `true` なら設定済み。値そのものは返ってこない）

## 7. うまくいかない時の対応表

| 症状 | 原因の可能性 | 対策 |
|---|---|---|
| `?form=feedback` を開いても既存の画面が出る | `doGet` の分岐が token 検証より後ろにある、または `params.form` の判定が無い | 手順3の1行を `doGet` の一番上に移動する |
| フォームは開くが送信すると「エラー: 記録の読み戻しに失敗しました」 | 記録先スプレッドシートが特定できていない、または権限不足 | Script Property `FEEDBACK_LOG_SS_ID` を設定するか、スクリプトが対象スプレッドシートにコンテナバインドされているか確認する |
| 送信は成功するが Discord に通知が来ない | `FEEDBACK_RELAY_URL` / `FEEDBACK_RELAY_SECRET` が未設定、または値が間違っている | `FeedbackRelay_ping()` で `hasUrl` / `hasSecret` を確認し、手順5をやり直す。`DISCORD_FEEDBACK_WEBHOOK` があればそちらにフォールバック通知が届いているはず |
| 何度も連続送信すると「しばらく時間をおいて再度お試しください」と出る | レート制限（10分5件）に達した | 想定通りの挙動。10分待つ |
| ボットらしき投稿が記録されない | honeypot（`company` 欄）が埋まっていたため成功を装って破棄された | 想定通りの挙動。対応不要 |
| `clasp push -f` がエラーになる | ログイン切れ、または `appsscript.json` の記法ミス | `clasp login` を再実行し、`appsscript.json` の JSON 構文を確認する |
| 画像を貼り付け/D&D しても反映されない | 画像形式が `image/*` でない、または1枚8MB超・合計25MB超・6枚目以降 | 上限内のファイルで再試行する（超過分は通知には載らないが、記録自体は成功する） |

## HTML ファイルの置き場所について

`FeedbackForm.html` は `src/ui/FeedbackForm.html`（ブース制作アプリ方式）でも、プロジェクト直下の
`FeedbackForm.html`（平置き方式）でも動きます。どちらも自動で探します。

それ以外の名前・場所に置いた場合だけ、Script Property `FEEDBACK_FORM_TEMPLATE` に
GAS 上でのファイル名（拡張子なし・スラッシュ区切り）を入れてください。

| 症状 | 対策 |
|---|---|
| フォームを開くと「FeedbackForm.html が見つかりません」 | `clasp push -f` で HTML も上がっているか確認。別名で置いた場合は `FEEDBACK_FORM_TEMPLATE` を設定 |

## appsscript.json の設定（**これを忘れると「ページが見つかりません」になる**）

Web アプリとして公開する設定と、中継へ通信するスコープが要ります。対象プロジェクトの
`appsscript.json` に次を足してから `clasp push -f` → デプロイしてください。

```json
{
  "webapp": { "executeAs": "USER_DEPLOYING", "access": "ANYONE_ANONYMOUS" },
  "oauthScopes": [
    "https://www.googleapis.com/auth/script.external_request",
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive",
    "https://www.googleapis.com/auth/script.scriptapp"
  ]
}
```

- `ANYONE_ANONYMOUS`（全員・ログイン不要）にするのは、報告者にトークンやアカウントを配れないため。
  未認証で開ける前提の濫用対策（honeypot・レート制限・文字数制限）はテンプレートに常時有効で入っています。
- `executeAs: USER_DEPLOYING` にすると、報告者の Google アカウントを問わずデプロイ者の権限で記録できます。
- **既に `oauthScopes` がある場合は消さずに追記**すること。消すと既存機能が権限不足で落ちます。

| 症状 | 対策 |
|---|---|
| フォームURLを開くと「ページが見つかりません」 | `webapp` 設定が無い。上記を足して `clasp push -f` → `clasp deploy -i <デプロイID>` |
| フォームは出るが送信すると失敗する | `script.external_request` スコープが無い。足して再デプロイし、初回は自分で1度開いて承認する |

## コマンドキューのホワイトリスト登録（**引数の渡し方はアプリごとに違う**）

アプリによって、キューが登録関数へ引数を渡す形が違います。**登録する前に、そのアプリの
コマンドキュー実装で「関数をどう呼んでいるか」を必ず確認**してください。実際に2種類ありました。

| 呼び出し方 | 例 | 登録の書き方 |
|---|---|---|
| `commands[fn].apply(null, args)`（配列を展開） | ブース制作アプリ | `function (url, secret, appName, formUrl) { return Admin_setFeedbackRelay(url, secret, appName, formUrl); }` |
| `COMMANDS[fn](args)`（配列をそのまま第1引数へ） | CO2算出ツール | `(a) => { var o = Array.isArray(a) ? (a[0] \|\| {}) : (a \|\| {}); return Admin_setFeedbackRelay(o.url, o.secret, o.appName, o.formUrl); }` |

確認せずにコピペすると `fileId は必須` のような「引数が届かない」エラーになります。

## 設定値の入れ方（シークレットをログに残さない）

`Admin_setFeedbackRelay` に値を直接渡すと、コマンドファイルや作業ログにシークレットが残ります。
**`Admin_setFeedbackRelayFromFile(fileId)` を使ってください。**

1. 設定 JSON を自分だけがアクセスできる Drive フォルダに置く
   ```json
   { "url": "<中継URL>", "secret": "<シークレット>", "appName": "<アプリ名>", "formUrl": "<WebアプリのexecURL>" }
   ```
2. そのファイルの ID だけをコマンドで渡す（**ID は秘密情報ではない**）
3. 反映を確認したら、**設定ファイルは削除する**

| 症状 | 対策 |
|---|---|
| `設定ファイルを読めません` | ファイルIDが違う / そのGASプロジェクトの実行アカウントに閲覧権が無い |
| `fileId は必須` | ホワイトリストの引数の受け方が上表と合っていない |

### 設定ファイルは必ず UTF-8 で保存する（Windows の罠）

`appName` に日本語を入れる場合、**ファイルを UTF-8 で書かないと GAS 側で文字化けします**
（アプリ名が壊れると、中継側でアプリ→リポジトリの対応付けに失敗して Issue が作れません）。

Windows の PowerShell / Python でシェルのリダイレクト（`> file.json`）を使うと、
標準出力が cp932 になって壊れることがあります。**ファイルへ直接書く**形にしてください。

```python
import io, json
io.open(path, 'w', encoding='utf-8', newline='\n').write(json.dumps(cfg, ensure_ascii=False))
```

書いたあとは必ず読み戻して確認します（壊れていれば `UnicodeDecodeError` になります）。

| 症状 | 対策 |
|---|---|
| 反映結果の `appName` が `CO2...` のように途中から壊れている | 設定ファイルが UTF-8 でない。上記の方法で書き直して再投入 |
