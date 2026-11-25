# 公開手順（本番前の確認用）

金さんの確認が終わるまで、本番反映とDNS変更はしない。

## 置き場所（推奨）

**`https://rebooth.co.jp/en/expo-apply/`**

rebooth.co.jp はヘテムル（GMO、WordPress 7 + Apache、カスタムテーマ `rebooth`）です。ネームサーバーは muumuu-domain、SPF に `_spf.heteml.jp` があります。`www` は本体へ 301 します。`en.rebooth.co.jp` のDNSレコードはまだありません（NXDOMAIN）。SSLは `rebooth.co.jp` と `www.rebooth.co.jp` のみです。

WordPress 標準の `.htaccess` は、実在するファイルやディレクトリを `index.php` に回しません。そのため **`/en/expo-apply/` に静的ファイルを置く**のが、DNS追加もサブドメイン用SSLもいらない方法です。今の `/en/` と `/en/expo-apply/` はどちらも 404 で空いています。

代替: `en.rebooth.co.jp` を Cloudflare などに向ける方法もありますが、DNS追加と証明書が必要です。社内方針では新規アプリは Cloudflare 寄りですが、今回は「REブースのドメインの下」という希望に合わせてパス配置を推奨します。

## 手順（確認後）

1. `gas/expo-apply` を `clasp` でウェブアプリ公開する。
   - 実行ユーザー: 自分（できれば `seisaku-team@orgiast.jp` から送れるアカウント）
   - アクセス: 全員（ログイン不要）
2. 発行された `/exec` URL を `apps/expo-apply/config.js` の `FORM_ENDPOINT` に入れる。秘密情報は書かない。
3. 必要なら同じファイルの `GA4_MEASUREMENT_ID` に測定IDを入れる。空ならタグは出ません。rebooth 本体には既に GTM があります。
4. `apps/expo-apply/` 一式をヘテムルのドキュメントルート直下 `en/expo-apply/` にアップロードする。
5. 日本語サイト（例: フッターやトップ）から英語ページへ案内を足す。
6. 自社アドレスで1通だけ送信し、`seisaku-team@orgiast.jp` への到着と自動返信を確認する。

パスワード、FTP、トークンの値はこの文書にもリポジトリにも書かない。
