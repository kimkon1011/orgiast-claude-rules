# handoff-audit:10d7b4072400beac 再発検証（2026-10-25）

## 対象

2026-10-23T07:23:12.134Z / session `9310953f-dbd9-44a7-a08b-cce62d7f8930` / P3 の先送り文:

> ITERATING 次に kim がすること: 修正 f94ee7a（ブランチ quota-sweep/20261023-0202-claude-mvkbryc…

同一セッションが 2026-10-23T07:23:09〜07:23:19 に同じ先送り文を繰り返し書いたうちの1件
（`handoff-audit-ledger.jsonl` line 1357）。同一起源の TODO は8本あり、
`e2de84a9` は #1069、`be409e2e` は #1071 で記録済み。本ドキュメントは最後の未記録IDを閉じる。

## 1. 再発の有無: 再発なし

`node tools/permanent-fix-deferral-scan.mjs --since 2026-10-23T07:30:00Z`（検出時刻の直後から現在まで）:

| 台帳 | 窓内行数 | P1 | P2 | P3 | P4 | W |
|---|---|---|---|---|---|---|
| stop-gate-runner-ledger.jsonl | 29 | 0 | 0 | 0 | 0 | 0 |
| handoff-audit-ledger.jsonl | 112 | 0 | 0 | 0 | 0 | 0 |
| handoff-audit-nightly-ledger.jsonl | 14 | 0 | 0 | 0 | 0 | 0 |

直近窓 `--since 2026-10-24T15:38:00Z`（前回検証の直後）でも stop-gate 0 行 /
handoff-audit 48 行 / nightly 0 行で、P1〜P4・W すべて 0。

限界: 走査対象は台帳に残った行のみ。台帳に書かれなかった先送りは検出できない。

## 2. 先送りの実体: 解消済み（kim の操作は不要）

- `f94ee7a` は origin/main の祖先ではない（`git merge-base --is-ancestor f94ee7a origin/main` = 偽）。
- 同じ変更は **PR #1047（`0449b88`）として squash 着地**しており、
  `origin/main:tools/stop-gate-runner.mjs:135` に `audit.record.skipped === 'regex-blocked' && !evaluated.results.length`
  の第2段再評価ブロック（`f94ee7a` の追加5行と同一）が存在する。
- したがって「main マージを判断する」という先送りの実体は残っていない。

## 3. 増殖の恒久修正: 着地済み・本番の初回実測は次回 nightly

1つの先送りが監査TODO 8本に増殖する機構は **#1071（`bdede9f`・2026-10-24T15:53:41Z）** で修正済み。
監査TODOを `(sessionId, pattern)` ごとに窓内の先頭1件へ畳み、台帳の検出行は全件残す。

- 実行側 `~/.claude/nightly-repo` の HEAD も `bdede9f` で、
  `tools/handoff-audit-nightly.mjs:194-207` に `enqueueRows` の実装が存在することを実物確認した。
- 台帳の最終 nightly は 2026-10-23T18:05:13Z。修正後の初回実行は **2026-10-24T18:01Z** で、
  増殖が止まったことの本番実測はまだ無い（次回セッションで1行確認する）。

## 4. 操作の範囲

送信・DM・権限変更・main への直接マージは行っていない。台帳の読み取りとこの文書のみ。
