# X-0056: 無料リソースとClaude Codeを使ったサイトデザインワークフロー

**AIニュース提案 X-0056**: Land-book、Godly、Recent Designで視覚方向を決定。Realtime Colors、Fontshareでデザインシステム構築。Lucide、SVGLでアイコン・ブランド資産。MotionSitesのプロンプトをClaude Codeに与えて開始。Shotsで完成品を提示。株式会社オージャストのイベントサイトでこれらのリソースを適用し、ブースギャラリーのUIをAIでコーディング。

観測日: 2026-11-18（出典: @RealMarvelX のX投稿）
確定日: 2026-11-20（本ドキュメント作成）

---

## 1. 概要

デザインインスピレーションからアイコン、プロンプトまでを組み合わせ、AIコーディングでプロ品質のウェブサイトを構築するワークフロー。全て無料のリソースを使い、Claude Codeを中心にコーディングまで完結させる。

### 全行程

```
[視覚方向] → [デザインシステム] → [アイコン/資産] → [AIコーディング] → [提示]
    1              2                   3                 4             5
```

---

## 2. 使用リソース一覧

### Phase 1: 視覚方向の決定

| リソース | 用途 | URL | 特徴 |
|---------|------|-----|------|
| **Land-book** | ランディングページのインスピレーション収集 | https://land-book.com | 高品質LPデザインギャラリー、フィルター検索可 |
| **Godly** | Webデザインの視覚的インスピレーション | https://godly.com | アニメーション・インタラクションに強い |
| **Recent Design** | 最新デザイントレンドの把握 | https://recentdesign.com | 日々更新、新技術を使ったデザイン多数 |

**ワークフロー**:
1. 各サイトで「展示会」「ギャラリー」「ポートフォリオ」をテーマに検索
2. 共通するカラーパレット・レイアウトパターン・タイポグラフィを3〜5件収集
3. 決定した方向性を1枚のムードボードにまとめる（Realtime Colorsで再現）

### Phase 2: デザインシステムの構築

| リソース | 用途 | URL | 特徴 |
|---------|------|-----|------|
| **Realtime Colors** | カラーパレット・UI要素のビジュアライズ | https://realtimecolors.com | リアルタイムプレビュー、カラーコントラスト検証 |
| **Fontshare** | オープンソースフォントの検索・選定 | https://fontshare.com | 品質厳選フォント、Google Fonts相互運用可 |

**ワークフロー**:
1. Phase 1で集めたインスピレーションからカラーパレットを抽出
2. Realtime Colorsでパレットを再現→コントラスト・アクセシビリティ検証
3. Fontshareで見出し用・本文用のフォントペアを選定
4. 決定したデザイントークン（色・フォント・余白・角丸）をCSSカスタムプロパティとして文書化

```css
:root {
  /* Realtime Colors で決定したパレット */
  --color-primary: #1a1a2e;
  --color-accent: #e63946;
  --color-bg: #f8f9fa;
  --color-text: #333333;
  --font-heading: 'Sentient', sans-serif;
  --font-body: 'Array', sans-serif;
  --radius-card: 12px;
  --space-unit: 8px;
}
```

### Phase 3: アイコン・ブランド資産

| リソース | 用途 | URL | 特徴 |
|---------|------|-----|------|
| **Lucide** | 高品質オープンソースアイコン | https://lucide.dev | SVGベース、カスタマイズ容易、一貫性高い |
| **SVGL** | SVGアイコンライブラリ | https://svgl.dev | ブランドアイコン（技術・SNS）に強い |

**ワークフロー**:
1. LucideからUI用アイコン（ナビゲーション、CTA、リストマーカー）を選定
2. SVGLからSNSアイコン・技術ブランドアイコンを収集
3. 選定したアイコンをスプライトシートにまとめ、CSSでの色変更に対応（currentColor推奨）
4. アイコン = Lucide / SVGL の2系統に統一（混在禁止）

### Phase 4: AIコーディング

| リソース | 用途 | URL/方法 | 特徴 |
|---------|------|---------|------|
| **MotionSites** | アニメーション・モーション参考 | https://motionsites.com | プロンプト例をClaude Codeに与えて開始 |
| **Claude Code** | UIコーディング全般 | — | コード生成・編集・検証を一貫実行 |

**ワークフロー**:
1. MotionSitesで目的の動作をしているサイトを検索
2. それらのプロンプト例（どんな指示で生成したか）を参考にClaude Code向けプロンプトを作成
3. Claude Codeに以下の要素を含むプロンプトを与える:
   - Phase 1-3 で決定したデザイントークン
   - Phase 2 のCSSカスタムプロパティ
   - Phase 3 のアイコンセット
   - MotionSitesの動きの説明
4. 生成されたコードを段階的に確認・修正

### Phase 5: 完成品の提示

| リソース | 用途 | URL | 特徴 |
|---------|------|-----|------|
| **Shots** | 完成品のスクリーンショット生成・共有 | https://shots.so | 美しいブラウザフレーム付きスクショ |

**ワークフロー**:
1. Phase 4で生成したUIが正しく動作することを確認
2. Shotsでデスクトップ表示・モバイル表示のスクリーンショットを生成
3. 生成画像をプルダウン/レビュー資料として添付

---

## 3. オージャスト適用: ブースギャラリーUIの設計

### 3.1 ブースギャラリーの要件

オージャストのイベントサイトに追加するブースギャラリーのUI要件:

1. **施工実績一覧表示**: サムネイルグリッド形式（3〜4列、レスポンシブ）
2. **フィルター機能**: 展示会名・年・規模・業種で絞り込み
3. **個別実績ページ**: 1件クリックで詳細表示（画像・仕様・コメント）
4. **AIクローラー対応**: 構造化データ・llms.txt連携
5. **パフォーマンス**: 画像はWebP/Next.js最適化、遅延読み込み

### 3.2 デザイントークン（案）

```css
:root {
  /* ブースギャラリー専用トークン */
  --gallery-grid-gap: 24px;
  --gallery-card-radius: 16px;
  --gallery-overlay-bg: linear-gradient(to top, rgba(0,0,0,0.6), transparent);
  --gallery-card-shadow: 0 4px 24px rgba(0,0,0,0.08);
  --gallery-filter-active: #e63946;
  --gallery-filter-bg: #f0f0f0;
  --gallery-transition: 300ms ease-out;
}
```

### 3.3 実装アプローチ

既存リソース活用:
- `tools/booth-case-study-gen.mjs` — ケーススタディ自動生成
- `data/booth-projects.json` — 施工実績データ
- `llms.txt` のエントリ連携

**実装ステップ**:

| Step | 内容 | 期待成果物 |
|------|------|----------|
| 1 | ギャラリーHTML/CSSテンプレート作成 | `apps/gallery/index.html` |
| 2 | フィルターJS実装 | 展示会名・年・規模フィルター |
| 3 | JSON-LD構造化データ生成 | schema.org/CreativeWork |
| 4 | パフォーマンス最適化 | WebP変換・Lazy loading |
| 5 | レスポンシブ対応 | モバイル1列→タブレット2列→デスクトップ4列 |

### 3.4 プロンプト例（Claude Code向け）

```
展示会ブース制作会社オージャストのブースギャラリーUIをコーディングしてください。

デザインシステム:
--color-primary: #1a1a2e;
--color-accent: #e63946;
--color-bg: #f8f9fa;
--gallery-grid-gap: 24px;
--gallery-card-radius: 16px;

データソース:
- data/booth-projects.json から読み込み
- 各ブース: サムネイル画像URL、展示会名、年、規模(小間数)、業種、1行説明

要件:
1. 3〜4列のカードグリッド（レスポンシブで1〜2列に縮小）
2. カードはホバーで影が深くなり、クリックで詳細表示
3. 上部にフィルターバー（展示会名・年・規模 でフィルター）
4. AIクローラー用にJSON-LDを埋め込み
5. 画像はloading="lazy"、WebP形式を優先

MotionSitesの参照:
- カードの浮き上がるアニメーション
- フィルター変更時のスムーズなトランジション
```

---

## 4. 期待効果

| 指標 | 現状 | 目標 | 測定方法 |
|------|------|------|---------|
| ブースギャラリー有無 | なし | 1ページ | `apps/gallery/index.html` 作成 |
| AI検索引用率 | 0%（ギャラリー未存在） | 掲載後3ヶ月で10件以上の引用 | AI citation heatmap |
| 直帰率（ギャラリー流入） | — | 50%以下 | Google Analytics |
| 施工実績からの問い合わせ | 現状ルート分散 | ギャラリー経由30%増 | Google Analytics events |

---

## 5. 既存X提案との関係

| X提案 | 内容 | X-0056（本ドキュメント）との関係 |
|-------|------|-------------------------------|
| **X-0014** | Grok Bot + Claude Code コーディング手順 | **基盤**。Claude Code を使った実装パターンを流用 |
| **X-0044** | ブース仕様生成 with Prompt Cache | **連携**。生成した仕様をギャラリーに表示 |
| **X-0056 (front-loaded content)** | AI引用を増やす前倒しコンテンツ構造 | **補完**。ギャラリー個別ページの情報構造を最適化 |
| **X-0053** | llms.txt/ai.txt基盤改善 | **連携**。ギャラリーをllms.txtに追加 |
| **X-0056 (Grok委譲)** | Grok→Cursor→Claudeトークンコスト管理 | **直交**。コーディング時のレーン選択に活用 |
| **X-0009** | SME展示会ブースデザイン5原則 | **内容連携**。ギャラリーカードにデザイン原則を反映 |

---

## 6. 実装状況

- [x] 提案採択（2026-11-18）
- [x] 本ワークフローの文書化（本ドキュメント、2026-11-20）
- [ ] Phase 1: 視覚方向の決定（ウェブサイトリポジトリ入手後）
- [ ] Phase 2: デザインシステム構築
- [ ] Phase 3: アイコン・ブランド資産選定
- [ ] Phase 4: AIコーディング（Claude Code + Codex）
- [ ] Phase 5: 完成品の提示・Shots生成
- [ ] 実際のオージャストイベントサイトへ統合

**備考**: 本提案の実施には[https://www.orgiast.jp/](https://www.orgiast.jp/)または[https://rebooth.co.jp/](https://rebooth.co.jp/)のウェブサイトリポジトリが必要です。本ドキュメントはリポジトリ入手後の実装ガイドとして使用します。

---

## 関連

- `docs/ai-news-x0009-sme-booth-design-5-principles.md` — ブースデザインの5原則
- `playbooks/booth-website-agent-skills-workflow.md` — ブースウェブサイト開発ワークフロー
- `tools/booth-case-study-gen.mjs` — ケーススタディ自動生成
- `data/booth-projects.json` — 施工実績データ