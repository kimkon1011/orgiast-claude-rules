# 生成・検証記録

検証日: 2026-11-09（Asia/Tokyo）

## 実行範囲

- WorkBuddy: 認証済みアクセスなし。実行未実施。投入設定とプロンプトのみ再現可能な形で作成。
- ローカル生成: HTML/CSS/Vanilla JSで実装。ネット接続なしで表示・操作可能。
- 入力: `orgiast-event-desktop.png` を目視確認し、ブランドの視覚文法を抽出。

## デザイン比較・最適化テーブル

| 対象 | 参照スクリーンショット | ローカル生成結果 | 意図した差分 | 最適化 |
|---|---|---|---|---|
| ヘッダー | 黒地、ロゴ、二段リンク、電話 | 黒地、ロゴ風文字、単段ナビ、電話 | イベントLPで迷わせない導線へ整理 | 850px以下で開閉メニュー化 |
| ブランド色 | 黒・白・明るいシアン | 同系統の黒・白・#00afd5 | 出典ページとの連続性を維持 | CSS変数へ集約 |
| 情報階層 | 大見出し後にサービス一覧 | 日時・会場・参加条件をファーストビューに集約 | 詳細ページの意思決定を優先 | dl/time/address等の意味要素を使用 |
| レイアウト | 中央固定幅、2列サービス | 最大1080px、2列と3列を用途別利用 | 現代的な可変幅へ更新 | 850px/520pxで段階的に1列化 |
| 写真表現 | 円形の実写多数 | CSS構成の抽象ブース3点 | 著作権不明の画像転用を回避 | 外部アセット0件、描画負荷を抑制 |
| 区切り | 点線、細線 | 点線タイムライン、細線 | ブランド文法を継承 | 背景差だけに依存しない |
| 地図 | 参照画面にはなし | HTML/CSS模式図＋住所 | 外部APIなし要件を満たす | role=imgと代替説明を付与 |
| フォーム | 参照画面にはなし | ラベル、必須表示、検証、status | 申込導線を実働化 | 外部送信なしを画面内に明記 |
| アクセシビリティ | 画像からは判定不能 | skip-link、ランドマーク、フォーカス、reduced-motion | 操作可能性を要件化 | JSでaria-expanded/invalidを同期 |

## ファイルと外部依存

`index.html` はローカルの `styles.css` と `app.js` のみ参照します。外部URL、iframe、Webフォント、API、LLM SDKは使用していません。JavaScriptからネットワーク送信する処理もありません。

## ブラウザ検証

Google Chrome（headless）で `file:///.../index.html` を直接開いて検証した。

| 項目 | 条件 | 結果 |
|---|---|---|
| Desktop表示 | 1440 × 1000、フルページ撮影 | Pass。`desktop-preview.png` を生成 |
| Mobile表示 | 390 × 844、フルページ撮影 | Pass。`mobile-preview.png` を生成 |
| 横方向オーバーフロー | 390px幅で `scrollWidth <= clientWidth` | Pass |
| モバイルメニュー | ボタン押下→表示→Programリンク押下 | Pass。`aria-expanded` が false→true→false |
| 必須入力 | 全項目空で送信 | Pass。エラー表示後、先頭エラーへフォーカス |
| メール形式 | `invalid` で送信 | Pass。形式エラーを表示 |
| 正常入力 | 会社名・氏名・有効なメールを入力 | Pass。外部送信しない旨を `role=status` に表示 |

再検証コマンド: `node outputs/X-0011-event-repro/browser-verify.mjs`

## 自動テスト

- `node --test outputs/X-0011-event-repro/prototype.test.mjs`: 3 pass / 0 fail
- `node --test tools/*.test.mjs`: pass / 0 fail（終了コード0）
