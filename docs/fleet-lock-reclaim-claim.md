# 着手記録

2026-11-04 Codex: fleet-mail と同型の reclaim フォルダ残留を修正。一時ディレクトリでテストし、外部送信・実データ変更・push・PR作成は行わない。

基点は origin/main の 707b7f91（作業開始時の HEAD と一致）。ローカル main は古いため使用しない。元 Git 管理領域は読み取り専用のため、一時チェックアウトの fix/fleet-lock-reclaim-stale でコミットし bundle を保存する。

## 実装・検証

- RECLAIM_STALE_MS=60秒。fleet-mail の acquireLock/updateInbox と fleet-question-relay の updateQuestion で共通化。
- poll が locked で、ロックの mtime が LOCK_MS の3倍（30分）以上古い場合は指定警告と LOCK_BUSY_EXIT=6。通常競合は従来通り0。
- tools/ 全体検索で quota-sweep にも .reclaim があるが、これはフォルダでなく排他的ファイルのため、今回の mkdir/rmdir 修正対象外。
- `node --test tools/fleet-mail.test.mjs`: 96/96 成功。
- 最終の fleet-mail / fleet-mail-v2 / fleet-question-relay / lib/reclaim-lock 合同テスト: 282/282 成功、exit 0。
- `node tools/selftest-guards.mjs`: ALL PASS、exit 0。
- 一時チェックアウトで `git diff --check` 成功。
