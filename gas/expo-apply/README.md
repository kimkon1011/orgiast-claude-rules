# expo-apply 問い合わせ受信（Google Apps Script）

海外企業向け出展フォームの送信先です。通知は `seisaku-team@orgiast.jp`、入力者には自動返信を送ります。

## デプロイ（本番公開の前に、金さんの確認後）

1. このディレクトリで `clasp login` と `clasp create --type webapp --title expo-apply`（未作成の場合）。
2. `clasp push`
3. 画面からウェブアプリとして導入する。
   - 実行するユーザー: 自分（できれば `seisaku-team@orgiast.jp` で送信できるアカウント）
   - アクセスできるユーザー: 全員（ログイン不要）。海外からの送信に必要です。
4. 発行された `/exec` URL を `apps/expo-apply/config.js` の `FORM_ENDPOINT` に入れる。
5. パスワードやトークンの値はリポジトリに書かない。

ローカル確認: `clasp` の再デプロイ後、フォームから自社アドレスで1通だけ送って inbox を確認する。
