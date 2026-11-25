# 実装依頼: マヒト法人名刺 発注CLI `tools/meishi-order.mjs` と skill `meishi`

作業ディレクトリ: `C:\Users\user\orgiast-claude-rules`（ESM, `"type":"module"`, `playwright-core` は node_modules に有り）。
作るファイルは 3 つ。既存ファイルは変更しない。

1. `tools/meishi-order.mjs` （CLI 本体）
2. `tools/meishi-order.test.mjs` （純関数のユニットテスト。`node --test tools/meishi-order.test.mjs` で通ること。ネットワーク不要）
3. `C:\Users\user\.claude\skills\meishi-order\SKILL.md` （Claude Code skill。後述）

## 背景（読んで理解すること）

社内で名刺は「マヒトデザイン クラウド法人名刺」（Laravel製 Web システム）で発注する。手順は社内マニュアル通り:
「名刺リスト」で該当者を「申請」(枚数選択) → 「名刺注文」で該当申請にチェック → 次へ → 配送先 → 用紙等 → 出荷/配送 → 確認 → 「注文」。
これを Claude Code から `/meishi 澤山` の一言で回せるようにする。**注文確定は必ず人の OK を挟む**（`--yes` 無しでは確定しない）。

## 認証・環境

- 認証情報は `~/.claude/secrets/mahito-meishi.env`（`KEY=VALUE` 行）。キー: `MAHITO_LOGIN_URL`, `MAHITO_ID`, `MAHITO_PASSWORD`, 任意 `MAHITO_BILLING_ID`（既定 `461`）。
  無ければ「~/.claude/secrets/mahito-meishi.env が無い。ログイン情報シート(社内)の『マヒトデザイン クラウド法人名刺』行を見て作成」と日本語で案内し exit 1。
- パスワードは **stdout/stderr/ログ/ファイル名に絶対出さない**。argv にも載せない（env ファイルから読むだけ）。
- ベース URL: `https://mhtdesign.net/cloudb2`。ログインページは `MAHITO_LOGIN_URL`（実体 `https://mhtdesign.net/cloudb2/orgiast-meishi/login`、302 で `/cloudb2/...` に飛ぶ。`cloudbiz` → `cloudb2` にリダイレクトされるので followRedirect 前提）。

## サイトの実測構造（2026-09-10 に確認済み。この通りに実装する）

### ログイン（HTTP でも Playwright でも同じ）
- GET ログインURL → HTML に `<input type="hidden" name="_token" value="...">`、`input[name=id]`、`input[name=password]`、`button[type=submit]`。
- POST 同URL: `_token`, `id`, `password`（application/x-www-form-urlencoded）。成功すると `/cloudb2/company/notice`（title「マヒト法人名刺 TOP」）へリダイレクト。失敗時は同ページに `<li>IDもしくはパスワードが間違っています。</li>`。
- Cookie 必須（Laravel セッション）。HTTP 実装は自前の簡易 cookie jar（`set-cookie` を name=value で蓄積）で良い。`fetch` は Node 18+ 組み込みを使い、`redirect: "manual"` で自分で追う（cookie を持ち回るため）。

### 名刺リスト `/cloudb2/businesscard/information?display_count=300&p=N`
- 1 行 = `<tr class="businesscard_row" data-businesscard_id="289720" data-size="一般（91mm x 55mm)">`。行内テキストを `<[^>]*>` 除去して空白正規化すると `営業 Sawayama.T 澤山 貴俊 289720 編集 コピー 申請 削除 2026-08-25 21:42 注文差分` のようになる（順に グループ / 社員ID / 名前 / 名刺ID / 操作 / 前回注文日時）。
  - **申請中の名刺は行に「申請」リンクが無い**（`td.application_col` が空）。→ これで「すでに申請済みか」を判定できる。
- ページング: `href="/cloudb2/businesscard/information?p=2"` があれば次ページ。件数 65 なので通常 1 ページ。
- `<meta name="csrf-token" content="...">` を AJAX 用に取る。
- 検索クエリ `employee_name=` は部分一致が効かないことがあるので使わず、全件取得して自前でマッチする。

### 名刺データ（役職など） `/cloudb2/businesscard/information/{名刺ID}/edit`
- `<script>` 内に `const design_items_front = [...]` / `const design_items_back = [...]`（各 design の `items[]` に `item_id`, `display_name`）と、`const init_param = {...}`（中に `{"type":"free","item_id":6045,"variable_id":null,"value":"..."}` 形式の値配列がネスト）がある。
- 行頭 `\s*(const|let|var)\s+(\w+)\s*=\s*(.*);?\s*$` で 1 行 JSON を拾い `JSON.parse`。`init_param` を再帰的に歩いて `item_id` と `value` を持つオブジェクトを集め、`display_name` にマップして `{URL, 姓名, 英字ルビ, 役職, mobile, "E-mail", ...}` を得る。
- 裏面デザインの確認用に `init_param` 内の `design`/`back` 系キー（`design_id`, `design_name`, 画像名に `裏面new202405` を含むか）も探して表示する。見つからなければ「裏面: 判定不能（画面で確認）」と出す。

### 申請（AJAX） `POST /cloudb2/businesscard-api/information/application`
- ヘッダ `X-CSRF-TOKEN: <meta csrf-token>`, `X-Requested-With: XMLHttpRequest`, `Content-Type: application/x-www-form-urlencoded`
- ボディ: `businesscard_id_list[]=289720&quantity=100&note=`（jQuery `$.ajax` の data 直列化と同じ。配列は `businesscard_id_list[]`）
- 応答 JSON `{"status":0}` が成功、`{"status":1,"message":"..."}` が失敗。
- 枚数の選択肢は 名刺リストページの `select[name=application_single_quantity]` の option から取る（既定 100）。

### 申請履歴 `/cloudb2/businesscard/requesthistory`
- thead: `申請日時 社員ID 名前 名刺ID 枚数 状態 承認中グループ 備考`。状態は `申請中` / `承認済` / `キャンセル`。

### 名刺注文（ウィザード。ここは Playwright）
1. `/cloudb2/businesscard/order`（title「マヒト法人名刺 名刺注文」）: 申請中一覧。行 `<tr data-group_id=...>` に `input[name="ids[]"][value="<申請ID>"]`、名刺IDは `a.view_thumbnail[data-businesscard_id="289720"]`、枚数セル、申請日時セル。`select[name=billing_address_id]`（`461`=オージャスト経理 / `595`=基本請求先）。`#approve-btn`（「次へ」、form=approve、`POST /cloudb2/businesscard/order`）。初回はチュートリアルモーダル（`#not_show_next_tutorial` 等）が出ることがあるので、`.modal` を非表示・`.modal-backdrop` を除去してから操作。
2. `/cloudb2/businesscard/orderdelivery`: `#delivery-list`（配送先一覧）と「配送先情報を入力する」選択肢。次へ `#btn_orderdelivery_next`、戻る `#btn_orderdelivery_prev`。
3. `/cloudb2/businesscard/orderdetails`: `#orderdetails_table`（用紙・角丸）。次へ `#btn_orderdetails_next`。
4. `/cloudb2/businesscard/ordershipping`: `#ordershipping_options`（出荷営業日・梱包方法・配送方法・配達日時）。次へ `#btn_ordershipping_next`。
5. `/cloudb2/businesscard/orderconfirm`: `#order_confirm_tables`、確定 `#btn-fix-order`（**これを押すと本注文**）。
6. 完了後 `/cloudb2/businesscard/order` に戻り、エラー時は `.alert-danger`。
- **2〜4 の内部フォーム要素名は未確認**。よって「テキストで選ぶ」汎用ロジックで実装し、想定要素が見つからない場合は**そのページの全フォーム要素（tag/name/id/type/options/ラベル）を stderr にダンプして exit 2** する（次回修正できるように）。決め打ちの name で落ちる実装にしない。

## CLI 仕様

```
node tools/meishi-order.mjs check <名前|社員ID|名刺ID>
node tools/meishi-order.mjs apply <名前|社員ID|名刺ID> [--qty 100] [--note "..."]
node tools/meishi-order.mjs order <名前|社員ID|名刺ID> [--to "<配送先の一部文字列>"] [--yes] [--headful] [--paper "マットポスト紙 180kg"] [--pack "紙箱"] [--ship "メール便"] [--days 0] [--corner "なし"]
node tools/meishi-order.mjs history [<名前>]
```

共通:
- 対象の特定: 名刺リスト全行から、引数を空白除去して `名前(空白除去)` / `社員ID`(大小無視) / `名刺ID` のいずれかに**部分一致**。複数一致なら候補を表で出して exit 1（勝手に選ばない）。0 件も exit 1。
- 出力は日本語・簡潔。人が読む行は `名刺ID 289720 / 社員ID Sawayama.T / 澤山 貴俊 / グループ 営業` のように ID と名前を必ず併記。
- `--json` で機械可読 JSON も出せるようにする。

`check`: HTTP のみ（ブラウザ不要）。対象の行情報 + edit ページの項目値（URL/姓名/英字ルビ/役職/mobile/E-mail/裏面判定）+ 申請履歴のその人の直近 3 件 + 名刺注文ページに載っている申請中(申請ID・枚数・申請日時) を表示。URL が `http://` なら警告。役職が「契約ディレクター/契約クリエーター/プロデューサー」以外なら「役職は標準3種以外（例: 部長など個別設定）」と情報表示（エラーではない）。

`apply`: HTTP のみ。既に「申請中」（名刺注文ページに同じ名刺IDの行がある）なら何もせず「既に申請中（申請ID xxx, 枚数 n）」と出して exit 0。それ以外は上の AJAX を叩き、成功したら申請履歴を再取得して新しい申請IDを表示。

`order`: Playwright(`playwright-core`, chromium の exe は `%LOCALAPPDATA%\ms-playwright\chromium-*/chrome-win64/chrome.exe`（無ければ `chrome-win`）を最新番号で自動検出。`tools/gpage-fetch.mjs` の `findChromium` と同じやり方でよい。headless 既定、`--headful` で表示)。
  1. ログイン → `/businesscard/order` → 対象名刺IDの申請行の `ids[]` をチェック（無ければ「申請がありません。先に apply を実行」exit 1）→ 請求先を `MAHITO_BILLING_ID` に → `#approve-btn`。
  2. 配送先: `--to` があれば `#delivery-list` 内でそのテキストを含む選択肢（radio/option/行）を選ぶ。無ければ一覧の先頭の既存配送先を選ぶ（何を選んだかを表示）。「配送先情報を入力する」の新規入力は本バージョンでは**未対応**と明記し、`--to new` が来たら「未対応。画面で入力してください」と exit 2。
  3. 用紙 = `--paper`（既定「マットポスト紙 180kg」）、角丸 = `--corner`（既定「なし」): ページ内の select/radio/ラベルのテキストを部分一致で選ぶ汎用関数 `chooseByText(page, scopeSelector, text)` を実装（select の option テキスト → radio/checkbox のラベル → クリック可能な要素、の順に探す）。
  4. 出荷営業日 = `--days`（既定 0。無ければ最小値を選び警告）、梱包 = `--pack`（既定「紙箱」）、配送方法 = `--ship`（既定「メール便」。枚数 500 以上なら「宅急便」に自動切替して表示）。
  5. 確認ページで `#order_confirm_tables` の innerText を整形して表示し、スクリーンショットを `~/.claude/meishi-order/<YYYYMMDD-HHmm>-<名刺ID>-confirm.png` に保存してパスを表示。
  6. `--yes` 無し: ここで **「DRY RUN: 注文は確定していません。確定するには --yes を付けて再実行」** と出して exit 0（ブラウザは閉じる）。
     `--yes` 有り: `#btn-fix-order` をクリック → 遷移後の `.alert`（成功/失敗）を表示 → 注文履歴 `/businesscard/orderhistory` の先頭行（注文日時/注文番号/進捗/合計金額/出荷営業日/発送予定日）を表示 → 完了。
  - 各ステップで URL が想定と違う / `.alert-danger` が出た / 要素が見つからない → そのページの全フォーム要素をダンプ（上記）し、スクリーンショットを `~/.claude/meishi-order/<日時>-error.png` に保存、exit 2。

`history`: 申請履歴 + 注文履歴（HTTP）。名前を渡せばその人で絞る。

## 実装上の注意（このリポジトリの既知の罠）
- エントリ判定は `import { isEntry } from "./is-entry.mjs"` を使い `if (isEntry(import.meta.url)) main()`。`import.meta.url === argv[1]` 比較は Windows で必ず false になる。
- `process.exit()` を Playwright の `browser.close()` より前に呼ばない（finally で close）。
- HTML 内の日本語は `\uXXXX` エスケープされた JSON にある。`JSON.parse` で戻る。
- 文字列の空白正規化は全角スペース `\u3000` も対象にする。
- 純関数（行パース `parseCardRows(html)`、`extractJsonVars(html)`、`pickItemValues(initParam, designItems)`、`matchTarget(rows, query)`、`serializeForm(obj)`、`shipMethodFor(qty, requested)`）は export して `.test.mjs` から `node:test` + `node:assert` でテスト。HTML はテスト内に小さなフィクスチャを書く。
- 外部ライブラリ追加禁止（`playwright-core` と Node 標準のみ）。

## skill `~/.claude/skills/meishi-order/SKILL.md`

frontmatter:
```
---
name: meishi-order
description: マヒト法人名刺で名刺を発注する。「名刺発注」「名刺を注文」「/meishi 〇〇さん」「〇〇さんの名刺100枚」など名刺の発注・申請・肩書確認の依頼が来たら必ずこのスキルを使う。
---
```
本文（Claude が読む手順。簡潔に）:
1. `node ~/orgiast-claude-rules/tools/meishi-order.mjs check <名前>` を実行し、役職・URL(https)・裏面・申請状況を user に 3〜5 行で報告。役職や住所に変更が無いか user に確認する（マニュアル上「OK をもらうまで次に進まない」）。
2. 申請中でなければ `apply <名前> --qty <枚数>`（既定 100。user 指定があればそれ）。
3. `order <名前>`（dry run）を実行し、確認ページの内容とスクリーンショットパスを user に見せる。
4. user の「OK」を得てから `order <名前> --yes`。**OK 前に --yes を付けない。**
5. 完了後、注文履歴の発送日・注文番号を添えてマニュアルの完了報告テンプレを出す:
   「ご依頼の名刺発注完了いたしました。〇/〇発送メール便となります。・発送先住所 ・問い合わせNO（翌日には反映されます） 宜しくお願い致します。」
6. 報酬計上のリマインド: アシスタントタスクリスト https://docs.google.com/spreadsheets/d/1BTSkpcOLZ8F869vnNqPulyvbaZ1Ou7InjH5jsJH4grA/edit?gid=431931037 の「名刺作成」行に担当者名・回数・金額(1回300円)。
7. exit 2 が出たら stderr のフォーム要素ダンプを読み、`tools/meishi-order.mjs` の該当ステップのテキスト/セレクタを直してから再実行する（ツールは初回実行で未確認画面の構造を学ぶ設計）。
8. 参考: 社内マニュアル「名刺の発注方法（通常）」 https://orgiast-manual.com/626d6b22a6214d036d8794b6 、急ぎはアクセア印刷（別ページ）。

## 完了条件
- `node --test tools/meishi-order.test.mjs` が全て pass。
- `node tools/meishi-order.mjs --help` で使い方（日本語）が出る。
- `node tools/meishi-order.mjs check 澤山` が実行できてエラーにならない（実行して確認して良い。読み取り専用）。
- `apply` と `order --yes` は**実行しない**（本番に副作用がある）。`order`（dry run）も今回は実行しない。
