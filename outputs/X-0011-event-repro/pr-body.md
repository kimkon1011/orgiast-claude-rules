## 概要

- オージャスト既存ページのスクリーンショットを参照したイベント情報ページを実装
- WorkBuddy Codeタブ向けの再現可能な設定・詳細プロンプトを整備
- デザイン比較、最適化、レスポンシブ、アクセシビリティ、操作検証を記録

## 検証

- `node --test outputs/X-0011-event-repro/prototype.test.mjs`
- `node --test tools/*.test.mjs`
- desktop 1440x1000 / mobile 390x844 のブラウザ表示
- モバイルメニュー、フォーム未入力・不正メール・正常入力

## 注記

WorkBuddyの認証済みアクセスはないため、WorkBuddy実行結果ではありません。投入パッケージとローカル生成・検証結果を明確に分離しています。外部依存、Claude API/モデルの新規利用、workflow変更はありません。
