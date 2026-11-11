# X-0019: AI SEOエージェントによるミニサイト展開と自動化ワークフロー

## 変更内容

AIニュース提案 X-0019 の提案文書と検証ツールを追加。

### docs/ai-news-x0019-ai-seo-agent-minisite.md
- アーキテクチャ概要（AIエージェント基盤 / VPS / SEOツールMCP）
- 3つの実装パス（A: Claude Code+GAS / B: Hermes/OpenClaw / C: カスタムNode.js）
- ミニサイト戦略（5テーマ × 自動生成ワークフロー）
- SEO分析エンジン設計（4分析項目 × 推奨生成ロジック）
- 導入ステップ（Phase 0〜3）
- 期待効果（3ヶ月目標数値）

### tools/ai-seo-agent-workflow.mjs
- 実装パス別の月額コスト試算
- キーワード機会スコアリングシミュレーション
- ミニサイト企画テンプレート生成
- `--list` / `--scenario` / `--json` 対応CLI

### tools/ai-seo-agent-workflow.test.mjs
- 全シナリオの出力検証テスト
- JSON出力のパーステスト
- エッジケーステスト

## 検証
- `node tools/ai-seo-agent-workflow.mjs --list` で全シナリオ表示確認
- `node tools/ai-seo-agent-workflow.mjs --scenario plan --json` でJSON出力確認
- `node --test tools/ai-seo-agent-workflow.test.mjs` 全テストpass

🤖 Generated with [Claude Code](https://claude.com/claude-code)
