# X-0011: gumツール SEOガイド — ギャップ分析

## ギャップ一覧

### G1: gum が Windows 非対応（要代替）
**深刻度**: 高
**詳細**: `github.com/ehmo/gum` は Linux/macOS のみ。Windows バイナリ未提供。
**対処**: Node.js Google API クライアント (`googleapis`) で Search Console・Google Ads API を直接呼ぶ。OAuth 認証フローは `aujust-sheets-reader.json` のクライアントを流用。
**実装**: `tools/gsc-keyword-finder.mjs`

### G2: Google Ads API (Keyword Planner) の認証スコープ不足
**深刻度**: 高
**詳細**: 既存 OAuth クライアント (`aujust-sheets-reader.json`) は Google Sheets / Drive スコープのみ。Google Ads API のスコープ (`https://www.googleapis.com/auth/adwords`) が不足。
**対処**: 
- Phase1: GSC データのみで運用（Keyword Planner は Phase2）
- 既存クライアントの OAuth consent screen に adwords スコープ追加が必要
**優先度**: Phase2 以降

### G3: WordPress 管理者権限
**深刻度**: 中
**詳細**: 記事公開には `wp/v2/posts` への POST 権限が必要。既存の WordPress ユーザー権限を確認。
**対処**: まず下書き保存で動作確認 → 公開権限確認 → 必要に応じて権限昇格依頼
**優先度**: Phase1 Step3

### G4: GSC API クォータ制限
**深刻度**: 低
**詳細**: Google Search Console API は 1日あたり 2,000 クエリ制限。1回の Keyword Finder 実行で 5-10 クエリ程度。
**対処**: 毎朝1回の実行で 10 クエリ以内に収める設計。問題なし。

### G5: 日本語SEOガイドの品質
**深刻度**: 中
**詳細**: 自動生成される SEO ガイドが展示会ブース業界に特化した専門性を持つ必要がある。一般的なSEO記事では価値が低い。
**対処**: Guide Generator のプロンプトに以下を組み込む:
- オージャストの実績・ノウハウを反映
- 展示会ブース業界の専門用語・トレンド
- 実際の施工事例への内部リンク
**優先度**: Phase1 Step2

### G6: 内部リンク先の実在確認
**深刻度**: 中
**詳細**: 生成した記事から既存の事例ページやブログへの内部リンクがリンク切れになるリスク。
**対処**: Internal Link Manager で sitemap.xml を参照し、実在するURLのみリンクする。定期的なリンクチェック。

### G7: コンバージョン計測
**深刻度**: 低
**詳細**: 「約10%がコンバート」を計測するにはお問い合わせフォームへの遷移計測が必要。
**対処**: Google Analytics / GSC の CTR データで効果測定。Phase2 で実装。

## 優先順位

| 優先度 | ギャップ | Phase |
|--------|---------|-------|
| P0 | G1 (gum代替実装) | PHASE1 |
| P0 | G5 (ガイド品質) | PHASE1 |
| P1 | G3 (WordPress連携) | PHASE1 |
| P1 | G6 (内部リンク管理) | PHASE1 |
| P2 | G2 (Keyword Planner) | PHASE2 |
| P2 | G4 (クォータ) | 運用監視 |
| P3 | G7 (コンバージョン計測) | PHASE2 |
