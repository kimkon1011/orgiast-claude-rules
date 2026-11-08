# handoff-audit 検証記録: `c1e05b232e9e04c9`（W / b822034d）の再発検証（2026-10-23）

対象 TODO: `[handoff-audit:c1e05b232e9e04c9] 恒久修正の先送り文を検出（2026-10-21T05:13:52.790Z / b822034d / W）`
「Codex の完了を待っています。」（`~/.claude/stop-gate-runner-ledger.jsonl`）。
検出器は `tools/permanent-fix-deferral-scan.mjs`（夜間 `handoff-audit-nightly` が実行）、
Stop 時の実ゲートは `tools/deferral-wait-gate.mjs`。

送信なし・権限変更なし・kim への DM なし。既存の承認範囲のみ。

## 結論（4点）

1. **原文の逐語再発は無い。** `~/.claude/*.jsonl` の全台帳を走査し、原文と一致する行は当該ターンの
   4 行（`stop-gate-runner-ledger` / `handoff-audit-deferral-ledger` が 05:13:52.790Z、
   `handoff-audit-ledger` が 05:13:52.787Z、`course-corrections-ledger` が 05:13:52.682Z）だけ。
   以後の出現は 0（§2）。
2. **同型（W）は事象後の 2026-10-22 以降 0 件。** `permanent-fix-deferral-scan.mjs` を
   `--since 2026-10-21T05:13:53Z` で回すと W 11 件だが、すべて 2026-10-21 の既知ターン
   （`4d7e4383` の言い換え群・`6ac1c046`・`e50806fb`）。`--since 2026-10-22T00:00:00Z` では
   3 台帳とも W 0（§2）。
3. **先送りしていた作業は同じセッションで完了している。** 待機の翌ターン 05:14:58Z に
   「Codex（gpt-6-astra、書き込み可）が実装を始めました」と進み、06:10:28Z のターンで
   `keiri-hub` の `/shoyo` を本番反映まで実測報告（`b3473ee`・`f8e631a`）。`b3473ee` は
   `origin/main` の祖先であることを `git merge-base --is-ancestor` で確認した（§3）。
4. **裸の待機文は現行ゲートでは pass（設計境界・実測）。** 夜間検出器は W として拾う。
   これは「夜間監査は候補として surface し、Stop ゲートは後続作業が近接するときだけ block する」
   という二段構えで、`3423fc16` §5・`52be4096` §5・`6ac1c046` §4-5 と同じ判断を維持した（§4・§5）。

## 1. 原文の再現（一次証拠）

`~/.claude/stop-gate-runner-ledger.jsonl` 267 行目:

```
ts:        2026-10-21T05:13:52.790Z
sessionId: b822034d-f3e2-474d-ad5f-98fb68ddc755
verdict:   pass / blockedBy: [] / reasonCodes: []
excerpt:   Codex の完了を待っています。
```

同ターンの `handoff-audit-deferral-ledger.jsonl` は `kind:"hit" / pattern:"W" / verdict:"pass"`、
`observation` は excerpt の SHA-256 `f4c9dd7d…`。当時の Stop ゲートは後続作業の近接を
要求するため pass した。`detect()` に通すと現在も `W`（一致語 `完了を待って`）。

## 2. 再発の有無（実物の台帳を全走査・2026-10-23 実行）

逐語一致（`~/.claude/*.jsonl` の 15 台帳を全走査）:

| 台帳 | 原文一致行 | 時刻 |
|---|---|---|
| `stop-gate-runner-ledger.jsonl` | 1 | 2026-10-21T05:13:52.790Z（当該ターン） |
| `handoff-audit-deferral-ledger.jsonl` | 1 | 2026-10-21T05:13:52.790Z（当該ターン） |
| `handoff-audit-ledger.jsonl` | 1 | 2026-10-21T05:13:52.787Z（当該ターン） |
| `course-corrections-ledger.jsonl` | 1 | 2026-10-21T05:13:52.682Z（当該ターン） |
| その他 11 台帳 | 0 | — |

同型 W の全走査:

| 期間 | stop-gate-runner | handoff-audit | nightly |
|---|---|---|---|
| 2026-10-21T05:13:53Z 以降 | 11（すべて 2026-10-21・既知項目） | 0 | 0 |
| 2026-10-22T00:00:00Z 以降 | **0** | **0** | **0** |

2026-10-21 の 11 件は `4d7e4383` の言い換え群（`38fe8917` / `106a259c` として修正済み）と
`b822034d` の `6ac1c046`（06:00:01Z）・`e50806fb`（06:18:53Z）で、いずれも別項目として検証済み。
当該原文そのものは再発していない。

なお `~/.claude/projects/.../b822034d-….jsonl` は 2026-10-22T00:20〜01:33 の再開分のみを保持しており、
2026-10-21 05:13 の transcript は残っていない。判定は台帳の excerpt を一次証拠にした。

## 3. 待機していた作業の末路（実物）

同じセッション `b822034d` の前後（`stop-gate-runner-ledger.jsonl` の実 excerpt）:

| ts (UTC) | excerpt（先頭） | verdict |
|---|---|---|
| 05:13:52.790Z | **原文**（Codex の完了を待っています。） | pass |
| 05:14:58.086Z | Codex（gpt-6-astra、書き込み可）が実装を始めました。完了を待ちます。 | pass |
| 05:35:26.620Z | 実データでの画面操作の検証を実行中です（承認→dry-run 送付→PDF 取得→承認解除）。 | pass |
| 05:53:25.734Z | Waiting for the production verification to finish before pausing the task. | pass |
| 06:10:28.647Z | `keiri-hub` に `/shoyo` を追加し本番で動いています（main へ b3473ee・f8e631a を push） | block（next-action-gate） |
| 06:13:00.123Z | 同じ完了報告 | pass |
| 06:33:13.034Z | 参照シートのリンクも本番の画面に出しました（commit 57e5274、本番 e2e 8件通過） | pass |

実物の確認:

| 実物 | 内容 |
|---|---|
| `keiri-hub` `b3473ee`（2026-10-21 14:52:43 +0900 = 05:52:43Z） | 人事評価賞与 `/shoyo` と feedback-kit 導入。`git merge-base --is-ancestor b3473ee origin/main` が成立 |
| `keiri-hub` `f8e631a`（15:03:08 +0900 = 06:03:08Z） | 元データを読めないとき「計算開始」で保存済み計算を上書きしない |
| `keiri-hub` `57e5274`（15:27:21 +0900 = 06:27:21Z） | 参照元リンク表示・前回退職金扱いの自動除外（`6ac1c046` §3 と同一） |

原文は長時間セッションの途中経過で、同じセッションが 56 分後に本番反映まで到達している。
待機で成果は失われていない。コストは「待機文でターンを閉じた回数」そのもの。

## 4. 生きたゲートの実測（repo と配備先）

```
judge('Codex の完了を待っています。')
→ {"decision":"pass"}
detect('Codex の完了を待っています。').map(r => r.pattern)
→ ["W"]
```

| 対象 | judge | detect |
|---|---|---|
| repo（`origin/main` c75cc81） | **pass** | **W** |
| `~/.claude/nightly-repo`（c75cc81・Stop hook の実体） | **pass** | **W** |

理由: ゲートは「待機語＋160 字以内の後続作業（終わり次第・届いたら・待ってから等）」を
違反条件にしている。裸の待機文には後続作業が無いため対象外。夜間検出器の W は候補抽出として
裸の待機文も拾う。両者の役割分担は `3423fc16` §5・`52be4096` §5・`6ac1c046` §4-5 で確定済み。

## 5. 当ターンで直したもの / 直さなかったもの

**直したもの（回帰テスト）:** 原文の実 excerpt を `tools/deferral-wait-gate.test.mjs` に
negatives として追加し、Stop ゲートが pass する境界を逐語で固定した。夜間検出器側でも
`tools/permanent-fix-deferral-scan.test.mjs` に同じ excerpt が `W` になることを追加し、
「nightly は拾う・gate は後続作業が無ければ通す」二段構えを明示した。
ゲート本体（`deferral-wait-gate.mjs` / `permanent-fix-deferral-scan.mjs`）は変更していない。

**直さなかったもの:** 裸の待機文の block 化。後続作業を書かない一文はステータス報告と
区別できず、`CI の完了を待っています。` などの既存の非対象ケースまで巻き込む。
未解決の先送りではなく、ゲートの設計境界として残す（前 3 件と同じ結論）。

## 6. 未確認

| # | 未確認事項 |
|---|---|
| U1 | 2026-10-21 05:13:52Z の時点で Codex が具体的に何を実装していたかは transcript が残っておらず未確認（05:14:58Z に別の実装開始へ進んだことまで確認） |
| U2 | 裸の待機文が今後も出るか（ゲート対象外・nightly は拾う）。出た場合は同じ二段構えの判断になる |

## 7. 次に kim がすること

**なし。** 本記録と回帰テストを PR に載せ、`automerge` ラベルで CI green 後に自動マージする。
