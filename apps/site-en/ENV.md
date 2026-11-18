# 環境実測（2026-11-18、公開GETのみ）

| サイト | WordPressの観測値 | PHPヘッダ | 最新Polylangの最低要件判定 |
|---|---|---|---|
| rebooth.co.jp | 7.1.4（トップのgenerator meta） | PHP/8.3.36 | WP/PHPとも満たす。ステージング検証後の導入候補 |
| www.orgiast.jp | 5.0.3（RSS generator、配信中コアアセットURLも一致） | PHP/7.4.33 | WPが不足。最新Polylangはこの観測環境へ導入不可 |

Polylang公式の現在の安定版は **3.9.2**、最低 **WordPress 6.8 / PHP 7.4**、Tested up to は7.1。公式原文と取得レスポンスは evidence/polylang-readme.txt と evidence/http.json に保存。
出典: https://plugins.svn.wordpress.org/polylang/trunk/readme.txt
補助確認: https://wordpress.org/plugins/polylang/

## 公開証拠と判定の限界

- https://rebooth.co.jp/ — generator: WordPress 7.1.4、X-Powered-By: PHP/8.3.36、Server: Apache。
- https://rebooth.co.jp/wp-json/ — REST index応答。**REST indexそのものがコア版数を示すとは主張しない。**
- https://rebooth.co.jp/wp-json/wp/v2/types — page/post/works/news/reviewsが公開。clientは非公開のためsitemapと描画HTMLを使用。
- https://www.orgiast.jp/ — generator metaなし、X-Powered-By: PHP/7.4.33、Server: Apache。HTTP Linkが https://www.orgiast.jp/wp-json/ をRESTベースとして示す。
- https://www.orgiast.jp/wp/wp-json/wp/v2/types — 404。WPファイルの設置ディレクトリ /wp/ と、公開RESTルートは別。
- https://www.orgiast.jp/wp-json/wp/v2/types — 200。page/post/topicsがREST公開。event/creative/interview/newsreleaseは公開typesに無くsitemapからGET。
- https://www.orgiast.jp/feed/ — generatorは https://wordpress.org/?v=5.0.3 。トップHTMLの https://c0.wp.com/c/5.0.3/ 配下コアCSS/JSとも一致。
- 公開値はキャッシュやヘッダの変更で実稼働版数とずれる可能性がある。管理画面の確認・ログインは実施していない。プラグインの古さやRESTの404だけを根拠に版数を推測しない。

全GETの時刻・HTTPステータス・ヘッダは evidence/http.json、本文は evidence/http/<URLのSHA256>.txt。サイトの公開レスポンスは保存したが、管理用資格情報は読んでいない。

## 導入方針

### Re:Booth

無料Polylangの最低要件を満たす。ただし、最低要件を満たすことはカスタムテーマ・既存プラグインとの互換性保証ではない。CPT・タクソノミーの言語設定、ヘッダー／フッター／CF7の対訳、URL・言語切替・hreflangをステージングで確認する。既存Universallyのアセットが公開HTMLにあることは確認できるが、管理画面上の有効状態や設定値までは断定しない。/en/ルーティングの競合を公開前に確認する。

### Orgiast

第一候補はバックアップとステージング検証を経たWordPress更新（6.8以上）後の無料Polylang導入。PHP 7.4.33は本プラグインの最低要件を満たすが、これはPHPの保守状態の保証とは別である。

更新が難しい場合は **英語の実体ページを /en/ 親ページ以下に作る方式** を採用候補とする。既存の日本語原稿に対応する英語ページを作り、親子関係で /en/company/、/en/services/flow/ などを保持。CPT相当の実績ページも /en/event/<id>/ などの階層を持つ固定ページとして作り、元投稿との対応表を別管理する。

テーマ functions.php の wp_head フックで、日本語IDと英語IDの明示的な対応表から、それぞれの get_permalink() を esc_url() した hreflang="ja" / hreflang="en" を出す。両言語で相互参照し、各ページのcanonicalは自身を指す。言語切替も同じ対応表を使う。request URIを機械的に置換して存在しない英語URLを生成しない。更新追従とアーカイブ・タクソノミーの管理は手作業になる。

旧Polylangを選ぶ場合は、対象タグのRequires at least / Requires PHPと修正履歴を個別確認する必要がある。今回、5.0.3向けの旧版の安全性は確認しておらず、具体版の導入推奨はしない。

## 公開時の注意事項（今回は未実行）

- apps/expo-apply/ と本番 /en/expo-apply/ は対象外。英語ページの対応表にも含めていない。
- 本番のログイン・POST/PUT・プラグイン導入・テーマ編集・ページ作成は一切していない。
- en/*.en.json は本文がREST由来か描画main由来かを source 側の _content_origin で判別する。描画mainの成果物を、そのままWPのpost_contentに投入するとテーマ側の見出しやパンくずが二重になる可能性がある。インポート時に原稿・テーマ・カスタムフィールドへ分けて適用する。
- JavaScript内の文言、画像内文字、フォーム送信後にのみ表示されるメッセージは、今回のGETと文字列置換だけでは公開品質を保証できない。template-strings.*.json の unverified を確認する。

