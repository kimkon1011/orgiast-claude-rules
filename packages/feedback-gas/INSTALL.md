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

---

# 方式B: 共通フォームを1本だけ立てて、各アプリはリンクを置くだけにする（2026-09-04 追加・実測済み）

ここまでの手順（以下「方式A」）は、**対象アプリ自身を Web アプリとして `ANYONE_ANONYMOUS` で公開する**前提でした。これは次のアプリでは採用できません。

- **機微データを持つアプリ**（審査結果・顧客財務・価格など）。同じスクリプトを匿名公開すると、`doGet` の他の画面にも匿名で到達しうるため、公開範囲を実質的に広げてしまう
- **`oauthScopes` を宣言せず自動検出に頼っているアプリ**。スコープを明示リスト化すると自動検出が無効になり既存機能が壊れる（例: `w-col-gas`）
- **社員向け画面が存在しないアプリ**（LP のビーコン受け・Workspace Flows の add-on・JSON を返す管理用エンドポイントだけのプロジェクトなど）。そもそもフォームを置く場所がないので、**方式Bでも導入対象になりません**

候補かどうかは **`webapp` 設定の有無ではなく「社員が実際に開く HTML があるか」** で判定してください。`webapp.access` が `MYSELF` のプロジェクトは管理用エンドポイントであることが多く、社員向け画面を持ちません。Web の画面が別の Next.js アプリ側にある場合は、GAS 用ではなく Next.js 用のフォームパッケージが担当です。

これらには方式Bを使います。**共通フォームは既に1本だけ本番稼働しており、フォーム側は完全にパラメータ化されています。**

```
<共通フォームのexec URL>?form=feedback&app=<アプリ名をURLエンコード>&src=<報告元ページのURL>
```

`app` に渡した名前がそのまま Discord 通知の見出し（`🐛 **[アプリ名]** 不具合: …`）になります。`src` は報告元ページの URL で、通知に添えられます。

**共通フォームの exec URL は、public リポであるここには書きません。** 各PCの `~/.claude/feedback-relay.env` の `FEEDBACK_SHARED_FORM_URL` にあります（分からなければ kim に確認）。

## 方式Bの手順（対象アプリ側の作業はリンク1本だけ）

対象アプリの画面（HtmlService の HTML、またはシートのセル）に、上記 URL へのリンクを置きます。**それ以外は何もしません。**

- 🔴 `appsscript.json` を変更しない（`webapp` 設定もスコープも触らない）
- 🔴 `clasp deploy` しない（新規デプロイを作らない）
- 🔴 サーバ側のコード（`doGet` 等）を変更しない
- 🔴 `Admin_setFeedbackRelay` も不要（設定は共通フォーム側に既に入っている）

HTML に置く場合の注意:

- `app=` の値は**URLエンコード済みの文字列をそのまま HTML に書く**。日本語を直に書くと Windows の編集経路で文字化けする
- HTML の属性値の中では `&` を `&amp;` にエスケープする
- 対象ページに `<base target="_top">` がある場合、リンクに `target="_blank" rel="noopener"` を明示する（無いと同一タブで開いて作業中の画面を失う）

```html
<div class="feedback-link">
  <a href="<共通フォームURL>?form=feedback&amp;app=%E3%83%88%E3%83%A9%E3%82%A4%E3%82%A2%E3%83%AB..."
     target="_blank" rel="noopener">🐛 不具合・要望</a>
</div>
```

## 方式Bの検証手順

対象アプリが `access: DOMAIN` の場合、匿名 `curl` ではページを取得できません。次の3点で確認します。

1. **共通フォームがそのアプリ名で描画されるか**: `app=` を付けた URL を実際に取得し、返ってきた HTML にアプリ名が**文字化けせず**含まれることを確認する。シェル経由の `curl --data-urlencode` は Windows で cp932 化けするので、**Node の `fetch` + `encodeURIComponent`** で叩く
2. **本番のスクリプトに反映されたか**: `clasp push -f` のあと、別ディレクトリに `.clasp.json`（同じ `scriptId`）を置いて `clasp pull` し、リンク文字列が含まれることを grep で確認する
3. **公開範囲が広がっていないか**: 対象アプリの exec URL に匿名でアクセスし、**302 で `accounts.google.com` に飛ぶ**（＝ログイン必須のまま）ことを確認する

デプロイが `@HEAD` なら `clasp push` が即座に本番へ出ます（`clasp deployments` で確認）。バージョン固定（`@1` 等）なら push だけでは画面に出ないので注意。

## 方式Aと方式Bの使い分け

| | 方式A（アプリ自身に載せる） | 方式B（共通フォームへリンク） |
|---|---|---|
| 対象 | 機微データを持たない社員向けアプリ | 機微データあり／スコープを触れない／画面が無い |
| アプリ側の変更 | HTML+JS 追加・`appsscript.json`・新規デプロイ・設定投入 | **リンク1本だけ** |
| 公開範囲の変更 | 必要（`ANYONE_ANONYMOUS`） | **不要** |
| 記録先シート | そのアプリ側 | 共通フォーム側にまとまる |
| 画像添付・honeypot・レート制限 | あり | あり（共通フォームの機能をそのまま使う） |

記録先が共通フォーム側に集約される点だけが方式Bの弱点です。アプリ別に記録を分けたい場合は方式Aを選んでください（通知は `app` 名で区別できるので、Discord/Issue 側の運用は方式Bでも困りません）。
