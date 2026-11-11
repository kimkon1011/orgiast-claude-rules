# X-0012 PHASE1: オージャスト既存サイト診断レポート

## 概要
AIニュース提案 X-0012「既存ページ解除とマルチソースでAI検索$506K」のPHASE1として、
orgiast.jp サイトの現状分析を実施しました。

## 調査内容
1. **全17種 sitemap 実測**（合計461URL）
2. **noindex/canonical/構造化データ 全ページ調査**
3. **Bing カバレッジ実測**（事例ページ cover率 ~5%）
4. **ギャップ分析 G1〜G6 特定**
5. **優先度付き実行計画**

## 主要発見
- ✅ noindex 問題なし（全ページ indexable）
- 🚨 canonical 全欠（全ページに `rel="canonical"` なし）
- 🚨 構造化データ 全欠（ChatGPT/Perplexity 発見に不利）
- 🚨 Bing カバレッジ ~5%（事例85件中 ~4件のみ）
- 🚨 SEO プラグイン = All in One SEO Pack 2.11（2012年版・非推奨）
- ✅ rebooth.co.jp も分析済み（同様の欠陥）

## 成果物
- `outputs/X-0012/README.md` — サイト構造分析・重大発見・優先度一覧
- `outputs/X-0012/gap-analysis.md` — G1〜G6ギャップ・Bing実測・実行計画

## 残（PHASE2〜3）
詳細は `outputs/X-0012/README.md` 参照。要 WordPress 管理者権限での実装。

🤖 Generated with [Claude Code](https://claude.com/claude-code)