# handoff-audit:7432e46b54bdfb61 再発検証（2026-10-25）

## 対象

検出: **2026-10-23T07:21:13.894Z / session `66f6c883-8a60-4acd-be84-104b8f3ff52e` / P3**。
台帳は `~/.claude/stop-gate-runner-ledger.jsonl:576`（`verdict=block`）と
`~/.claude/handoff-audit-ledger.jsonl:1343`（同文・`verdict=pass`）。

> 恒久策: 一回限り: main へのマージ可否は、この修正の内容を見たうえでの承認判断です。
> 自動化すると承認という安全機構を外すことになるので、人の判断として残します。
>
> 次に kim がすること: 修正 f94ee7a(ブランチ `quota-sweep/20261023-0202-claude-mvkbrycs`)を main にマージするか判断してください。

同一起源（`f94ee7a` の main 着地承認）の監査 TODO 8 本のうち 6 本目。
既記録: `e2de84a9`（#1069）・`be409e2e`（#1071）・`5dd97c87`（#1075）・`10d7b407`（#1077）・`e4fbe4a9`（#1078・open）。

## 1. 再発の有無: 同型は再発している（逐語は原文セッションのみ）

走査: `node tools/permanent-fix-deferral-scan.mjs --since 2026-10-23T07:21:13.894Z --json`
（main と同一 blob `ee7c818` の検出器）。

| 台帳 | 窓内行数 | hits | 内訳 |
|---|---|---|---|
| `stop-gate-runner-ledger.jsonl` | 631 | **19** | P3 19（10-23: 17 / 10-24: 2） |
| `handoff-audit-ledger.jsonl` | 1496 | 0 | – |
| `handoff-audit-nightly-ledger.jsonl` | 45 | **3** | P3 3（すべて 10-23） |

合計 **22 行**。セッション別:

| session | 行 | 時刻 |
|---|---|---|
| `66f6c883`（原文） | 2 | 07:21:13.894（原文）／07:21:17.140（同一バーストの言い換え） |
| `408cde0a` | 3 | 07:22:37〜07:22:43 |
| `9310953f` | 8 | 07:23:09〜07:23:25 |
| `342a5479` | 4 | 07:23:51〜07:24:01 |
| `e955379b` / `f1fa8f2a` / `aa8b6736`（nightly） | 各1 | 10-23T18:03〜18:04 |
| `8ea416ef` | 1 | 10-24T04:34:09 |
| `61af55b9` | 1 | **10-24T04:36:20（最新）** |

- **逐語の再発は 0**: 「安全機構」「人の判断として残」「承認という」を含む行は、
  4 台帳（stop-gate / audit / nightly / deferral）の窓内で原文セッションの 2 行だけ。
- **同型の再発は 20 行 / 8 セッション**（原文 1 行と同一バースト 1 行を除く）。
  内容はすべて「`f94ee7a` を main にマージ／着地させる承認を kim に渡す」。
- 最新は 2026-10-24T04:36:20.208Z。**検出器修正 #1075 の着地（2026-10-24T16:04:06Z）以降は 0 行**。

### 修正前の検出器では 6 行しか出なかった（死角の実測）

同じ窓を `c973dea` 時点の検出器（`isLandingDeferral` 導入前）で走査すると **6 行**（すべて stop-gate）。
**16 行が死角**。着地承認型は FIX 語（修正・実装・恒久…）を含まないため P3 に一致しない。

実例: 原文セッションの最終文（2026-10-23T07:21:57.910Z・当時 `verdict=pass`）は

> 次に kim がすること: Claude Code のチャットに「ブランチ quota-sweep/20261023-0202-claude-mvkbrycs を main にマージして」と送ってください。

で、旧検出器 = 0 件 / 現行検出器 = P3。この文が通ったことでループが先送りのまま抜けた。

### 限界

- `tools/stop-gate-runner.mjs:111` が `excerpt` を先頭 **200 文字**で切るため、
  末尾フッターに書かれた先送りは台帳走査に出ない（上記 07:21:57 がその実例）。
  よって上の 22 行は**下限**であり、#1075 着地後の「0 行」も「先送りが無かった」証明にはならない。
- 台帳に書かれなかった先送りは対象外（従来と同じ）。

## 2. 先送りの実体: 解消済み（kim の承認は不要）

- `git merge-base --is-ancestor f94ee7a origin/main` = **exit 1**（squash 着地のため祖先ではない）。
- 同一変更は **PR #1047**（merged 2026-10-23T15:44:34Z / merge_commit `0449b88`）として main に着地済み。
- 実物: `origin/main:tools/stop-gate-runner.mjs:135-140` に、`f94ee7a` が足した5行
  （`audit.record.skipped === 'regex-blocked' && !evaluated.results.length` の第2段再評価）が同一内容で存在。
- ブランチ `quota-sweep/20261023-0202-claude-mvkbrycs` は origin に残る（tip `68c0de0`）が、
  配下のコードファイルは main と同一 blob（`tools/handoff-audit-rescan.mjs`（`2f8169c`）・
  `tools/stop-gate-runner-audit-reeval.test.mjs`（`3721ea3`）を実測）。
- **「自動化すると承認という安全機構を外す」という前提は成立しない**: 着地は PR + `automerge` ラベル
  という既存の承認経路で完了しており、コミット単位の kim 承認を必要としなかった。

## 3. 恒久修正: ライブで効いていることを実測

- 着地承認型の検出（`isLandingDeferral`）は main `89f3eea`（PR #1075）に着地。
- 本番 Stop hook は `~/.claude/settings.json` → `~/.claude/nightly-repo/tools/stop-gate-runner.mjs`。
  測定時点の nightly-repo は HEAD `8259037`（当時の origin/main と一致）・クリーン・
  `isLandingDeferral` 2 箇所を実測。
- `origin/main:tools/next-action-gate.mjs:200` が `isLandingDeferral(footer.nextAction)` を評価する。
- 実文に `judgeNextAction()` を直接適用した結果（今回の実測）:

| 実文 | 当時の判定 | 現行判定 |
|---|---|---|
| 原文 07:21:13.801（handoff-audit-ledger:1343） | `pass` | **block / NEXT-ACTION-DEFERRAL** |
| 最終文 07:21:57.910（同:1349） | `pass`（この文でループが抜けた） | **block / NEXT-ACTION-DEFERRAL** |

→ 同じ文面をもう一度書いても通らない。先送りを解消せずに終える経路は閉じている。

## 4. 操作の範囲

送信・DM・権限変更・main への直接マージは行っていない。
台帳の読み取り、git / GitHub API の照会、検証用ブランチへのこの文書の追加のみ。
