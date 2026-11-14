# X-0026 Illyism/seo-skills 導入前セキュリティ監査（2026-11-13）

対象 HEAD: 805c9c8261e60716e17efe6b834b0be7248d9ebb（gh api 全文取得）。既存: docs/ai-news-x0040-seo-skills-npx-install.md（概要のみ）との差分を記録。

## 監査表（SKILL.md 5 本＋同梱コード全文確認）
| ファイル | 所見 |
|---|---|
| seo/seo-autopilot/SKILL.md:105-106 | 実行時に https://linkdr.com/SKILL.md と https://aiseotracker.com/docs を「読んで従え」と指示（外部指示の動的取込） |
| seo/linkdr/SKILL.md:26 | 同梱は v1.10.0 のコピー。「ライブ版が新しければライブ版に従え」。Stripe 課金チェックアウトURL（割引コード AGENTIC 付き）を提示する有料バックリンク発注スキル |
| .mcp.json / gemini-extension.json | 第三者リモート MCP 3 件を自動登録: aiseotracker.com/api/agent/mcp, scribiz.com/mcp, awesome.tools/mcp |
| seo/domain-migration/scripts/verify-redirects.sh, seo/internal-linking/scripts/internal-link-graph.mjs（5 スキル外） | curl によるリダイレクト確認／SITE 環境変数のサイトのクロールのみ。秘密値参照・難読化・不審な外部送信なし |
| blog-refresher / seo-title-optimization / customer-journey | プロンプトのみ。外部URLは出典リンクのみ |
| リポジトリ全体 | LICENSE なし（再利用許諾不明） |

## 独立レビュー（DeepSeek v4-flash, llm-ask 経由）
「重大所見に当たる」。理由は第三者 MCP 自動登録、実行時外部指示の取込、ライセンス欠如。部分採用（linkdr 除外・.mcp.json 無視・内容を手動確認）は許容範囲。

## 判定
契約 C2 に従い重大所見あり → 導入せず（C3 以降は未実施）。stop_reason=scope-boundary。
再開条件: kim が部分採用（linkdr 除外、.mcp.json/gemini-extension.json 無視、SKILL.md 本文のみ手動取込）を承認した場合のみ。
