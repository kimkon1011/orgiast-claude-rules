# 着手記録
2026-09-26: Codex / 夜間バッチ起動後ログ未更新の調査・最小修正・回帰テスト・コミット（push なし）。
2026-09-27: 修復ワークツリーが未コミットのまま自動クリーンアップされ差分が消えたため、
トランスクリプト (61bc3741) の Edit 記録から同一差分を復元して orgiast-main へ再適用（テスト39/39再合格）。

## 調査結果（2026-09-26 実測）
- 昨夜の OrgiastNightlyBatch は **正常完走**（日次ログ nightly-batch-2026-09-26.log: 03:00:51 開始 → 03:36:34 サマリ完了・exit 0、batch-run 48件処理）。
- 異常は誤検知。OrgiastNightlyBatch は3アクション構成（nightly-batch.ps1 → ai-news-triage.mjs → pricing-brief.mjs）で、
  Windows Task Scheduler の多段アクションでは LastRunTime が**最終アクションの開始時刻**に更新される
  （LastRunTime=03:37:57 ≡ ai-news-triage.log 最終書込 03:37:57.334 ≡ pricing-brief 開始）。
  先頭アクションのログ最終書込（03:22:01 / 03:36:34）は必ずそれより前になるため、
  nightly-health.mjs の `logMtime < lastRunTime` 判定が「起動直後に死んだ」と誤認し、成功夜に毎回誤報する構造だった。
- 修正: lastTaskResult=0（全アクション正常終了の積極証拠）なら mtime 比較で鳴らさない。
  ログファイル自体が無い場合・result≠0・実行中(267009)のハングは従来どおり鳴る。
