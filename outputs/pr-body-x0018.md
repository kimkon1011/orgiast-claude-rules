# X-0018: 構築エージェントと評価エージェントを分離したUI改善ループ

## 概要

ブースデザインのWeb UIやイベントサイト開発において、**構築（Build）** と **評価（Evaluate）** の責任を分離した改善ループを実装する。

## 変更内容

### 設計文書
- `docs/ai-news-x0018-ui-eval-loop.md`: 評価基準11項目（視覚的一貫性V1-V5/独創性O1-O3/ユーザビリティU1-U3）の定義、ループ設計図、適用シナリオ

### 実装
- `apps/evaluation-ai/uivisual-eval.mjs`: UI視覚評価エンジン
  - 加重スコア計算（カテゴリ別重み: 一貫性3 / 独創性2 / ユーザビリティ2）
  - 合格/改訂判定（既定閾値3.5、カスタム設定可能）
  - 未評価項目は中間点(3)として扱う
  - CSS色分析・HTMLアクセシビリティ簡易検査
- `apps/evaluation-ai/build-agent.mjs`: 構築エージェント
  - `runImprovementLoop()`: 評価→フィードバック→改訂のループ制御（最大試行回数設定可能）
  - `formatReport()`: 試行履歴レポート生成
- `apps/evaluation-ai/test/ui-eval-loop.test.mjs`: 12テスト（全通過）

## 検証

```sh
$ node --test apps/evaluation-ai/test/*.test.mjs
✔ 24 tests passed (既存12 + 新規12)
```

## ループ動作

```
Build Agent ──→ UI生成 ──→ Evaluate Agent
     ↑                          │
     └── フィードバック ← 不合格│
                                ▼
                            合格 → 承認/デプロイ
```

🤖 Generated with [Claude Code](https://claude.com/claude-code)
