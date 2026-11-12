## X-0036: OSSでAIコーディングエージェント信頼性システム構築

### 変更概要

OSSの評価・トレースツール（OpenAI Evals, Promptfoo, OpenEvals, Langfuse, Arize Phoenix, LangGraph）を組み合わせ、AIコーディングエージェントの出力検証を自動化する信頼性システムの提案文書を作成。あわせて軽量トレース記録ツール `trace-send.mjs` を実装。

### 追加したファイル

**`docs/ai-news-x0036-evaluation-trace-reliability.md`:**
- エージェント信頼性システムの全体アーキテクチャ（Agent Layer → Evaluation Layer → Observability Layer → Evidence Store）
- 各OSSツールの役割・連携パターンの解説
- 株式会社オージャスト向けフェーズ別導入計画（Phase 1〜4）
- Golden Test 10ケースの例（ブース企画・UI生成）
- 月額 $10〜25 のコスト試算
- 既存 `eval-harness.mjs` との連携拡張案

**`tools/trace-send.mjs`:**
- エージェント実行結果をJSONLで永続化する軽量トレース記録
- `traceEvent()` — 1件のトレースを記録
- `readTraces()` — 指定日のトレース一覧を読む
- `weeklyReport()` — 直近N日間の集計レポート（合格率・コスト・プロバイダ別）
- CLIモード: `send` / `report` / `read`

**`tools/trace-send.test.mjs`:** 6テストケース（記録・読取・集計・エッジケース） — 全緑

### テスト結果

```
✔ 6 tests passed (231ms)
```

### 今後の展望

- Phase 1: eval-harness.mjs にブース企画ゴールデンテスト追加
- Phase 2: Langfuse セルフホストでトレース一元管理
- Phase 3: Promptfoo + GitHub Actions でCI/CD回帰テスト自動化
- Phase 4: エージェント→評価→トレースの完全自動パイプライン

🤖 Generated with [Claude Code](https://claude.com/claude-code)
