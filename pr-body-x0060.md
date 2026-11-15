# X-0060: Claude Code + Adobe MCPでイベント告知制作を自動化 — 案内文入力→3案即時生成

## 概要

AIニュース提案 [X-0060]: Claude CodeのネイティブMCP機能（`claude mcp add --transport http`）でAdobe Creativity MCPを接続し、イベント告知の案内文からタイトル・開催日・会場を抽出、既存Illustratorテンプレートに自動反映して3案の告知グラフィックを生成する手法を提案。

- X-0027（Codex + ExtendScript）＝ゼロからのグラフィック制作に最適
- X-0060（Claude Code + Adobe MCP）＝既存テンプレートの日付・タイトル差し替えを数クリック相当で完了
- 両者を補完的に使い分け

## 変更内容
- **docs/ai-news-x0060-claude-mcp-adobe-event-announcement.md**: 提案文書（MCP登録方法・ワークフロー詳細・オージャスト適用シナリオ・X-0027との住み分け）

## 検証
- Adobe Creativity MCPの提供ツールリスト（2026-11-15時点のMCPサーバーAPI）に基づく実現可能性評価
- 展示会用4シナリオの時間削減見積もり（80%〜97%削減）
- 費用対効果: 1回のClaude実行$0.03〜0.10、初期導入コストほぼ0

🤖 Generated with [Claude Code](https://claude.com/claude-code)