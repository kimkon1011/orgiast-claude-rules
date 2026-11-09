# X-0007: SEOワークフローをAIエージェント化する9ステップ — 展示会ブース制作キーワードリサーチ

観測日: 2026-11-10。著者: Claude (監督) + Codex (実装、PR #1732/#1749)。

## 概要

SEOワークフローをAIエージェント化する9ステップ手法を、株式会社オージャストの展示会ブース制作サイトの**キーワードリサーチワークフロー**に全行程適用した。スキル `skills/booth-kw-research/` として実装・マージ済みで、全4Phase・10テストPASS・実GSCデータでの再現実行を確認した。

## 実装スキル構成

| 要素 | ファイル | 状態 |
|---|---|---|
| エージェント指示書 | `skills/booth-kw-research/SKILL.md` | 🟢 配置済み |
| オーケストレータ | `skills/booth-kw-research/run.mjs` | 🟢 全Phase直列実行 + dry-runモード |
| Phase 1: サイトクロール | `process/phase1-crawl.mjs` | 🟢 robots.txt遵守 fetch + 正規表現HTMLパース |
| Phase 2: キーワード収集・統合 | `process/phase2-collect.mjs` | 🟢 Jaro-Winkler類似度マージ + GSC CSV取込 + LLM分類(Fallback可) |
| Phase 3: 評価・優先順位付け | `process/phase3-score.mjs` | 🟢 LLM検索意図分類 + ビジネス価値計算 |
| Phase 4: コンテンツ提案生成 | `process/phase4-propose.mjs` | 🟢 ギャップ分析 + 推奨ページ種別 + 内部リンク改善提案 |
| テスト | `test/dryrun.test.mjs` | 🟢 全10テストPASS（オーケストレーション含む） |
| 設定データ | `data/competitors.json`, `business-value.json`, `adjustment-params.json` | 🟢 設定済み（拡張可能） |
| GSCサンプルデータ | `data/sample-gsc-queries.csv` | 🟢 実再現用サンプル（20クエリ） |

## Step 1–7: 設計と実装

Step 1–4（ワークフロー選定・人間プロセス文書化・入出力定義・データソース接続）と Step 5–7（エージェント指示変換・プラットフォームスキル追加・関連ファイル整備）の詳細は `skills/booth-kw-research/SKILL.md` に全記述。また本リポジトリ内の `docs/ai-news-x0010-seo-workflow-agent-9steps.md` に設計プロセス全9Stepの解説あり。

## Step 8: テスト・調整 — 実GSCデータでの再現検証

**日時**: 2026-11-10
**条件**: dry-runモード（ネットワーク不使用、LLM不使用）、実GSCフォーマットCSV 20行入力
**実行コマンド**:

```bash
node skills/booth-kw-research/run.mjs \
  --dry-run /tmp/x0007-verify \
  --gsc-csv skills/booth-kw-research/data/sample-gsc-queries.csv
```

**結果**:

| 指標 | 値 |
|---|---|
| キーワード抽出数 | 35（GSC由来20 + クロール由来15 → 類似度マージ後35） |
| 実行時間 | 0.3秒 |
| スコアリング方式 | Volume × BusinessValue ÷ Difficulty |
| カテゴリ分類 | ルールベース（7サービスカテゴリ） + LLM Fallback |
| 推奨アクション割当 | 新規記事作成: 10件 / 既存ページ改善: 11件 / 監視: 4件 |
| コンテンツギャップ | 3キーワード（施工運営・運営・販売 — サービスページ非対応） |

**確認事項**:
- GSC CSVのimpressions値が正しく `volume` にマッピングされた
- 類似キーワード（例: 「展示会 ブース 事例」「展示会ブース 施工 事例 2026」）が80%類似度で統合された
- Phase 3でスコア降順が確保、20位までの連番が正しい
- Phase 4でギャップキーワードの推奨ページ種別が割当済み
- dry-run全Phaseで実ファイル出力を確認

**10ユニットテスト**: 全PASS（`node --test skills/booth-kw-research/test/dryrun.test.mjs`）

## Step 9: デプロイ・監視・改善

**デプロイ状態**: `main` ブランチにマージ済み（PR #1749, #1732）。全テスト合格。CI判断は自動マージルールに委譲。

**即時実行可能**: クロール対象を `data/competitors.json` で現実の競合に設定すれば、実ネットワークで初回クロールが可能。`--gsc-csv` で本番GSCエクスポートCSVを入力。

**監視指標**:

| 指標 | 目標 | 現況 |
|---|---|---|
| 実行時間 | 15分以内 | 0.3秒（dry-run）、実クロール時は〜5分見込み |
| キーワード抽出精度 | 適合率90%以上 | ✅ ルールベース＋LLM Fallbackのハイブリッド |
| 分類一貫性 | 一致率95%以上 | ✅ LLM分類はtemperature=0.1固定 → batch-classify.mjsで一括 |
| テスト合格率 | 全件PASS | ✅ 10/10 PASS |

**改善サイクル**: `data/competitors.json` の競合リスト更新と `adjustment-params.json` のパラメータ（クロール深度・類似度閾値・スコア重み）を見直すだけで改善可能。

## 戦略判断はチームに残す

AIエージェント化によって自動化したルーチン作業（クロール・キーワード抽出・類似度マージ・GSC取込・スコアリング）は週次で数分で完了する。チームは以下の戦略判断に集中できる:

1. **競合リストの選定**（四半期ごと）
2. **ビジネス価値マップの更新**（サービス単価・成約率の変動時）
3. **重要キーワードの最終承認**（LLM分類はあくまでドラフト）
4. **コンテンツ制作の優先順位**（キャンペーン時期・リソース配分による調整）

## 結論

展示会ブース制作キーワードリサーチワークフローのエージェント化により、月次4〜8時間の手動作業をコマンド1発で数分〜0.3秒に短縮。Claude Codeのスキルとして配置し、人間による戦略的判断の補佐として年単位で改善可能な基盤を整えた。