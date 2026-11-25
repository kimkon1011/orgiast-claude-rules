# オージャスト実装計画: 製品デザイン用AIスキル8選

> 対象サイト: [orgiast.jp](https://orgiast.jp) — 展示会ブース制作会社
> 実装期間: 4週間（2026-11-11 〜 2026-12-09）

---

## 事前準備（Day 0）

```bash
# 全スキルの一括インストール（Claude Code 環境）
npx skills@latest install
npx skills add benjitaylor/skills --skill stageshow
npx skills add pbakaus/impeccable
npx skills add enesozturk/dimensional-drawing
npx skills add oil-oil/oil-ui
npx skills add emilkowalski/skills
npx skills add Leonxlnx/taste-skill
npx skills add cofoundy/brand-skills
claude mcp add awwwards -- npx -y awwwards-mcp

# wkhtmltopdf または Playwright の確認（Stageshow / Oil UI / Taste Skill が実ブラウザ撮影に使用）
npx playwright install chromium
```

**所要時間**: 〜10分（ブラウザダウンロード含む）
**要確認**: Node.js 20.19+（Stageshow）・Node.js 22+（Taste Skill）

---

## Phase 1: 既存UIの監査と可視化（Week 1: 11/11〜11/17）

### 1-a. Impeccable によるUI監査

```bash
# orgiast.jp のプロジェクトルートで初期化
cd /path/to/orgiast.jp
/impeccable init
/impeccable document   # 現在のビジュアルシステムを DESIGN.md に記録
```

**実行タスク**:
| # | コマンド | 対象 | 期待成果 |
|---|---------|------|---------|
| 1 | `/impeccable critique` | トップページ | スコア付きUXレビュー結果 |
| 2 | `/impeccable critique` | イベント事例一覧 | ギャラリーページの品質スコア |
| 3 | `/impeccable audit` | 全ページ | 技術品質レポート（アクセシビリティ・パフォーマンス） |
| 4 | `/impeccable polish` | 改善優先度高い箇所 | 自動修正後の差分 |

**成果物**: `docs/impeccable-audit-report.md`

### 1-b. Emil Kowalski アニメーション監査

```bash
/review-animations
```

**実行タスク**:
- 事例カードのホバーエフェクト（transform / opacity 使用か、300ms未満か）
- ページ間トランジション
- ハンバーガーメニューの開閉アニメーション
- prefers-reduced-motion 対応状況

**成果物**: `docs/animation-review-report.md`

### Phase 1 成果物
- `docs/impeccable-audit-report.md` — UI監査レポート
- `docs/animation-review-report.md` — アニメーション品質レポート
- 優先改善リスト（例: 「事例カードのホバーが transition:all を使用→transform/opacityに変更」）

---

## Phase 2: ブース紹介ページのリデザイン（Week 2: 11/18〜11/24）

### 2-a. Oil UI による方向性検討

```bash
/oil-ui "Design 3 directions for orgiast.jp event showcase page:
  Direction A: Card-grid layout with large hero images
  Direction B: Timeline layout with scroll-triggered animations
  Direction C: Map-based layout with region filtering
  Use orgiast's brand colors (#1a365d primary) and typography"
```

**比較ページに含める要素**:
- デスクトップ(1440×900)とモバイル(390×844)の両方
- 各方向のレイアウト・タイポグラフィ・カラースキーム・画像スタイル
- Playwright による実レンダリング撮影

**成果物**: `outputs/oil-ui-direction-comparison/`

### 2-b. Awwwards MCP による競合分析

```bash
# 展示会ブース制作会社・イベント制作会社の受賞デザインを検索
claude mcp awwwards search "exhibition booth design portfolio" --limit 5
claude mcp awwwards search "event agency showcase dark theme" --limit 5

# デザインブリーフ作成
claude mcp awwwards brief --name "Orgiast event page redesign" 
  --sites <site1-url>,<site2-url>,<site3-url>
```

**成果物**: 
- `docs/awwwards-competitor-analysis.md`
- デザインブリーフ（カラーパレット・テクノロジースタック・デザイン要素の抽出結果）

### 2-c. Stageshow によるヒーローアニメーション

```bash
/stageshow "A small looping demo for orgiast.jp event showcase hero:
  Moment 1: Re:booth flat-packed modules arriving
  Moment 2: Modules assembled into a full booth
  Moment 3: Visitors engaging with the booth
  3 moments, 10-12 seconds.
  Use orgiast brand colors (#1a365d primary, #e2e8f0 background).
  Generate both desktop and phone versions."
```

**成果物**: `components/HeroDemo.tsx`（Reactコンポーネント）
**品質基準**: Stageshow のリハーサル通過（撮影・チェックに合格するまで自動修正）

### Phase 2 成果物
- Oil UI 比較ページ（3方向 × 2ビューポート = 6枚の実レンダリング）
- Awwwards MCP 競合分析レポート
- Stageshow ヒーローアニメーションコンポーネント

---

## Phase 3: 高品質LPの構築（Week 3: 11/25〜12/1）

### 3-a. Taste Skill による「イベントプロデュース」LP

```bash
/taste-skill "Build a professional landing page for Orgiast's Event Produce service.
  Target: C-suite executives planning internal events (shareholder meetings, 
  kickoffs, anniversary parties).
  Key selling points: 500+ exhibition projects, Re:booth sustainable system,
  IPO gong rental (30% market share), online event support.
  Include real photography from or from open archives.
  Two-viewport check: 1440px and 390px."
```

**Taste Skill ビルドプロセス**:
1. クライアント詳細の棚卸し（オージャストの強み・実績・ターゲット）
2. デザイン方向のディーリング（Awwwards MCP の分析結果を反映）
3. 実コピーライティング（SEOキーワード「社内イベント 企画」「展示会 ブース 制作」を考慮）
4. 実写真の配置（オープンアーカイブ写真＋自社撮影のブース写真）
5. ブラウザ実検証（1440/768/390px）
6. Awwwards加重ルーブリック採点（デザイン40%・操作性30%・創造性20%・内容10%）

**成果物**: 
- LPコンポーネント一式（React/Next.js）
- Taste Skill スコアレポート
- 人間調整ポイント一覧

### 3-b. Brand Identity パイプライン

```bash
# cofoundy/brand-skills フルパイプライン
/naming "Orgiast brand naming audit"
/brand-architecture "Service structure: Event Produce, Creative Production, Re:booth"
/brand-identity "Corporate identity - navy #1a365d, clean sans-serif"
/brand-voice "Professional, warm, innovative - B2B internal event specialist"
/brand-guidelines "Generate comprehensive brand guidelines document"
/brand-audit "Audit current orgiast.jp against guidelines"
```

**成果物**: `docs/orgiast-brand-guidelines.md`

### Phase 3 成果物
- Taste Skill 生成LP（現行版と比較可能な形で保存）
- ブランドガイドラインドキュメント
- 現行サイトのブランド監査結果

---

## Phase 4: 仕様書統一とCI統合（Week 4: 12/2〜12/9）

### 4-a. Dimensional Drawing によるRe:ブース仕様書

```bash
/dimensional-drawing "Re:booth modular exhibition system spec sheet:
  - Frame module (aluminum, 3 sizes)
  - Panel module (5 colors, printed or matte)
  - Lighting module (spot, wash, LED strip)
  - Graphics module (magnetic, adhesive, hanging)
  Architecture over content: use slots [TBD] for actual values."

# モーション版を生成
/dimensional-drawing-motion
```

**成果物**: `outputs/rebooth-spec.html`（単一HTMLのApple風仕様書）
`outputs/rebooth-spec-motion.html`（アニメーション版）

### 4-b. CIパイプラインへの品質ゲート統合検討

**検討内容**:
- Impeccable の critique/audit を CI で自動実行 → PR にコメント
- Emil Kowalski review-animations を差分アニメーションのチェックに使用
- Dimensional Drawing の仕様書自動生成 → デプロイ時に最新版を生成

**Phase 4 成果物**: `docs/ci-quality-gate-proposal.md`

---

## ロードマップ

| 週 | マイルストーン | 成果物数 | 人間調整時間（見積） |
|---|---------------|---------|-------------------|
| Week 1 | UI監査完了・改善リスト確定 | 2 report | 2時間（改善優先度判断） |
| Week 2 | リデザイン案選択 | 6 レンダリング + 1 コンポーネント | 3時間（方向性選択） |
| Week 3 | LP初版完成 + ブランドガイドライン | 1 LP + 1 ガイドライン | 4時間（コピー調整・写真選定） |
| Week 4 | 仕様書統一 + CI設計書 | 2 仕様書 + 1 提案書 | 2時間（CI導入判断） |
| **合計** | | | **約11時間** |

## 期待効果（週次基準）

| 指標 | 現状 | Week 1 | Week 2 | Week 3 | Week 4 |
|------|------|--------|--------|--------|--------|
| UI品質スコア | 未測定 | ベースライン取得 | +15% | +30% | +40% |
| デザインリサーチ時間/回 | 2.5h | 2.0h | 1.0h | 0.5h | 0.3h |
| アニメーション基準準拠率 | 未測定 | ベースライン | +40% | +70% | +90% |
| 提案書作成時間/件 | 6h | 6h | 4h | 2h | 1h |

## リスクと対策

| リスク | 確率 | 影響 | 対策 |
|-------|------|------|------|
| Node.js バージョン不足 | 中 | Stageshow/Taste Skillが動作しない | `nvm use 22` で事前確認 |
| スキルコマンドの競合 | 低 | /critique 等が複数スキルで定義 | 単体導入で検証→競合時はスキル名プレフィックスで呼出 |
| 人間調整時間の不足 | 中 | AI生成品をそのままリリース | 週次レビュー会を設定し、調整時間を確保 |
| Playwright ブラウザ不在 | 低 | 実ブラウザ検証がスキップ | CIパイプラインで事前インストール |