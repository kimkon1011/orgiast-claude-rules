## 概要

X-0065: カスタム技術SEOクローラーをPythonで構築。Requests/BeautifulSoup/Pandasを使用した軽量SEO監査ツール。

### 機能（全5STEP）

| STEP | 機能 | 実装 |
|------|------|------|
| STEP1 | ドメインURL入力と検証 | `argparse` CLI + URL正規化（scheme補完・フラグメント除去） |
| STEP2 | 内部リンク発見（重複回避） | BFS巡回 + `visited` set + `deque` キュー |
| STEP3 | HTML抽出 | BeautifulSoup lxmlパーサー |
| STEP4 | 技術チェック | HTTPステータス / タイトル欠落・重複 / H1 / canonical / noindex / 壊れたリンク |
| STEP5 | CSVエクスポート | 詳細CSV + サマリCSV（Pandas） |

### 使用方法

```bash
pip install requests beautifulsoup4 pandas lxml
python seo/x0065-tech-seo-crawler.py https://example.com --max-pages 50
```

### 出力

- `seo-reports/seo_crawl_detail_YYYYMMDD_HHMMSS.csv` — 全ページの技術メトリクス
- `seo-reports/seo_crawl_summary_YYYYMMDD_HHMMSS.csv` — 分析サマリ（1行）

### 自社利用シナリオ

株式会社オージャストの自社サイト、イベントページ、ブース関連ページのSEO監査に活用する。既存の `seo/` 配下のGA4/GSC分析ツール群と組み合わせて包括的なSEO最適化が可能。

🤖 Generated with [Claude Code](https://claude.com/claude-code)