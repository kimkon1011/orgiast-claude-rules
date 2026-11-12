# AIニュース提案: サイト欠点分析からClaude Codeでウェブを量産するパイプライン

- **ステータス**: 設計・適用検証完了（2026-11-13）
- **AIニュース提案**: ビジネスサイトの欠点（デザイン劣化・低速度・モバイル非対応・コンテンツ不足）を自動分析し、Claude Code＋Cloudflare Pagesで修正版Webを量産・改善提案するパイプライン
- **出典実績**: 12ヶ月で約200ウェブ販売（欠点指摘からのアウトリーチ＆AIビルド）
- **オージャスト適用**: 競合ブース制作会社サイトの欠点分析（モバイル最適化・表示速度・SEO事例ページ欠落・構造化データ非対応）を行い、株式会社オージャストの自社サイト（orgiast.jp）および提案ランディングページ群を自動改善

---

## 1. 概要とビジネスモデル

本パイプラインは、既存Webサイトの定量的・定性的欠点を自動検出・視覚化し、AIビルド（Claude Code）によって即座に代替サイト・改善ページ群を構築、Cloudflare Pages等のエッジホスティング環境へデプロイして提案・改善を行う一連のプログラマブルなワークフローである。

### パイプラインの3大特徴

1. **欠点起点のアウトリーチ＆改善**:
   - Apollo等で企業の連絡先・担当者を特定し、監査ツール（Lighthouse API / PageSpeed Insights / Ahrefs）でサイトの欠点を定量計測。
   - 「表示速度スコア42点」「モバイル未対応」「事例ページなし」といった具体的な欠点をレポート化してアプローチ。

2. **Claude Codeによる自動ビルド＆量産**:
   - 既存サイトの構造・コンテンツを抽出し、モダンなコンポーネント構成（HTML5/CSS3/Vanilla JS/React/TypeScript）で再設計。
   - レスポンシブ化・SEO最適化・構造化データ（JSON-LD）自動付与を実施。

3. **Cloudflare Pagesへの即時ホスティング**:
   - GitHubリポジトリ連動またはCloudflare Direct Upload（Wrangler）により、コスト$0で超高速なグローバルCDN上にデプロイ。

---

## 2. システムアーキテクチャとツールチェーン

```
 [ターゲット収集 (Apollo / Web)]
              ↓
 [サイト欠点監査 (Lighthouse / PageSpeed / Ahrefs)]
              ↓
 [欠点レポート ＆ 改善プラン生成 (Node.js / site-deficiency-analyzer)]
              ↓
 [Claude Code によるWebページ/LP自動生成]
  ├─ モバイル・レスポンシブ最適化 (CSS Grid / Flex / Clamp)
  ├─ 表示速度最適化 (WebP画像 / インラインCSS / 非同期JS)
  └─ SEO事例・構造化データ付与 (JSON-LD FAQPage / Service)
              ↓
 [Cloudflare Pages デプロイ & 顧客提案 / 自社サイト改善]
```

### ツールチェーン構成

| 役割 | 採用ツール / ライブラリ | 目的 |
|---|---|---|
| リード・担当者特定 | Apollo.io API / B2Bディレクトリ | 意思決定者のメール・連絡先取得 |
| サイト欠点監査 | Lighthouse API / PageSpeed / Ahrefs | モバイル適合性・表示速度・SEO欠陥の数値化 |
| サイト改善プロンプト/解析 | `tools/site-deficiency-analyzer.mjs` | サイト欠点スコアの算出と改善提案自動作成 |
| コード生成 | Claude Code / Codex | レスポンシブ対応Web・事例ページの量産 |
| デプロイ・ホスティング | Cloudflare Pages / Wrangler | 低遅延・高セキュリティ・無料枠ホスティング |

---

## 3. 株式会社オージャストでの適用手順（競合分析＆自社改善）

株式会社オージャスト（展示会ブース企画・設計・施工一貫サービス）において、競合ブース制作会社のサイト欠点を分析し、自社Web資産のSEO・モバイル・事例ページを自動改善する実践手順。

### Step 1: 競合ブース制作会社サイトの欠点分析

競合他社（A社・B社・C社等）のWebサイトを `site-deficiency-analyzer` にて計測:
- **モバイル非対応/表示崩れ**: フォームや画像が画面外にはみ出す
- **表示速度の遅延**: 未圧縮画像によりLighthouse Performanceが40点以下
- **事例ページのコンテンツ不足**: 写真のみでテキスト解説・費用感・施工期間の記載がない
- **構造化データ（JSON-LD）の欠落**: Google / AI検索エンジンへの情報提供が未整備

### Step 2: 自社サイト（orgiast.jp）および提案LPの改善パイプライン

1. **事例ギャラリー/ケーススタディページの自動生成**:
   - 競合が「写真1枚」で済ませている部分に対し、3Dパース・費用帯（50万〜300万）・施工期間・金属加工技術の特徴を網羅した事例ページをClaude Codeで量産。

2. **モバイルファースト最適化**:
   - タブレット・スマートフォン閲覧時のタップ領域（48px以上）、LCP/CLSの改善。

3. **AI Search (LLMO) / SEO対応**:
   - FAQPageおよびService/OrganizationのJSON-LDを完全付与し、Search Console / ChatGPT / Gemini での引用率を向上。

---

## 4. 実行ツールと検証実績

本リポジトリに実装された `tools/site-deficiency-analyzer.mjs` により、サイト欠点の定量スコアリングおよび改善レポートの自動作成が可能。

- 実行コマンド: `node tools/site-deficiency-analyzer.mjs --target https://www.orgiast.jp`
- テスト実行: `node --test tools/site-deficiency-analyzer.test.mjs`
- 出力検証: `outputs/X-0022/site-deficiency-analysis-report.json`

---

**Why:** 12ヶ月で約200サイトを販売した実証モデルをベースに、オージャストの展示会ブース制作事業へ適用可能なWeb欠点分析・量産パイプラインを定義した。
