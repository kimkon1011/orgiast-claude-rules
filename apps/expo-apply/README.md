# 海外企業向け 日本展示会出展受付サイト

海外の企業が日本国内で開催される展示会へ出展する際の相談を受け付けるWebページです。英語を既定言語とし、画面右上のボタンで日本語表示へ切り替えられます。公開先の想定URLは [https://rebooth.co.jp/en/expo-apply/](https://rebooth.co.jp/en/expo-apply/) です（本番反映は別途、金さんの確認後）。

依存パッケージはありません。問い合わせは Google Apps Script 経由で `seisaku-team@orgiast.jp` に届き、入力者には自動返信を送ります。来訪者向けの管理一覧はありません。

## 起動方法

リポジトリのルートで実行します。

```sh
python3 -m http.server 8000
```

[出展受付サイトを開く](http://localhost:8000/apps/expo-apply/)。ES Moduleを使うため、HTMLファイルを直接開かずHTTPサーバーを使ってください。

公開手順（ヘテムルへの配置、GASの接続、GA4）は [PUBLISH.md](PUBLISH.md) を見てください。マージや本番デプロイ、DNS変更はこのブランチでは行いません。

## 使い方

1. 言語切替（英語 ⇔ 日本語）で希望の言語を選択します。
2. フォームに会社名・国/地域・担当者名・メールアドレス・希望の展示会名・ブース規模・出展時期・必要サービス等を入力して送信します。
3. バリデーションエラーがある場合は該当項目の直下に理由を表示します。送信成功時は受付番号を表示し、入力アドレスへ自動返信が届きます。

## AI・検索クローラー向け公開情報

- `llms.txt` / `ai.txt` / `robots.txt` / `index.md` / `faq.html` / `research.html`
- `index.html` の canonical、og:url、JSON-LD、sitemap は本番の絶対URL（`https://rebooth.co.jp/en/expo-apply/`）を使います。

## 検証コマンド

```sh
node --check apps/expo-apply/expo-apply-core.mjs
node --check apps/expo-apply/config.js
node --test apps/expo-apply/test/expo-apply.test.mjs
```

## 出典

`apps/my-page` アプリケーション構成および設計パターンに準拠。
