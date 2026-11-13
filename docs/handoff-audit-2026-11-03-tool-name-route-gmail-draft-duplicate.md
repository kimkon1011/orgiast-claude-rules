# 追記: PR #1322 は #1258 の重複（2026-11-03 停止 PR 修復）

対象: PR #1322「fix(handoff-audit): tool-name-route 候補「Gmail 下書きの削除・検証結果報告」の route を手順文へ書き直して採用」
ブランチ: `auto/20261029-tool-name-route-gmail-draft`（head `cdf6f5df3033ec95595bb98d73d85bda866b9d2a`）

## 実測

- **同じブランチ・同じ head の PR が先にマージ済み**。PR #1258（作成 2026-10-28T18:09:53Z）が
  2026-10-28T18:20:09Z にマージされ、main の `1683d5f` になっている。head は #1322 と同一の `cdf6f5d`。
- **#1322 はその約31時間後に作られた2本目**。作成 2026-10-30T01:29:27Z。
  マージ済みブランチでも `gh pr create` は新しい PR を作れるため、同じ内容で重複が立った。
- **main との差分は 0**。`tools/handoff-audit-knowledge.json` の blob は HEAD と origin/main で同一
  （`49d88162ff8c3d3309aea99527b184aa9d4920ad`）。HEAD は origin/main より 172 コミット遅れ。
- **競合なし・失敗テストなし**。`mergeable=MERGEABLE` / `mergeStateStatus=CLEAN`。
  CI は `test` / `test-posix` / `enable-auto-merge` の全ジョブが success（2026-10-28 と 2026-10-30 の実行）。
- **auto-merge は有効化されていない**。`automerge` ラベルが無いため `auto-merge.yml` の
  `Resolve and validate pull request` が `eligible=false` を返し、`Enable squash auto-merge` は skipped。
  `autoMergeRequest` は null。ジョブ自体は success 表示なので「有効化済み」と読み違えやすい。

## 原因

1. **重複 PR**: 同じ head ブランチの PR #1258 がマージ済みなのに、#1322 が2本目として作られた。
2. **24時間 open の直接原因**: 2本目に `automerge` ラベルが付かず、auto-merge が一度も有効にならない。
   さらに main に対する実差分が 0 なので、ラベルが付いても squash merge は空になる。

## 判断

- `tools/handoff-audit-knowledge.json` は変更しない。origin/main と同一で、このブランチは
  172 コミット遅れ。触ると不要な競合を作る。
- main に対する実差分はこの追記1ファイルだけにし、#1322 が空マージにならないようにする。
  レビュー条件・安全装置・テストは変更しない。
- 監視: 同じブランチで PR が2本立ったら `gh pr list --head <branch> --state all` で
  マージ済みを確認し、2本目は中身を足さずに閉じる。

## 検証

- `node --test tools/handoff-audit-nightly.test.mjs` → 26 pass / 0 fail
- `node --test tools/handoff-audit-gate.test.mjs tools/handoff-audit-rescan.test.mjs` → 42 pass / 0 fail
