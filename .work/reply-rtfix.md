【結果】対応不要: すでに main にマージ済みでした（冪等チェックで終了）。

- PR #817「fix(remote-trigger): RemoteTrigger の action 名を実測値に直す（main の #787 版が誤値）」
  - URL: https://github.com/kimkon1011/orgiast-claude-rules/pull/817 （GitHub kimkon1011 で開く）
  - head: auto/20261016-rt-action-fix（マージ後にブランチ削除済みのため、ls-remote の出力は空）
  - state: MERGED / mergedAt: 2026-10-16T16:51:20Z / merge commit: d93767e0dca95d2ed41e192f19cd0dbc6cc0ff98
- 実測（kim-PC で 2026-10-20 に fetch 後）:
  - `git log origin/main -- tools/remote-trigger.mjs` → d93767e（#817）、その前が ec9655f（#787）
  - origin/main の ACTIONS = list / get / create / update / run / list_runs / get_run_log / create_webhook_trigger
  - `git grep list_triggers origin/main -- tools/remote-trigger.mjs` のヒットは7行目のコメントだけ（「list_triggers / get_trigger / update_trigger は存在しない値」と書かれている箇所）。コード上の使用は 0 件
- パッチの再適用・新しい PR 作成・push はしていません。
