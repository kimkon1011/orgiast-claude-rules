# X-0029: Ahrefs監査をAIでSEO優先度付け — orgiast.jp 適用編

観測日: 2026-11-12 | 出典: AIニュース提案 [X-0029] Ahrefs監査をAIでSEO優先度付け
本稿は「株式会社オージャストの展示会ブース制作サイト www.orgiast.jp にX-0024の優先度判定ツールを適用し、実際のSEO・UI関連エラーの修正優先度を判定する」ための手順書および実測結果を文書化したもの。

## 概要

Ahrefs Site Audit で発見されたエラー・警告（1,746件）を Google Search Console のページ別データと統合し、AIによる修正優先度判定を行うワークフローを確立した。本稿ではX-0024で開発したツール `seo/ahrefs-gsc-priority.mjs` を実際のサイトに適用する手順を記述する。

## 適用対象サイト: www.orgiast.jp

| 項目 | 内容 |
|------|------|
| URL | https://www.orgiast.jp |
| CMS | WordPress (PHP 7.4.33, Apache) |
| SEOプラグイン | All in One SEO Pack v2.11 (2016年リリース) |
| 構造化データ | Organization / WebSite / FAQPage (JSON-LD) |
| GA | UA-26359261-1 (ユニバーサルアナリティクス) |
| GTM | GTM-PF9V8SR |
| スライダー | Smart Slider 3 |

## ワークフロー

### Step 1: データ収集

```bash
# Search Console データエクスポート（SA鍵必要）
node seo/export-search-console.mjs --site "sc-domain:orgiast.jp" --days 90

# Ahrefs Site Audit → CSVエクスポート（手動）
# Ahrefsダッシュボード > Site Audit > Export > CSV
```

**ブロッカー**: Search Console SA鍵 (`sheets-sa.json`) がこのPCに存在しない。
代替: BigQuery一括エクスポート（推奨）または手動CSVエクスポート。

### Step 2: 優先度判定

```bash
node seo/ahrefs-gsc-priority.mjs \
  --ahrefs seo/data/ahrefs-sample-errors.csv \
  --gsc seo/data/gsc-sample-pages.csv \
  --output outputs/X-0029/priority-table.md
```

### Step 3: 結果の確認と修正実行

出力された優先度テーブルに基づき、P0（緊急）から順に修正を実施する。

## 構造化データ監査結果（実測）

www.orgiast.jp のスキーママークアップを `tools/schema-audit.mjs` で実測:

| スキーマタイプ | 必須項目 | 推奨項目欠落 | 備考 |
|--------------|---------|------------|------|
| Organization | ✅ 全パス | logo | 住所・電話・設立日あり |
| WebSite | ✅ 全パス | description, potentialAction | SearchAction未設定 |
| FAQPage | ✅ 全パス | — | 3問3答 |

**問題点**:
1. **Organization.logo 欠落**: Google ナレッジパネルにロゴが表示されない
2. **WebSite.potentialAction 欠落**: サイト内検索のリッチリザルト非対応
3. **All in One SEO Pack のバージョン**: v2.11（2016年）で最新SEO要件に対応していない可能性

## www.orgiast.jp のSEO上の課題（スキーマ以外）

### タイトルとメタ記述の不一致

実際のページタイトル:
```
社内イベント企画プロデュース、オンラインイベント、クリエイティブ制作の株式会社オージャスト［東京・大阪・福岡］
```

メタディスクリプション:
```
オンラインイベント制作、社内イベントや社内レク、会社イベントに特化したプランニング会社。
```

**問題**: 両方とも「社内イベント」に偏っており、実際の主力事業である「展示会ブース制作」がSEO上のメインKWになっていない。展示会ブース制作の実績（万博パビリオン制作含む）が構造化データ内には記載されているが、タイトル・メタ記述に反映されていない。

### viewport 固定

```html
<meta name="viewport" content="target-densitydpi=device-dpi,width=1024px,...">
```
幅1024px固定でモバイルファーストではない。Googleのモバイルファーストインデックスにおいて不利。

### ページ構成

サイトマップ構造（2026-11-12時点）:
```
/                  トップページ（社内イベント中心）
/topics            トピックス
/newsrelease       ニュースリリース
/event             イベントプロデュース
/creative          クリエイティブ制作
/clients           クライアント
/company           会社概要
/recruiting        採用情報
/services/flow     お申し込みの流れ
/contactus         お問い合わせ
```

**欠落**: 展示会ブース制作の事例ページ（/case-studies/）が存在しない。
既存実績（C0056/C0062/C0068）がサイト上に未掲載。

## 優先度判定結果（モックデータ）

X-0024のツールでモックモード実行した結果:

| 優先度 | 件数 | 代表例 |
|--------|------|--------|
| P0-CRITICAL | 1件 | duplicate_title（52ページに影響） |
| P1-HIGH | 6件 | 5xx, missing_title, redirect_loop |
| P2-MEDIUM | 12件 | broken_link, missing_meta_description, duplicate_content |
| P3-LOW | 3件 | missing_h1, missing_og_tags |

**実際の1,746件のエラー・警告に対しては、Ahrefs CSVエクスポート後に同様の分析を実行する。**

## 推奨する修正順序（仮）

| 優先度 | 施策 | 期待効果 | 工数見積 |
|--------|------|---------|---------|
| 🔴 緊急 | サイトタイトルに「展示会ブース制作」を追加 | CTR改善・KW一致率向上 | 小（テキスト修正） |
| 🔴 緊急 | メタディスクリプションを展示会ブース制作中心に変更 | CTR改善 | 小 |
| 🟠 高 | 事例ページ（case-studies）の新設 | ロングテールKW獲得・被リンク増 | 大（コンテンツ制作） |
| 🟠 高 | Organization.logo のJSON-LD追加 | ナレッジパネル最適化 | 小 |
| 🟠 高 | WebSite.potentialAction（SearchAction）追加 | サイト内検索リッチリザルト | 小 |
| 🟡 中 | All in One SEO Pack → Rank Math / Yoast に更新 | 最新SEO機能 | 中 |
| 🟡 中 | viewport をレスポンシブ対応に修正 | モバイルファースト対応 | 中 |
| 🟢 低 | 画像alt属性の追加（12件） | アクセシビリティ・画像SEO | 小 |

## ブロッカー・前提条件

1. **Ahrefs Site Audit CSVエクスポート**: 手動またはAPIで取得する必要あり
2. **Search Console データ**: SA鍵 (`sheets-sa.json`) の配置が必要
   - 既定パス: `~/Downloads/CLAUDE.md配布/aujust-sales-automation/.gcp/sheets-sa.json`
   - または BigQuery 一括エクスポートを設定
3. **orgiast.jp のCMS権限**: WordPress管理画面の編集権限が必要（title, meta description, viewport 修正時）

## 参考

- X-0024: Ahrefs監査をAIで優先修正（ツール本体） → `docs/ai-news-x0024-ahrefs-gsc-priority.md`
- ツール: `seo/ahrefs-gsc-priority.mjs`
- スキーマ監査: `tools/schema-audit.mjs`
- Search Console エクスポート: `seo/export-search-console.mjs`
