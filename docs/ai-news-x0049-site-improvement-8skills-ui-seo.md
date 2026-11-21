# X-0049: サイト改善Skills8選でUI/SEO点検 — Claude Codeで回す実務診断

**AIニュース提案 2026-11-20**: WebサイトのUI/SEOを体系的に改善するため、Claude Code Skillsとして実装された8つの診断スキルを紹介する。それぞれに「何を診断するか」「どう直すか」「展示会ブース制作サイト（株式会社オージャスト）でどこに適用するか」を記載する。5つのスキルは特に詳細な診断ポイントを明示し、残り3つは補完的な品質・パフォーマンス診断として全体をカバーする。

観測日: 2026-11-20

---

## エグゼクティブサマリ

| 項目 | 内容 |
|------|------|
| 本稿の目的 | Claude Code SkillsでWebサイトのUI品質・SEOを点検し、短時間で改善する実務手順を提供する |
| 診断できる範囲 | パフォーマンス・デザイン一貫性・アクセシビリティ・SEO・構造化データ・総合品質・WordPress最適化・モダンWeb標準の8分野 |
| オージャスト初手適用 | 見積フォーム→web-design-guidelines + better-accessibility、ブース事例一覧→seo-audit + schema |
| 期待効果 | 表示速度改善（LCP 20%減）、フォーム完了率向上、AI検索でのリッチリザルト表示獲得 |

---

## 8スキル一覧

| # | スキル名 | 種別 | 主な診断対象 | 難易度 |
|---|---------|------|-------------|-------|
| 1 | **web-perf** | パフォーマンス | 画像遅延読み込み・LCP・CLS・TBT | 低 |
| 2 | **web-design-guidelines** | UIデザイン | カラー一貫性・CTA導線・フォームエラー・Tab移動 | 低 |
| 3 | **better-accessibility** | アクセシビリティ | ダイアログフォーカス・スクリーンリーダー・コントラスト | 中 |
| 4 | **seo-audit** | SEO | クロール可否・タイトル・見出し・内部リンク・Site Search Console | 低 |
| 5 | **schema** | 構造化データ | JSON-LD（Organization/Event/FAQ/BreadcrumbList） | 中 |
| 6 | **web-quality-audit** | 包括監査 | 品質+セキュリティ+HTML文法の総合スコアリング | 低〜中 |
| 7 | **wp-performance** | WordPress最適化 | キャッシュ・プラグイン棚卸し・DBクエリ・画像WebP | 中 |
| 8 | **modern-web-guidance** | モダンWeb標準 | 最新のHTML/CSS/JSプラクティスの検索・適用 | 低 |

各スキルは `skills/<name>/SKILL.md` に実装されており、Claude Codeのスキルシステムから呼び出せる。

---

## 1. web-perf — 画像の遅延読み込みを切り分ける

### 診断ポイント

Lighthouse/PageSpeed API を実行し、画像の読み込みに関する2つの原因を切り分ける:

| 症状 | 読み込み自体の問題 | 開始待ちの問題 |
|------|------------------|--------------|
| 画像が遅い | ファイルサイズ大・圧縮不足・WebP未使用 | — |
| 画像が出るタイミングが遅い | — | `loading="lazy"` の効果範囲外・JSによる遅延初期化 |
| ファーストビューが遅い | LCP対象の画像が重い | ヒーロー画像のプリロード優先度不足 |

### 改善

- `loading="lazy"` は折りたたみ以下の画像に限定し、ファーストビュー画像は `fetchpriority="high"` または `<link rel="preload">` で先行読み込み
- WebP/AVIF 配信でファイルサイズを60%削減
- `content-visibility: auto` で描画ブロッキングを回避（modern-web-guidance 参照）

---

## 2. web-design-guidelines — フォームエラーとTab時のボタン識別

### 診断ポイント

#### フォームエラーの直す場所
エラー時に以下の3要素が揃っているか確認する:

| 要素 | あるべき状態 | よくある不備 |
|------|------------|------------|
| エラー位置 | 該当フィールドの近く（フィールド下部または右側） | ページ上部に一覧表示のみで該当フィールドが不明 |
| エラーメッセージ | 具体的な修正方法が分かる文言 | 「入力値が不正です」（何が不正か不明） |
| エラー箇所の特定 | 該当フィールドが赤枠+アイコンなどで可視化 | 色だけの変化（色覚障害者が判別不能） |

#### Tab時のボタン識別
Tabキー移動時に全ての操作可能要素（ボタン・リンク・入力欄）にフォーカスが当たり、現在地が目視で分かることを確認:

- `:focus-visible` でフォーカスリング（2px以上のコントラストのある枠）を表示
- Tab順序が視覚順序と一致している（`tabindex` 不使用）
- 送信ボタンの前に確認チェックボックスがある場合、Tabで辿れる

### 改善

```css
/* フォーカス表示のベース */
:focus-visible {
  outline: 2px solid #1a73e8;
  outline-offset: 2px;
}

/* エラーフィールドの視覚化（色＋アイコン） */
.field-error {
  border-color: #d93025;
  background: #fce8e6 url('data:image/svg+xml,...') no-repeat 8px 50%;
}
.field-error:focus-visible {
  outline-color: #d93025;
}
```

---

## 3. better-accessibility — ダイアログ閉鎖後のフォーカス復帰とスクリーンリーダー

### 診断ポイント

#### ダイアログ閉鎖後のフォーカス復帰
モーダルダイアログを閉じた後、フォーカスが開く前にあった要素に戻ることを確認:

| 操作 | あるべき状態 |
|------|------------|
| モーダルを開く | 開くトリガー（ボタンなど）からフォーカスがモーダル内部に移動 |
| モーダル内Tab | 閉じるボタン→入力欄→キャンセル→確定 のループ（フォーカストラップ） |
| Escキーで閉じる | モーダル消滅後、フォーカスが開く前のトリガー要素に復帰 |
| 確定ボタンで閉じる | 同上。次の操作（確認メッセージなど）に応じてフォーカスを適切な場所へ |

#### スクリーンリーダーへのエラー伝達

| 状況 | スクリーンリーダーでの伝え方 |
|------|---------------------------|
| フォーム送信エラー | `role="alert"` 付きエラー領域にフォーカスを移動 + `aria-live="assertive"` |
| バリデーションエラー | 各フィールドに `aria-describedby="error-{field}"` で紐付け |
| 操作成功 | `role="status"` + `aria-live="polite"` でトースト通知 |

### 改善

```html
<!-- モーダル開閉＋フォーカス管理の骨格 -->
<dialog id="estimate-dialog" aria-labelledby="estimate-title">
  <h2 id="estimate-title">見積もり依頼</h2>
  <!-- フォーム内容 -->
  <button onclick="closeAndReturnFocus()">送信</button>
</dialog>

<script>
const triggerBtn = document.querySelector('[data-open-dialog="estimate"]');
const dialog = document.getElementById('estimate-dialog');

triggerBtn.addEventListener('click', () => {
  dialog.showModal();
  // フォーカスをダイアログ内の最初の入力要素へ
  dialog.querySelector('input,button').focus();
});

dialog.addEventListener('close', () => {
  // フォーカスを開く前のトリガーに復帰
  triggerBtn.focus();
});
</script>
```

---

## 4. seo-audit — クロール可否・タイトル・見出し・内部リンク

### 診断ポイント

| 項目 | 診断内容 | OK基準 |
|------|---------|--------|
| クロール可否 | `robots.txt` + `<meta name="robots">` + `X-Robots-Tag` で重要ページがブロックされていないか | 全公開ページが `index, follow` |
| タイトル | 全ページで50〜60字・重複なし・キーワードが先頭寄せ | ユニークかつ内容を正確に要約 |
| 見出し | H1（1ページ1つ）→H2→H3 の階層スキップなし | H1がページ主題、H2以下が論理的なサブトピック |
| 内部リンク | 404リンクなし / 孤立ページなし / 重要ページへのリンクが3クリック以内 | サイトマップとパンくずで全重要ページに到達可能 |
| Search Console | インデックス件数・カバレッジエラー・クロック統計を確認 | エラー0・インデックス対象外の重要ページなし |

### 改善

- ブース事例詳細ページへの内部リンクをカテゴリ一覧＋人気順＋新着順で複数経路確保
- パンくずリスト（`BreadcrumbList` 構造化データ）を全ページに設置
- サイトマップを動的生成に切り替え、新規事例ページ公開時に自動反映

---

## 5. schema — JSON-LDを掲載内容と一致させる

### 診断ポイント

最も多いミスは「JSON-LDを実装したが実際のページ内容と一致していない」こと。以下の5点を確認:

| # | チェック項目 | 悪い例 | 良い例 |
|---|------------|--------|--------|
| 1 | Organization の name | 会社名とJSON-LDのnameが一致 | 正式名称でのみ統一 |
| 2 | Event の startDate | 終了した過去イベントも `startDate` に残っていない | 過去イベントは `EventStatusType.EventMovedOnline` など適切なstatusに |
| 3 | FAQPage の Q&A | ページに実際に表示されている質問だけを記述 | 非表示のFAQをJSON-LDだけに含めない |
| 4 | Review の rating | 実際の顧客評価値のみ（推測不可） | 実査アンケート結果のみ |
| 5 | BreadcrumbList の item | パンくず実際の導線とJSON-LDの配列が一致 | コード自動生成と同期 |

### 検証

```bash
# Google リッチリザルトテスト（curl + API）
curl -sS "https://search.google.com/test/rich-results?url=TARGET_URL"

# Schema.org バリデーション
curl -sS "https://validator.schema.org/validate?url=TARGET_URL&format=json"
```

---

## 6. web-quality-audit — 包括品質監査

パフォーマンス・アクセシビリティ・SEO・セキュリティ・HTML文法の5次元を同時に診断し、A〜Fのスコアカードを生成する。

### 特性
- 各次元のスコアをレーダーチャートで可視化
- P0（危険）→P2（推奨）の優先度分類
- 複数ツール（Lighthouse + axe-core + W3C Nu Html Checker + Security Headers）を統合

### オージャストでの使い方
サイト全体の品質を月1回の定期診断として実行。スコアトレンドを追跡し、改修の優先順位付けに使う。

---

## 7. wp-performance — WordPress最適化

WordPressサイトに特化したパフォーマンス改善。キャッシュ・画像・プラグイン・DBクエリ・テーマの5項目を診断する。

### 診断ポイント
- キャッシュ設定（サーバー・CDN・ブラウザ）が適切か
- 画像のWebP配信 + `loading="lazy"` が有効か
- 有効プラグインに重複機能・不要プラグインがないか
- N+1クエリ・インデックス不足が発生していないか
- 子テーマ利用 + `functions.php` のautoload最適化

### オージャストでの使い方
展示会実績一覧ページ（WordPress）で画像一括最適化を実行。重いギャラリープラグインを特定して代替案に切り替える。

---

## 8. modern-web-guidance — モダンWeb標準の検索・適用

Web技術の進化が速いため、トレーニングデータに古いパターンが含まれている問題を解決する。Google Chromeチーム公式のガイダンスをローカル検索し、最新の実装方法を取得する。

### 診断ポイント
- モーダル: `<dialog>` + `showModal()` が標準。古い自前実装の場合は切り替えを提案
- View Transitions: CSS `view-transition-name` でページ遷移アニメーションを簡潔に実現
- コンテナクエリ: `@container` でメディアクエリの代わりにコンテナ幅でデザインを適応
- フォーム: `input[type="date"]` + `autocomplete` 属性の最新推奨値を確認

### オージャストでの使い方
見積フォームの実装前に `modern-web-guidance` で `form design autofill` を検索し、最新のブラウザネイティブバリデーションと自動保管のベストプラクティスを取得してからコーディングを始める。

---

## オージャストでの適用計画

| 優先順位 | 対象ページ | 適用スキル | 内容 | 期待効果 |
|---------|----------|----------|------|---------|
| P0 | 見積もりフォーム | web-design-guidelines + better-accessibility | フォームエラー表示改善・Tab移動最適化・ダイアログフォーカス復帰 | フォーム完了率向上・スクリーンリーダー対応 |
| P0 | 問い合わせフォーム | web-design-guidelines + better-accessibility | 同上＋エラー時のスクリーンリーダー通知 | 問い合わせ離脱率低減 |
| P1 | ブース事例一覧 | seo-audit + schema | メタ情報最適化・JSON-LD（Event/CreativeWork）実装 | AI検索でのリッチリザルト獲得 |
| P1 | トップページ | web-perf | ヒーロー画像の遅延読み込み区別・WebP配信 | LCP 20%改善 |
| P2 | サイト全体 | web-quality-audit | 月1回の定期品質診断 | スコアトレンド監視 |
| P2 | WordPress管理画面 | wp-performance | プラグイン棚卸し・画像最適化 | 管理画面表示速度改善 |

### 実行手順

1. **初回（今週）**: 見積フォーム + 問い合わせフォームに `web-design-guidelines` と `better-accessibility` を適用
2. **次週**: ブース事例ページに `seo-audit` と `schema` を適用。JSON-LD実装後、Googleリッチリザルトテストで検証
3. **継続**: `web-perf` で月1回のパフォーマンス測定 + `web-quality-audit` で四半期ごとの総合診断

---

## 検証方法

各スキル適用後、以下で実効性を確認する:

| スキル | 検証方法 | 成功基準 |
|--------|---------|---------|
| web-perf | Lighthouse再計測 | LCP 20%以上改善・CLS変化なし |
| web-design-guidelines | 目視＋Tab操作 | フォーカス順序が論理的・エラー表示が具体的 |
| better-accessibility | axe-core + VoiceOver操作 | axe violation 0・読み上げ順序が視覚順序と一致 |
| seo-audit | Search Console + メタ抽出再実行 | カバレッジエラー0・title重複0 |
| schema | リッチリザルトテスト + curl検証 | JSON-LDエラー0・リッチリザルト表示確認 |