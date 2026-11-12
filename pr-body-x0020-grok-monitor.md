# X-0020: 監視頻度3段階化と差分処理でGrokコスト削減

## 概要
Grok Bot の監視頻度を **緊急(5分)/通常(15-60分)/収集(6-12時間)** の3段階に分類し、変化時のみAI分析・時間帯別頻度制御・差分取得により、チェック回数93%減・コスト最大99%削減を実現する提案。

## 変更内容
- **docs/ai-news-x0020-grok-monitor-frequency.md**: 提案文書（3段階頻度モデル・省コスト機構・オージャスト適用シナリオ）
- **tools/grok-monitor-cost-model.mjs**: 検証ツール（5シナリオのコスト削減率を計算。--list/--scenario/--json対応）
- **tools/grok-monitor-cost-model.test.mjs**: テスト13件（全件pass）

## 検証
- `node --test tools/grok-monitor-cost-model.test.mjs` → **pass 13 / fail 0**
- 実測値: basicシナリオで93.33%チェック削減、aggressiveシナリオで99.47%総コスト削減

## オージャスト適用
展示会ブースの顧客問い合わせ（通常15-30分/イベント期間中5分）、競合情報（6-12時間収集）、SNS反応（1-3時間）に3段階設定を適用し、イベント期間の対応を維持しつつコスト削減する。

🤖 Generated with [Claude Code](https://claude.com/claude-code)