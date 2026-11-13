# 追記: PR #1327 は #1245 の重複（2026-11-03 停止 PR 修復）

対象: PR #1327「docs(handoff-audit): quota-sweep HTTP 429 deferred 3連続の再検証記録（2026-10-29、ledger全履歴で同一goal連続は最大2）」
ブランチ: `auto/20261029-quota-sweep-429-recheck`（head `d11270b4a71d17856dcbf0cd32c46b1f05a979b4`）

## 実測

- **同じブランチ・同じ head の PR が先にマージ済み**。PR #1245（作成 2026-10-28T16:32:30Z）が
  2026-10-28T16:44:33Z にマージされ、main の `1bce8d7` になっている。head は #1327 と同一の `d11270b`。
- **#1327 はその約2日後に作られた2本目**。作成 2026-10-30T01:29:56Z。
  マージ済みブランチでも `gh pr create` は新しい PR を作れるため、同じ内容で重複が立った。
- **main との差分は 0**。`docs/handoff-audit-2026-10-29-quota-sweep-429-recheck.md` の blob は
  HEAD と origin/main で同一（`e2008d47eab8684956229480b433b9a7bb08fb0f`）。
- **競合なし・失敗テストなし**。`mergeable=MERGEABLE` / `mergeStateStatus=CLEAN`。
  CI は `test` / `test-posix` / `enable-auto-merge` の全ジョブが success（2026-10-28 と 2026-10-30 の実行）。
- **auto-merge は有効化されていない**。`automerge` ラベルが無いため `auto-merge.yml` の
  `Resolve and validate pull request` が `eligible=false` を返し、`Enable squash auto-merge` は skipped。
  `autoMergeRequest` は null。ジョブ自体は success 表示なので「有効化済み」と読み違えやすい。
- **このPCの台帳に新しい 429 は無い**。`~/.claude/quota-sweep.jsonl`（23 行、2026-10-21T01:30Z〜2026-10-29T19:38Z）で
  `HTTP 429` の deferred は 2026-10-24T13:33Z の 1 件だけ。残り 5 件は「対話セッションの使用中」で、
  `queueRepeatedDeferral` の連続カウント対象外。3 連続は無い。

## 原因

1. **重複 PR**: `tools/quota-sweep.mjs` の `createPullRequest` は `gh pr create` の前に
   「同じ head ブランチの PR が既にあるか」を確認しない。origin/main の実装でも、既存 PR を
   確認するのは API フォールバック側（`createPullRequestViaApi`）だけ。マージ済みの PR がある
   ブランチでも 2 本目を作れてしまう。
2. **24時間 open の直接原因**: 2 本目に `automerge` ラベルが付かず、auto-merge が一度も有効にならない。
   さらに main に対する実差分が 0 なので、ラベルが付いても squash merge は空になる。

## 判断

- `tools/quota-sweep.mjs` は変更しない。origin/main で 164 行の差分があり、このブランチ
  （origin/main より 176 コミット遅れ）で触るとマージ競合を作る。重複防止のガードは main 側で別途入れる。
- main に対する実差分はこの追記 1 ファイルだけにし、#1327 が空マージにならないようにする。
  レビュー条件・安全装置・テストは変更しない。
- 監視: 同じブランチで PR が 2 本立ったら `gh pr list --head <branch> --state all` で
  マージ済みを確認し、2 本目は中身を足さずに閉じる。
