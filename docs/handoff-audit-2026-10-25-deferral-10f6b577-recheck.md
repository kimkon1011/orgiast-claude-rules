# handoff-audit:10f6b577d8a8773c 再発検証（2026-10-25）

## 対象

検出: **2026-10-23T07:21:06.844Z / session `66f6c883-8a60-4acd-be84-104b8f3ff52e` / P3**。

台帳上の実体は `~/.claude/stop-gate-runner-ledger.jsonl:574`
（`verdict=block` / `reasonCodes=PERMANENT-FIX-REQUIRED` / `demoted=user-burden-gate` /
`sameTextRetries=1`）、`~/.claude/handoff-audit-ledger.jsonl:1341`（同文・`pass`）、
`~/.claude/handoff-audit-deferral-ledger.jsonl:23`（P3・`block`・`source=stop-gate-runner-ledger.jsonl`）。

> ITERATING。上限超過のため、今回も新規作業はありません。状態ファイルに iteration 20 を追記しました。
>
> 次に kim がすること: 修正 f94ee7a(ブランチ `quota-sweep/20261023-0202-claude-mvkbrycs`)を main にマージするか判断してください。
>
> この後の自動進行: 夜間監査が 10-23T18:01Z に走った後、再走査で provider 判定付きの verdict が出るか確認します。ただし試行上限を超えているため、上限の引き上げか判断がない限り新規作業は行いません。
>
> このセッション: /session-close は不要なので、このセッションを閉じてよい

同一起源バースト（`66f6c883` の 07:21:06〜07:21:57）の**最初の1件**。3.7 秒後の
`aa2f4632eab37e77`（07:21:10.517Z）は既記録（PR #1082）。同バースト由来の監査 TODO は
`e2de84a9`（#1069）・`be409e2e`（#1071）・`5dd97c87`（#1075）・`10d7b407`（#1077）・
`e4fbe4a9`（#1078）・`7432e46b`（#1081）・`aa2f4632`（#1082）で閉じており、本ドキュメントで **8本すべて**が閉じる。

## 1. 再発の有無: 同型は再発している（逐語は原文セッションのみ）

走査: `node tools/permanent-fix-deferral-scan.mjs --since 2026-10-23T07:21:06.844Z`
（本ブランチの検出器は origin/main と同一 blob）。

| 台帳 | 窓内行数 | hits | 内訳 |
|---|---|---|---|
| `stop-gate-runner-ledger.jsonl` | 631 | **21** | P3 21（10-23: 19 / 10-24: 2） |
| `handoff-audit-ledger.jsonl` | 1512 | 0 | – |
| `handoff-audit-nightly-ledger.jsonl` | 45 | **3** | P3 3（すべて 10-23） |

合計 **24 行**（原文行を含む）。セッション別:

| session | 行 | 時刻 |
|---|---|---|
| `66f6c883`（原文） | 4 | 07:21:06.844（原文）／07:21:10.517／07:21:13.894／07:21:17.140 |
| `408cde0a` | 3 | 07:22:37〜07:22:43 |
| `9310953f` | 8 | 07:23:09〜07:23:25 |
| `342a5479` | 4 | 07:23:51〜07:24:01（うち 1 行は `pass`） |
| `e955379b` / `f1fa8f2a` / `aa8b6736`（nightly） | 各1 | 10-23T18:03〜18:04 |
| `8ea416ef` | 1 | 10-24T04:34:09 |
| `61af55b9` | 1 | **10-24T04:36:20（最新）** |

- **逐語の再発は原文セッションの外に無い**: 4 台帳で
  「今回も新規作業はありません。状態ファイルに iteration 20 を追記しました」を含む行は **3 行**
  （stop-gate 574・audit 1341・deferral 23）で、すべて同一イベント
  `2026-10-23T07:21:06.776〜06.844Z`。他の 21 行は言い換え（同型）で、内容はすべて
  「`f94ee7a` を main にマージ／着地させる承認を kim に渡す」。
- 最新は 2026-10-24T04:36:20.208Z。**検出器修正 #1075（`89f3eea`・2026-10-24T16:04:05Z）の着地以降は 0 行**
  （`--since 2026-10-24T16:04:06Z` で stop-gate 0 / audit 0 / nightly 0。`--since 2026-10-25T00:00:00Z` も同様）。

### 限界

- 走査対象は台帳に残った `excerpt` / `violations[].quote` のみ。`tools/stop-gate-runner.mjs` が
  `excerpt` を先頭 **200 文字**で切るため、末尾フッターだけに書かれた先送りは台帳走査に出ない。
  よって上の 24 行は**下限**であり、#1075 着地後の「0 行」も先送りが無かった証明にはならない。
- 台帳に書かれなかった先送りは対象外（従来と同じ）。

## 2. 先送りの実体: 解消済み（kim の承認は不要）

- `git merge-base --is-ancestor f94ee7a origin/main` = **exit 1**（squash 着地のため祖先ではない）。
- 同一変更は **PR #1047**（squash commit `0449b88`・`2026-10-23T15:44:33Z`）として origin/main に着地済み。
- 実物: `origin/main:tools/stop-gate-runner.mjs:134-140` に、`f94ee7a` が足した再評価ブロック
  （「先行 gate が発火して第2段を飛ばしたのに…」＋
  `audit.record.skipped === 'regex-blocked' && !evaluated.results.length` の第2段評価）が同一文言で存在。
  `tools/stop-gate-runner-audit-reeval.test.mjs` も main に存在。
- ブランチ `quota-sweep/20261023-0202-claude-mvkbrycs` は origin に残る（tip `68c0de0`）が、
  取り込むべき差分は上記で main に吸収済み。
- **「承認が要る判断だから人の判断として残す」「上限の引き上げか判断がない限り新規作業は行いません」という前提は成立しない**:
  着地は PR + CI + `automerge` という既存の承認経路で完了しており、コミット単位の kim 承認を必要としなかった。

## 3. 恒久修正: ライブで効いていることを実測

- 着地承認型の検出（`isLandingDeferral`）は main `89f3eea`（PR #1075）に着地。
- 本番 Stop hook が読む `~/.claude/nightly-repo` は HEAD `9d98831`（＝測定時の origin/main）・クリーンで、
  `tools/permanent-fix-deferral-scan.mjs` と `tools/next-action-gate.mjs` に `isLandingDeferral` 各2箇所を実測。
- `origin/main:tools/next-action-gate.mjs:200` が `isLandingDeferral(footer.nextAction)` を評価する。
- 原文（台帳 `auditEvidence.text` の全文）に現行コードを直接適用した結果（今回の実測）:

| 入力 | 現行判定 |
|---|---|
| 原文全文 | `detect()` = **P3** / `judgeNextAction()` = **`block` / `NEXT-ACTION-DEFERRAL`** |
| 原文の `次に kim がすること` 行のみ | `isLandingDeferral()` = **`true`** |
| 台帳 `excerpt`（200 文字でフッター欠落） | `block` / `NEXT-ACTION-FOOTER` |

→ 同じ文面をもう一度書いても通らない。当時 `pass` だった `handoff-audit-ledger.jsonl:1341` も、
現行の `judgeNextAction` は素通りさせない。先送りを解消せずに終える経路は閉じている。

- 増殖側も止めた: 1つの違反セッションから同型の監査 TODO が8本生成された機構に対し、
  同一セッションの検出を1本に畳む修正（#1071）と、記録済み route の監査TODO再起票を止める修正（#1080・`8b3375e`）が
  main に着地済み。

## 4. 操作の範囲

送信・DM・権限変更・main への直接マージは行っていない。
台帳・nightly-repo の読み取り、git 照会、検証用ブランチへのこの文書の追加のみ。
