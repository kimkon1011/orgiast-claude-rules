# handoff-audit:aa2f4632eab37e77 再発検証（2026-10-25）

## 対象

検出: **2026-10-23T07:21:10.517Z / session `66f6c883-8a60-4acd-be84-104b8f3ff52e` / P3**。

台帳上の実体は `~/.claude/stop-gate-runner-ledger.jsonl:575`（`verdict=block` /
`reasonCodes=NEXT-ACTION-FOOTER`）、`~/.claude/handoff-audit-ledger.jsonl:1342`（同文・`pass`）、
`~/.claude/handoff-audit-deferral-ledger.jsonl:24`（`block`）。

> ITERATING。今回は新規作業なしです。マージ判断が残っています。
>
> 次に kim がすること: 修正 f94ee7a(ブランチ `quota-sweep/20261023-0202-claude-mvkbrycs`)を main にマージするか判断してください。
>
> 恒久策: 一回限り: main へのマージ可否は、この修正の内容を見たうえでの承認判断です。
> 自動化すると承認という安全機構を外すことになるので、人の判断として残します。

`f94ee7a` の main 着地承認を kim に渡す同一起源の監査 TODO のうち、`7432e46b` の**直前の行**にあたる
（`7432e46b` は 07:21:13.894Z・同セッション）。既記録: `e2de84a9`（#1069）・`be409e2e`（#1071）・
`5dd97c87`（#1075）・`10d7b407`（#1077）・`7432e46b`（#1081）。本ドキュメントで当該セッション由来の残りを閉じる。

## 1. 再発の有無: 同型は再発している（逐語は原文セッションのみ）

走査: `node tools/permanent-fix-deferral-scan.mjs --since 2026-10-23T07:21:10.517Z`
（本ブランチの検出器は origin/main と同一 blob `ee7c818`）。

| 台帳 | 窓内行数 | hits | 内訳 |
|---|---|---|---|
| `stop-gate-runner-ledger.jsonl` | 631 | **20** | P3 20（10-23: 18 / 10-24: 2） |
| `handoff-audit-ledger.jsonl` | 1496 | 0 | – |
| `handoff-audit-nightly-ledger.jsonl` | 45 | **3** | P3 3（すべて 10-23） |

合計 **23 行**（原文行を含む）。セッション別:

| session | 行 | 時刻 |
|---|---|---|
| `66f6c883`（原文） | 3 | 07:21:10.517（原文）／07:21:13.894／07:21:17.140（同一バーストの言い換え） |
| `408cde0a` | 3 | 07:22:37〜07:22:43 |
| `9310953f` | 8 | 07:23:09〜07:23:25 |
| `342a5479` | 4 | 07:23:51〜07:24:01（うち 1 行は `pass`） |
| `e955379b` / `f1fa8f2a` / `aa8b6736`（nightly） | 各1 | 10-23T18:03〜18:04 |
| `8ea416ef` | 1 | 10-24T04:34:09 |
| `61af55b9` | 1 | **10-24T04:36:20（最新）** |

- **逐語の再発は原文セッションの外に無い**: 4 台帳
  （stop-gate / audit / nightly / deferral）で「マージ判断が残っています。…修正 f94ee7a」または
  「承認という安全機構」を含む行は **8 行**（stop-gate 575/576/583・audit 1342/1343/1349・
  deferral 24/25）で、すべて `66f6c883` の 2026-10-23T07:21:10〜07:21:57。
- **同型の再発は 20 行 / 8 セッション**（原文セッションの 3 行を除く）。内容はすべて
  「`f94ee7a` を main にマージ／着地させる承認を kim に渡す」。
- 最新は 2026-10-24T04:36:20.208Z。**検出器修正 #1075 の着地（2026-10-24T16:04:06Z）以降は 0 行**
  （`--since 2026-10-24T15:38:00Z` で stop-gate 0 / audit 0 / nightly 0、P1〜P4・W すべて 0）。

### 限界

- 走査対象は台帳に残った `excerpt` / `violations[].quote` のみ。`tools/stop-gate-runner.mjs:111` が
  `excerpt` を先頭 **200 文字**で切るため、末尾フッターだけに書かれた先送りは台帳走査に出ない
  （本件の最終文 07:21:57.966 がその実例。台帳の excerpt は `P3` に一致しない）。
  よって上の 23 行は**下限**であり、#1075 着地後の「0 行」も先送りが無かった証明にはならない。
- 台帳に書かれなかった先送りは対象外（従来と同じ）。

## 2. 先送りの実体: 解消済み（kim の承認は不要）

- `git merge-base --is-ancestor f94ee7a origin/main` = **exit 1**（squash 着地のため祖先ではない）。
- 同一変更は **PR #1047**（squash commit `0449b88`・`2026-10-23 15:44:33 +0000`）として origin/main に着地済み。
- 実物: `origin/main:tools/stop-gate-runner.mjs:134-140` に、`f94ee7a` が足した5行
  （「先行 gate が発火して第2段を飛ばしたのに…」＋ `audit.record.skipped === 'regex-blocked' && !evaluated.results.length`
  の第2段再評価）が同一文言で存在。`tools/stop-gate-runner-audit-reeval.test.mjs` も main に存在。
- ブランチ `quota-sweep/20261023-0202-claude-mvkbrycs` は origin に残る（tip `68c0de0`）が、
  取り込むべき差分は上記で main に吸収済み。
- **「自動化すると承認という安全機構を外す」という前提は成立しない**: 着地は PR + CI + `automerge`
  という既存の承認経路で完了しており、コミット単位の kim 承認を必要としなかった。

## 3. 恒久修正: ライブで効いていることを実測

- 着地承認型の検出（`isLandingDeferral`）は main `89f3eea`（PR #1075）に着地。
- 本番 Stop hook が読む `~/.claude/nightly-repo` は HEAD `2350ed7`（＝測定時の origin/main）・クリーンで、
  `tools/permanent-fix-deferral-scan.mjs` と `tools/next-action-gate.mjs` に `isLandingDeferral` 各2箇所を実測。
- `origin/main:tools/next-action-gate.mjs:200` が `isLandingDeferral(footer.nextAction)` を評価する。
- 実文に現行コードを直接適用した結果（今回の実測）:

| 入力 | 現行判定 |
|---|---|
| 原文全文（`恒久策:` 行がフッターの後ろにある） | `block / NEXT-ACTION-FOOTER`（フッター3行の順序で先に止まる） |
| フッターを正規化（末尾の `恒久策:` 行を外す） | **`block / NEXT-ACTION-DEFERRAL`** |
| 次アクション行のみ `isLandingDeferral()` | **`true`** |
| `detect()`（excerpt / 全文） | **`P3` / `P3`** |

→ 同じ文面をもう一度書いても通らない。当時 `pass` だった行（audit 1342）も、現行の
`judgeNextAction` は素通りさせない。先送りを解消せずに終える経路は閉じている。

## 4. 操作の範囲

送信・DM・権限変更・main への直接マージは行っていない。
台帳・nightly-repo の読み取り、git 照会、検証用ブランチへのこの文書の追加のみ。
