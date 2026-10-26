# handoff-audit:e4fbe4a9ce998f18 再発検証（2026-10-25）

## 対象

2026-10-23T07:23:09.329Z / session `9310953f-dbd9-44a7-a08b-cce62d7f8930` / P3 の先送り文
（`~/.claude/stop-gate-runner-ledger.jsonl` の該当行。`verdict=block` / `blockedBy=[next-action-gate]` /
`reasonCodes=[PERMANENT-FIX-REQUIRED]`）:

> ITERATING
>
> 次に kim がすること: 修正 f94ee7a（ブランチ quota-sweep/20261023-0202-claude-mvkbrycs）を main にマージするか判断する。
> この後の自動進行: 夜間監査（10-23T18:01Z）の後に再走査し、provider 付き verdict があれば FINAL にする。

同一起源の監査 TODO は 8 本あり、`e2de84a9`（#1069）・`be409e2e`（#1071）・`5dd97c87`（#1075）・
`10d7b407`（#1077）は記録済み。本ドキュメントは 5 本目の `e4fbe4a9` を閉じる。

## 1. 再発の有無: **再発している**

検出時刻 `2026-10-23T07:23:09Z` 以降を、**着地承認型を検出できる修正後の走査器**（`isLandingDeferral` 入り・
main `89f3eea` と同一）で再走査した結果:

```
node tools/permanent-fix-deferral-scan.mjs --since 2026-10-23T07:23:09Z
```

| 台帳 | 窓内行数 | hits | 内訳 |
|---|---|---|---|
| `stop-gate-runner-ledger.jsonl` | 631 | **14** | P3 14（10-23: 12 / 10-24: 2） |
| `handoff-audit-ledger.jsonl` | 1496 | 0 | – |
| `handoff-audit-nightly-ledger.jsonl` | 45 | **3** | P3 3（すべて 10-23） |

対象行を除く **16 行**が同型の再発。セッション別では `9310953f`（同一バーストの言い換え 8 行）・
`342a5479`（4 行）・`8ea416ef`（1 行）・`61af55b9`（1 行）・nightly の `e955379b` / `f1fa8f2a` / `aa8b6736`（各 1 行）。
**最新は 2026-10-24T04:36:20.208Z / session `61af55b9`**。

### 既存検出器では 5 行しか出なかった（死角の実測）

同じ窓を main 修正前の検出器（`c973dea`）で走査すると **5 行**（すべて 10-23 の同一バースト）。

- 07:23:09〜07:23:19 の 5 行は「**修正** f94ee7a」を含むため P3 の FIX 語条件に一致した。
- 07:23:21 以降と `342a5479` / `8ea416ef` / `61af55b9` / nightly の 3 行は
  「`f94ee7a` を main に**マージするか判断して承認する**」「**着地させるか承認してください**」の形で、
  FIX 語も先送り語も含まないため **P3 にも next-action-gate にも一致しなかった**。
- ∴ 先行の再発検証（`docs/handoff-audit-2026-10-25-deferral-10d7b407-recheck.md`）の「再発なし」は
  検出器の死角を根拠にしていた。台帳には行が残っていた。

限界: 台帳に残った行だけが対象。台帳に書かれなかった先送り、および
「次に kim がすること: なし（…別ターンで承認します）」の形は引き続き対象外。

## 2. 先送りの実体: 解消済み（kim の承認は不要）

- `f94ee7a` は origin/main の祖先ではない（squash 着地のため）。同じ変更は
  **PR #1047（`0449b88`・merged 2026-10-23T15:44:34Z）** として main に着地済み。
- 実物確認: `origin/main:tools/stop-gate-runner.mjs:135` に
  `if (audit.record.skipped === 'regex-blocked' && !evaluated.results.length) {` の第2段再評価ブロックが存在する。
- ∴ 承認待ちとして残す理由は無く、10-23 07:23 以降に繰り返された先送りは**実体のない先送り**だった。

## 3. 恒久修正: 着地済み

着地承認型を P3 で検出する拡張（着地語 ∧ 具体的識別子 ∧ 承認要求 = `isLandingDeferral`）は
**PR #1075 → `89f3eea`（merged 2026-10-24T16:04:06Z）** で main に着地した。

- `origin/main:tools/permanent-fix-deferral-scan.mjs` の P3 条件に `isLandingDeferral(match[1])` がある（実物確認）。
- ライブの Stop ゲート `tools/next-action-gate.mjs` にも同判定が配線されている。
- 本記録の数値（14 + 3 行）は、この着地済み検出器で再走査して得たもの。

### 残る条件（人の操作は不要）

- 本番の Stop hook と夜間監査が実行する `~/.claude/nightly-repo` は測定時点で `c973dea` のまま/
  `isLandingDeferral` が 0 件だった。ただし `~/.claude/tools/nightly-bootstrap.ps1:170-177` は
  `fetch origin main` → `checkout --detach origin/main` → `reset --hard origin/main` を
  ツリーがクリーンなとき実行する（nightly-repo はクリーンであることを実測）。
  ∴ **次回 bootstrap で `89f3eea` に同期し、追加の人の操作なしに本番経路へ届く。**
  **同期後の初回 nightly でこの型の hits が増えることが、検出器が効いていることの本番実測**になる。
- 修正後の走査でも 10-25 の再発は 0 行（台帳の最終更新 2026-10-24T19:33Z 時点）。

## 4. 操作の範囲

送信・DM・権限変更・main への直接マージは行っていない。台帳の読み取り、git / GitHub API の照会、
検証用ブランチでのこの文書の追加のみ。
