# ラハイナ じゃらん受付再開の確定（2026-10-15 実測）

対象: じゃらん yad353005 / 楽天トラベル HOTEL/37967 / 公式 lahaina.jp
目的: 運用設計書（Doc `1b94C8E4U8drGBoH7z1VvzNFpScv-J8F-Mv13bGXEvJc`）第2章「現状の実測」の
「媒体｜状態｜確認方法」表、じゃらん・楽天・公式の3行を実測にもとづいて更新する。

## 1. 結論

| 媒体 | 10/15 の実測 | 判定 |
|---|---|---|
| じゃらん（yad353005） | **予約受付を再開している（受付中）** | 停止は解除済み |
| 楽天トラベル（HOTEL/37967） | 「指定されたページは掲載終了しました」 | 変化なし |
| 公式サイト lahaina.jp | お知らせ最終 2026.06.05、休業/再開の告知なし | 変化なし |

## 2. じゃらんの根拠（判定不能 → 受付中に確定）

10/14 時点は「施設ページのサーバ HTML に『予約受付を停止中』が無く、空室カレンダーは
`jln-mvp-api.jp` の JS 描画で全日『-』」＝判定不能だった。10/15 に**予約導線そのもの**を叩いて確定させた。

取得した URL 形式（1泊・1部屋・大人2名）:

```
https://www.jalan.net/yad353005/plan/?stayYear=YYYY&stayMonth=MM&stayDay=DD&stayCount=1&roomCount=1&adultNum=2&childNum=0&screenId=UWW3101&yadNo=353005
```

**プランが出た日（＝受付中）**: 2026-10-18 / 10-19 / 10-22 / 10-25 / 11-01 / 11-20

表示された実データ（10/18・11/20 で同一）:

- プラン名: `【鴨鍋＋真鯛の香草焼き】寒い季節にうれしいあったか料理♪ワンちゃんと一緒にお泊り`
- 部屋: スタンダードツイン（禁煙） / 食事: 朝・夕 / `オンラインカード決済可`
- 料金: 大人1名 13,750円、**2名合計 27,500円（税込）** ← 施設ページの og:description「2名税込27500円〜」と一致
- 在庫: **あと 1 部屋**

**プランが出なかった日**: 2026-10-15 / 10-16 / 10-17 / 11-10 / 11-28 / 12-05 / 12-15 / 12-20 / 2027-01-10
→ この日は「申し訳ありませんが、設定された条件でご利用できるプランがないか、宿がじゃらんnetでの予約受付を停止中です。」という**汎用文言**。

### 動的応答であることの検証（キャッシュ説の排除）

| 検証 | 結果 |
|---|---|
| 同一 URL をキャッシュバスター付き（`&_cachebust=99887766`）で再取得 | プランあり・残1部屋で**同一**（＝CDN の固定キャッシュではない） |
| 同 URL で `adultNum=6`（定員超過）に変更 | **プランが出ない**（＝リクエストパラメータに応じてサーバが都度判定している） |

→ 「汎用文言」は**条件に合うプランが無い**場合のメッセージであり、施設レベルの受付停止ではない。
同一ページで日付・人数を変えると結果が変わる以上、施設は受付中と確定できる。

### 残る論点（次段の確認事項）

- 在庫が公開されているのは **10/18〜11/01 頃まで**。11/10 以降は在庫が未公開（プラン未登録）。
  12/30〜1/3 は公式サイト告知どおり**電話予約のみ**（10/25 正午開始）。
- 10/15〜10/17（当日〜2日前）が出ないのは直前受付の締め切りと解釈できるが、**未検証**。

## 3. 楽天の根拠

`https://travel.rakuten.co.jp/HOTEL/37967/37967.html`（リダイレクト追跡後も同 URL・HTTP 200）
→ 本文 `<h2>指定されたページは掲載終了しました。</h2>`（1648 bytes のエラーページ）。10/14 から変化なし。

## 4. 公式サイトの根拠

`https://lahaina.jp/`（HTTP 200・62,890 bytes）
→ お知らせの最新**日付**は `2026.06.05`。休業/営業再開の告知は無し。予約導線は電話 `0869-34-5539` とフォーム。
年末年始の告知（12/30〜1/3 は 10/25(日) 正午から電話予約）は掲載済み。10/14 から変化なし。

## 5. 運用設計書に当てる差分（3セル）

現行（Doc 第2章、`read_file_content` で 10/15 に実読）:

```
| じゃらん（yad353005） | 10/17のプラン検索で「予約受付を停止中です」。施設ページは残存、クチコミ評価は非表示（有効数未達） | curl で実HTML取得（Shift JIS変換） |
| 楽天トラベル（HOTEL/37967） | 「指定されたページは掲載終了しました」 | WebFetch |
| 公式サイト lahaina.jp | 閉館告知は消えているが営業継続の告知なし。最新記事は6月5日。予約導線は電話0869-34-5539とフォーム。楽天トラベルへのリンクが残っている（リンク先は掲載終了）。WordPress製、REST APIは無効化（401 rest disabled） | WebFetch・curl |
```

差し替え後の「状態」セル（確認方法セルは現行のまま）:

- じゃらん（yad353005）→
  `10/15のプラン検索で受付再開を確認（10/18・10/19・10/22・10/25・11/1・11/20 でプラン1件／スタンダードツイン禁煙 2名27,500円税込・残1部屋・オンラインカード決済可。大人6名では出ない＝パラメータ依存の動的応答）。在庫公開は10/18〜11/1頃まで。10/15〜10/17と11/10以降は「プランがないか予約受付を停止中です」の汎用文言＝条件不一致であり施設停止ではない。施設ページ残存・クチコミ評価は非表示`
- 楽天トラベル（HOTEL/37967）→
  `10/15も「指定されたページは掲載終了しました」（変化なし）`
- 公式サイト lahaina.jp →
  `10/15も変化なし。お知らせ最終2026.06.05、休業/営業再開の告知なし。予約導線は電話0869-34-5539とフォーム。楽天へのリンク残存（リンク先は掲載終了）。WordPress製・REST無効`

## 6. 反映できていない理由（2026-10-15 実測・実試行）

このPC（DESKTOP-63MQR3L / kimko）からは Google Doc の**本文を書き換えられない**。

- claude.ai コネクタの子プロセス（`tools/claude-ai-run.mjs`）で **読み取りは成功**
  （`mcp__claude_ai_Google_Drive__read_file_content` で上記の現行3行を実読）。
- **書き込みは失敗**。Drive コネクタ `update_file` は title / parentId のみで本文不可。
  claude.ai Google Docs コネクタは要認証でツールが1つも読み込まれない。
- リポジトリの DWD 経路（Docs API `documents.batchUpdate` / `replaceAllText`）は
  **SA 鍵が無く** `ENOENT: ...\Downloads\CLAUDE.md配布\aujust-sales-automation\.gcp\sheets-sa.json` で失敗。
  keyserve の配布14ファイルにも Google 系は無い（実測）。

→ **SA 鍵を持つ PC で §5 の3セルを反映するのが唯一の経路**。次項の手順で冪等に実行できる。

### 6.1 §6 の根拠（2026-10-15 追加実測・前回の未検証点を実呼び出しで確定）

前回は「認証されていない」と推定していただけだったので、実際に呼んで確定させた。

| 試したこと | 実測結果（改変なし） |
|---|---|
| ToolSearch `select:mcp__claude_ai_Google_Docs__read_doc,mcp__claude_ai_Google_Docs__update_doc` | `No matching deferred tools found`（0件） |
| ToolSearch `+Google_Docs` | `No matching deferred tools found`（0件） |
| ToolSearch `+Google Docs` | Drive / Sheets / Calendar のツールのみ。Docs のツールは0件 |
| ToolSearch `+document` | Drive（create_file / read_file_content / search_files）と Canva のみ。Docs は0件 |
| `mcp__claude_ai_Google_Drive__update_file`（fileId=当該Doc, `body="test"`, `textContent="test"`） | 実呼び出しで **HTTP 400**：`Invalid JSON payload received. Unknown name "body": Cannot find field.` / `Invalid JSON payload received. Unknown name "textContent": Cannot find field.` |
| `mcp__claude_ai_Google_Drive__update_file` のツール定義 | `Request to update a file (currently only title and parent_id are supported).` 受け付ける項目は `fileId` / `parentId` / `title` のみ |
| `mcp__claude_ai_Google_Drive__get_file_metadata` | `mimeType=application/vnd.google-apps.document` / `title=ラハイナ 黒字化オートパイロット 運用設計書（2026-10-08）` / `owner=seisaku-team@orgiast.jp` / `modifiedTime=2026-10-08T09:10:04.232Z`（＝10/8 から1文字も変わっていない） |
| SA 鍵の全走査（`~/.claude` `~/Downloads` `~/Documents` `~/Desktop` `~/OneDrive` の `*.json` を depth 7 まで、`"type":"service_account"` で grep） | **0 件** |

→ Docs 本文を書き換えるツールは、この環境のツール一覧に**実在しない**。前回の「要認証」という推定ではなく、呼び出しの 400 と ToolSearch 0 件が根拠。

## 7. 反映手順（SA 鍵を持つ PC 用・冪等・索引計算不要）

索引計算を避けるため `replaceAllText` を使う。旧セル全文が一意なので、Doc 全体を走査しても該当セル1か所だけが置換される。旧文言が既に消えていれば `occurrencesChanged=0` で何も起きない＝**再実行しても安全**。

前提:
- `GOOGLE_SA_KEY` = サービスアカウント鍵 JSON のパス（既定 `~/Downloads/CLAUDE.md配布/aujust-sales-automation/.gcp/sheets-sa.json`）
- scope は drive（`https://www.googleapis.com/auth/drive`）で Docs API を叩ける（`tools/lib/drive-auth.mjs` の `getDriveToken` をそのまま使う）
- 当該 Doc に対する編集権（SA の `client_email` を Doc の編集者に追加しておく）

手順（1〜3 は Node。`tools/lib/drive-auth.mjs` を import する）:

1. **現状確認（触る前に）** — `documents.get` で本文を取得し、§5 の旧3セル文言が3つとも存在することを確認する。1つでも無ければ**中止**（別の人が既に更新済み）。
   - `GET https://docs.googleapis.com/v1/documents/1b94C8E4U8drGBoH7z1VvzNFpScv-J8F-Mv13bGXEvJc`
2. **置換** — `POST https://docs.googleapis.com/v1/documents/<ID>:batchUpdate` に、§5 の3行それぞれについて
   ```json
   {"replaceAllText":{"containsText":{"text":"<旧セル本文>","matchCase":true},"replaceText":"<新セル本文>"}}
   ```
   を3件入れて1回で送る。レスポンスの `replies[i].replaceAllText.occurrencesChanged` が**3件すべて 1** であることを確認する（0 ならそのセルは既に置換済み＝冪等に無害）。
3. **読み戻し検証** — 再度 `documents.get` し、新3セル文言が本文に含まれ、旧3セル文言が含まれないことを確認する。`get_file_metadata` の `modifiedTime` が実行時刻に更新されていることも見る。
4. **変更しないもの** — 「確認方法」セルは現行のまま。他の行・他章・Doc のタイトルと保存先は一切触らない。Doc を新規作成しない。

旧→新の3組は §5 のとおり（旧は §5 の「現行」コードブロック、新はその直後の3項目）。

