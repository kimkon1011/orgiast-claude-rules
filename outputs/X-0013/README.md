# X-0013: 既存ランキングページのAI補完SEO

## 概要
Google Search Console の実データを使い、既存ページの表示回数があるが記事にないクエリと10-30位のクエリを特定し、AIエージェントがページの一部分だけを補完するSEO施策。展示会ブース制作関連ページで「展示会ブース」クエリを補完する。

## 成果物

| 成果物 | 説明 |
|---|---|
| `tools/seo-content-complement.mjs` | SEOコンテンツ補完ツール（キーワードギャップ→補完提案→実行計画） |
| `tools/seo-content-complement.test.mjs` | テスト（6 tests PASS） |
| `skills/booth-kw-research/` | キーワードリサーチスキル（既存） |
| `outputs/X-0013/` | 出力成果物 |

## ワークフロー

```
booth-kw-research（キーワードリサーチ）
    ↓ keywords-priority.csv, content-gaps.md
seo-content-complement.mjs（補完提案生成）
    ↓ --gsc-csv <GSCエクスポート>
seo-complement-plan.json + seo-complement-plan.md
    ↓
WordPress編集（手動）→ GSC再インデックス申請
```

## 補完タイプ

| タイプ | 説明 | 適用条件 |
|---|---|---|
| `intro_rewrite` | 冒頭2段落の書き換え（核心質問に答える） | Transactional/Commercial意図、または冒頭が短い |
| `new_h2` | 新しいH2見出しセクションの追加 | H2が3未満、またはInformational意図 |
| `faq_section` | FAQセクションの追加 | FAQ未存在、またはInformational意図 |
| `inline_paragraph` | 表示回数があるクエリに対する1文追加 | GSC表示回数あり |
| `new_page` | 新規ページ作成 | 既存ページ未カバー |
| `internal_link` | 内部リンク強化 | 同一カテゴリページ間 |

## 使い方

```bash
# 1. キーワードリサーチを実行
node skills/booth-kw-research/run.mjs

# 2. SEO補完提案を生成（GSCデータあり）
node tools/seo-content-complement.mjs --gsc-csv gsc-export.csv

# 3. GSCデータなしでもキーワード分析のみ実行
node tools/seo-content-complement.mjs

# 4. キーワードCSVを指定
node tools/seo-content-complement.mjs --keywords-csv ./my-keywords.csv
```

## テスト

```bash
# 全テスト
node --test tools/seo-content-complement.test.mjs tools/seo-content-complement.test.mjs

# 既存booth-kw-researchテストも含めて
node --test skills/booth-kw-research/test/*.test.mjs tools/seo-content-complement.test.mjs
```

## 前提条件
- booth-kw-research が事前に実行されている（`skills/booth-kw-research/output/keywords-priority.csv` が存在すること）
- GSC CSV は Google Search Console からエクスポートしたCSV（query, impressions, clicks, position, page カラム）
- WordPress編集・GSC再インデックス申請は手動で行う
