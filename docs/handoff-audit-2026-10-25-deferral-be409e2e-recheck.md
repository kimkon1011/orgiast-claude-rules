# handoff-audit:be409e2ee4dad3e4 再発検証と増殖の恒久修正（2026-10-25）

## 対象

2026-10-23T07:23:16.812Z / session `9310953f-dbd9-44a7-a08b-cce62d7f8930` / P3 の先送り文:

> : マージは user の承認が要る判断で、今回の f94ee7a 固有の件だからです。
> 次に kim がすること: 修正 f94ee7a（ブランチ quota-sweep/20261023-0202-claude-mvkbrycs）を main にマージするか判断する。

## 1. 再発の有無: 再発なし

`node tools/permanent-fix-deferral-scan.mjs --since 2026-10-23T07:30:00Z --json` を実行し、
検出時刻以降の3台帳を走査した。

| 台帳 | 行数 | P1 | P2 | P3 | P4 | W |
|---|---|---|---|---|---|---|
| stop-gate-runner-ledger.jsonl | 631 | 0 | 0 | 0 | 0 | 0 |
| handoff-audit-ledger.jsonl | 1448 | 0 | 0 | 0 | 0 | 0 |
| handoff-audit-nightly-ledger.jsonl | 45 | 0 | 0 | 0 | 0 | 0 |

限界: 走査対象は台帳に残った行のみ。台帳に書かれなかった先送りは検出できない。

## 2. 先送りの実体: 解消済み（kim の操作は不要）

- `f94ee7a` は origin/main の祖先ではない（`git merge-base --is-ancestor f94ee7a origin/main` = exit 1）。
  残っているのは `origin/quota-sweep/20261023-0202-claude-mvkbrycs` のみ。
- ただし同一変更は **PR #1047（`0449b88`）として squash 着地**しており、
  `origin/main:tools/stop-gate-runner.mjs:135` に `audit.record.skipped === 'regex-blocked' && !evaluated.results.length`
  の再評価ブロックが存在する（`f94ee7a` の追加5行と同一）。
- したがって「main マージの承認待ち」という先送りの実体は無い。**kim がマージを判断する必要はない。**

## 3. 恒久修正: 1つの先送りが監査TODOに増殖する機構を止めた

同じ違反セッションの同じパターンは、ループがイテレーションごとに同じ先送り文を書くため
1つの窓で何度も検出される。`handoff-audit-nightly` は検出行ごとに別IDの監査TODOを積んでいたため、
**1つの先送りが8本の「検証の検証」セッションに増殖した**。

実測（`~/.claude/next-session.md`）: 2026-10-23T07:23 の先送り1件から
`be409e2ee4dad3e4` / `5dd97c87e35a632c` / `10d7b4072400beac` / `e4fbe4a9ce998f18` /
`e2de84a9e9cfc687` / `7432e46b54bdfb61` / `aa2f4632eab37e77` / `10f6b577d8a8773c` の **8本**が生成され、
`e2de84a9` の検証ループは同じ結論を出すために8イテレーションを消費した。

修正（`tools/handoff-audit-nightly.mjs`）:

- 台帳への検出行の記録は従来どおり全件残す（証跡を落とさない）。
- 監査TODOは `(sessionId, pattern)` ごとに窓内の先頭1件だけ積む。

テスト（`tools/handoff-audit-nightly.test.mjs`）:
「同一セッションの同じパターンが窓内で複数検出されても監査TODOは1本にまとめる」を追加。
3行（同一セッション2行＋別セッション1行）→ 台帳 hit 3件 / TODO 2本を固定した。

## 4. 残件

- `~/.claude/next-session.md` に残る同一起源の重複TODO（本ID以外の7本）は、
  本ドキュメントと同じ結論（f94ee7a の実体は #1047 で着地済み・再発なし）で閉じられる。
  次回の runner が各IDを独立に検証する必要はない。
