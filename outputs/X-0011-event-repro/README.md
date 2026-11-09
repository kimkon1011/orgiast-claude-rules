# X-0011 イベント情報ページ・スクリーンショット再現

既存のオージャスト「イベントプロデュース」ページのスクリーンショットをデザイン参照として、展示会ブース制作セミナーのイベント情報ページへ再構成したローカル完結プロトタイプです。

## 起動

ビルドやネット接続は不要です。`index.html` をブラウザで直接開くか、このディレクトリで静的HTTPサーバーを起動します。

```powershell
python -m http.server 4173
```

`http://127.0.0.1:4173/outputs/X-0011-event-repro/`（リポジトリルートで起動した場合）を開きます。

## 成果物

| ファイル | 内容 |
|---|---|
| `orgiast-event-desktop.png` | 指定された入力例（既存サイトのスクリーンショット） |
| `workbuddy-prompt-event-page.txt` | WorkBuddy Codeタブへ再現投入できる設定・プロンプト |
| `index.html` / `styles.css` / `app.js` | 外部依存のない実働ページ |
| `desktop-preview.png` / `mobile-preview.png` | ローカル生成結果の実ブラウザプレビュー |
| `verification.md` | デザイン比較、最適化、レスポンシブ、操作検証の記録 |

## WorkBuddyとの区別

この環境ではWorkBuddyへの認証済みアクセスを確認できなかったため、WorkBuddy上で生成・実行したとは扱っていません。`workbuddy-prompt-event-page.txt` は、Website template、Frontend Developer + UI Designer、Hy4 high thinking、添付ファイル、レビュー出力までを再現できる投入パッケージです。`index.html` 以下は同じ仕様をローカルで実装・検証した成果です。

フォームはデモであり、入力内容を外部へ送信しません。地図・画像・フォントを含め、外部APIやCDNへの通信はありません。
