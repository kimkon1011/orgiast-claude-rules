## 概要

AIニュース提案 [X-0029]: Ahrefs監査をAIでSEO優先度付け

Ahrefs Site Audit のエラー一覧と Search Console のページ別データを統合し、AIによる修正優先度判定を行うツールを実装した。

## 変更内容

### 新規ファイル

| ファイル | 説明 |
|---------|------|
| `seo/ahrefs-gsc-priority.mjs` | Ahrefs × GSC 統合・優先度判定ツール |
| `outputs/X-0029/README.md` | プロジェクトドキュメント |
| `outputs/X-0029/sample-ahrefs.csv` | Ahrefs Site Audit サンプルデータ（15件） |
| `outputs/X-0029/sample-gsc.csv` | Search Console サンプルデータ（10件） |
| `outputs/X-0029/sample-output.md` | サンプルデータ実行結果 |
| `outputs/X-0029/orgiast-schema-audit.md` | www.orgiast.jp スキーマ監査結果 |

### 優先度判定ロジック

スコア = 重大度(Error=3 / Warning=2 / Notice=1) × 検索流入(高=3 / 中=2 / 低=1) × 影響範囲(高=3 / 中=2 / 低=1)

- 🔴 緊急 (score≧18): 直ちに修正
- 🟠 高 (score≧9): 優先的に修正
- 🟡 中 (score≧4): 計画的に修正
- 🟢 低 (score<4): 余裕のあるときに

### サンプル実行結果（15件）

- 🟠 高: 2件（トップページmeta description欠如 / 問い合わせページリンク切れ）
- 🟡 中: 7件（H1欠如・タイトル重複・速度・alt属性等）
- 🟢 低: 6件（4xxエラー・ディレクトリリスティング・OGP不足等）

### www.orgiast.jp スキーマ監査

- ✅ Organization / WebSite / FAQPage: すべてパス
- ⚠️ 推奨欠落: logo, description, potentialAction
- ⚠️ All in One SEO Pack v2.11（2016年）使用中

## ブロッカー

本番データでの実行には以下が必要:
1. Ahrefs Site Audit CSVエクスポート（手動 or API）
2. Search Console SA鍵 (sheets-sa.json) 配置

## テスト

```bash
# サンプルデータ生成
node seo/ahrefs-gsc-priority.mjs --sample

# サンプル実行
node seo/ahrefs-gsc-priority.mjs --ahrefs outputs/X-0029/sample-ahrefs.csv --gsc outputs/X-0029/sample-gsc.csv
```

🤖 Generated with [Claude Code](https://claude.com/claude-code)
