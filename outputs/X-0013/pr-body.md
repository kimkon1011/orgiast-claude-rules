# X-0013: 再現可能AIワークフローの7リポジトリ

AIニュース提案 X-0013「LangGraph・n8n・LiteLLM・Pydantic AI・promptfoo・Phoenix・FastMCP — 再現可能AIワークフローの7リポジトリ」の設計文書と実装計画。

## 変更内容

### 新規ファイル
- `docs/ai-news-x0013-reproducible-ai-workflows.md` — 7ツールの概要・連携アーキテクチャ・3ユースケース・4週間実装計画
- `outputs/X-0013/README.md` — 出力ディレクトリ解説
- `outputs/X-0013/pr-body.md` — 本PRの本文
- `outputs/X-0013/orgiast-implementation-plan.md` — 週次マイルストーン実装計画

## 注目ポイント

1. **フルスタック構成**: トリガー（n8n）→ オーケストレーション（LangGraph）→ LLM統一（LiteLLM）→ 構造化出力（Pydantic AI）→ 評価（promptfoo）→ 可観測性（Phoenix）→ ツール連携（FastMCP）の全層をカバー
2. **再現性の4層担保**: チェックポイント（LangGraph）＋ 型バリデーション（Pydantic AI）＋ 評価ゲート（promptfoo）＋ トレース再現（Phoenix）
3. **段階的導入可能**: 各層が独立しているため、LiteLLMだけ・Phoenixだけの導入も可能。既存のbooth-kw-researchやseo-content-complementもFastMCPツール化して統合
4. **障害耐性**: LiteLLMのフォールバック + LangGraphのチェックポイント + Phoenixのトレースで、単一障害点が存在しない設計

## 検証結果

証拠ゲート 7項目を確認：
- ✅ 各ツールの最新バージョンと選定理由が明記
- ✅ ツール間の連携アーキテクチャが図示
- ✅ オージャスト固有のユースケース3件（SEO記事生成・問合せ応答・LP生成）
- ✅ 週次マイルストーンを含む実装計画
- ✅ 既存リソース（booth-kw-research, seo-content-complement）との統合方法
- ✅ 期待効果を数値で提示（工数97%削減など）
- ✅ 全7ツールの公式サイト・GitHubリンク

## 残タスク

- [ ] Phase 1（Week 1）: Docker Compose環境構築と各ツールの疎通確認
- [ ] Phase 2（Week 2）: SEO記事生成パイプラインの実装とE2Eテスト
- [ ] Phase 3（Week 3）: 問合せ自動処理パイプラインの実装とE2Eテスト
- [ ] Phase 4（Week 4）: 運用最適化・KPI可視化・障害復旧手順確立
- [ ] 実際のn8n Assistantやn8n Agentsのプレビュー版評価

🤖 Generated with [Claude Code](https://claude.com/claude-code)
