---
name: transitions-ui
description: transitions.dev 互換のインタラクティブUIトランジションをオージャストのWebサイト（expo-apply等）に追加する。CSS変数ベースのモーショントークン、アクセシブルなアニメーション、3D booth previewを生成。
---

# インタラクティブUIトランジションスキル

## 目的
transitions.dev のトランジションパターンを、株式会社オージャストのWebサイト（特に `apps/expo-apply/` 展示会出展受付サイト）に適用する。CSS変数ベースのモーショントークン体系で一貫性を保ち、アクセシビリティ（prefers-reduced-motion）を確保する。

## 使用条件
- `npx transitions-dev add --free` が実行済み（またはスキップして自前の `.t-*` CSSを使用）
- ブラウザの `<style>` または `.t-*` CSSクラスを挿入できる環境
- transitions.dev Pro トランジションはライセンス未確認のため使用禁止

## トランジション一覧（Free／オージャスト適用可能）

| トランジション | `.t-*` クラス | 用途 |
|--------------|-------------|------|
| Card resize | `.t-card-resize` | ブースサイズ選択カード |
| Number pop-in | `.t-number-pop-in` | 統計数値表示 |
| Notification badge | `.t-notification-badge` | ステータス変更通知 |
| Text states swap | `.t-text-states-swap` | 多言語切替時のラベル |
| Menu dropdown | `.t-menu-dropdown` | ナビゲーション |
| Modal open/close | `.t-modal-open-close` | 詳細モーダル |
| Panel reveal | `.t-panel-reveal` | ブース内装プレビュー |
| Page side-by-side | `.t-page-side-by-side` | ビフォーアフター比較 |
| Icon swap | `.t-icon-swap` | 言語切替アイコン |
| Success check | `.t-success-check` | 申込完了表示 |
| Avatar group hover | `.t-avatar-group-hover` | チーム紹介 |
| Error state shake | `.t-error-state-shake` | バリデーションエラー |
| Input clear with dissolve | `.t-input-clear-dissolve` | フォームフィールド |
| Skeleton loader | `.t-skeleton-loader` | ローディング表示 |
| Texts reveal | `.t-texts-reveal` | ヒーローセクション |
| Tabs sliding | `.t-tabs-sliding` | サービス選択タブ |
| Shimmer text | `.t-shimmer-text` | 見出し強調 |
| Tooltip open/close | `.t-tooltip-open-close` | ヘルプツールチップ |
| 3D tilt | `.t-3d-tilt` | ブース3Dプレビュー |
| Dropdown menu morph | `.t-dropdown-morph` | アクションメニュー |
| Accordion | `.t-accordion` | FAQセクション |
| Toast open/close | `.t-toast` | アラートバナー |
| Like button | `.t-like-button` | フィードバック |
| Learn more hover | `.t-learn-more-hover` | CTAボタン |
| Checkbox check | `.t-checkbox-check` | サービス選択 |
| Spinning counter | `.t-spinning-counter` | 統計数値 |
| Number subtle change | `.t-number-subtle` | 金額表示 |
| Toggle | `.t-toggle` | 言語切替スイッチ |
| Thinking states | `.t-thinking-states` | AI処理中表示 |
| Reasoning stream | `.t-reasoning-stream` | AI推論表示 |
| Streaming text | `.t-streaming-text` | テキストストリーミング |
| Banner stacking | `.t-banner-stacking` | 通知バナー積層 |

## モーショントークン（CSS変数体系）

全てのトランジションは以下のCSS変数で調整する：

```css
:root {
  /* Duration */
  --t-duration-fast: 150ms;
  --t-duration-normal: 250ms;
  --t-duration-slow: 400ms;

  /* Easing */
  --t-easing-spring: cubic-bezier(0.34, 1.56, 0.64, 1);
  --t-easing-out: cubic-bezier(0.16, 1, 0.3, 1);
  --t-easing-in-out: cubic-bezier(0.65, 0, 0.35, 1);
  --t-easing-bounce: cubic-bezier(0.34, 1.56, 0.64, 1);

  /* Distance */
  --t-distance-sm: 4px;
  --t-distance-md: 8px;
  --t-distance-lg: 16px;

  /* Blur */
  --t-blur-sm: 4px;
  --t-blur-md: 8px;

  /* Scale */
  --t-scale-in: 0.95;
  --t-scale-out: 1.05;
}
```

## アクセシビリティ

全てのトランジションに以下を含める：

```css
@media (prefers-reduced-motion: reduce) {
  .t-* {
    transition: none !important;
    animation: none !important;
  }
}
```

## 使用例

### 1. ブースサイズ選択のカードリサイズ

```css
.booth-card {
  transition: transform var(--t-duration-normal) var(--t-easing-spring),
              box-shadow var(--t-duration-normal) var(--t-easing-out);
  transform: scale(1);
}
.booth-card:hover {
  transform: scale(var(--t-scale-out));
  box-shadow: 0 8px 24px rgba(0,0,0,0.12);
}
.booth-card.selected {
  transform: scale(1.02);
  border-color: var(--color-accent);
}
```

### 2. 申込完了のチェックマーク

```css
.t-success-check .check-path {
  stroke-dasharray: 50;
  stroke-dashoffset: 50;
  animation: t-draw-check 0.4s var(--t-easing-out) forwards;
}
@keyframes t-draw-check {
  to { stroke-dashoffset: 0; }
}
```

### 3. 3D tilt ブースプレビュー

```css
.t-3d-tilt {
  perspective: 800px;
  transform-style: preserve-3d;
  transition: transform var(--t-duration-normal) var(--t-easing-out);
}
.t-3d-tilt:hover {
  transform: rotateY(5deg) rotateX(3deg);
}
```

## 出力
- `apps/expo-apply/transitions.css` → 共通トランジションCSS定義
- `apps/expo-apply/booth-preview.html` → ブースインタラクティブプレビュー
- 各コンポーネントにインライン `<style>` または `class="t-*"` として適用

## AIエージェントへの指示

1. トランジションを追加する際は、`.t-*` 名前空間でCSSを定義する
2. `--t-*` CSS変数でduration/easingを指定する
3. `@media (prefers-reduced-motion: reduce)` 対応を必ず含める
4. 状態はDOM属性（aria-expanded等）で表現し、アニメーションだけに依存しない
5. transitions.dev のコードを直接コピーする場合は `samples/` を参照する
6. Pro トランジション（confetti-burst等）は使用しない