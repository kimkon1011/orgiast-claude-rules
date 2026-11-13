# X-0025: オープンソースでAIコーディングエージェントの検証ワークフロー

## 概要

AIコーディングエージェント（Claude Code, Codex等）が生成したコードを、検証・回復・実結果追跡まで含めた**再現可能なパイプライン**で評価するワークフローを設計・提案する。

## 使用ツール

| カテゴリ | ツール |
|----------|--------|
| 実行エンジン | Claude Agent SDK, LangGraph |
| 評価・検証 | Promptfoo, OpenAI Evals, OpenEvals |
| トレース・監視 | Langfuse, Arize Phoenix |

## パイプライン設計

1. **Plan**: 人間が設計・仕様を定義、エージェントがタスク分解
2. **Generate**: AIエージェントがコード生成
3. **Verify**: Promptfoo品質ゲート + OpenEvals LLM-as-a-judge
4. **Recover**: LangGraphチェックポイントから失敗ノードのみ再試行
5. **Track**: Langfuse/Phoenixでトレース・コスト監視

## オージャスト適用計画

- Phase 0（1週間）: Promptfoo + Langfuse 導入
- Phase 1（2週間）: 自動検証 + 障害復旧パイプライン
- Phase 2（3週間）: トレース監視 + 改善サイクル
- Phase 3（4週間）: 本番統合 + PR品質ゲート

## 期待効果

- AI生成コード初回合格率: 40-60% → 85%以上
- バグ本番到達率: 10-20% → 3%未満
- コードレビュー工数: 50%削減
- モデルコスト: 30-50%削減

🤖 Generated with [Claude Code](https://claude.com/claude-code)
