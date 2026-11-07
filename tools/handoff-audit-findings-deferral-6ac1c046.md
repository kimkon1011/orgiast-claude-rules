# handoff-audit 検証記録: `6ac1c04694d4dc1c`（W / b822034d）の再発検証（2026-10-23）

対象 TODO: `[handoff-audit:6ac1c04694d4dc1c] 恒久修正の先送り文を検出（2026-10-21T06:00:01.905Z / b822034d / W）`
「Codex の修正完了を待っています。」（`~/.claude/next-session.md`）。
検出器は `tools/permanent-fix-deferral-scan.mjs`（夜間 `handoff-audit-nightly` が実行）、
Stop 時の実ゲートは `tools/deferral-wait-gate.mjs`。

送信なし・権限変更なし・kim への DM なし。既存の承認範囲のみ。

## 結論（4点）

1. **原文の逐語再発は無い。** 3 台帳を全走査し、原文と一致する行は当該ターンの記録 2 行
   （`stop-gate-runner-ledger` 06:00:01.905Z と `handoff-audit-ledger` 06:00:01.900Z が
   同一ターンを記録したもの）だけ。以後の出現は 0（§2）。
2. **同型（W＝完了待ち）は事象後に 1 件だけ。** `2026-10-21T06:18:53.259Z` の
   「Codex のリンク実装の完了を待ってから、このスクリプトを実行します。」で、これは
   `handoff-audit:e50806fb45fa141c` として別途検証済み・PR #988 でゲートが block するようになった。
   06:18:53 以降（10-22〜10-23、388 行）の W ヒットは 0。
3. **先送りされた Codex 修正は、同じセッションの 27 分後に実装・本番確認まで完了している。**
   `keiri-hub` の `57e5274`（2026-10-21 15:27:21 +0900 = 06:27:21Z）に
   「前回 退職金扱いの人は次回の対象から外す」（`applyPreviousExclusions`）と参照元リンク表示が入り、
   `main` に含まれる。06:33:13Z のターンで「本番の画面に出しました（commit 57e5274、本番 e2e 8件通過）」
   と報告済み（§3）。
4. **裸の待機文は現行ゲートでは pass（設計境界・実測）。** 一方で夜間検出器は W として拾う。
   これは「夜間監査は候補として surface し、Stop ゲートは後続作業が近接するときだけ block する」
   という二段構えで、既存テストにも固定されている（§4・§5）。

## 1. 原文の再現（一次証拠）

`~/.claude/stop-gate-runner-ledger.jsonl` の `2026-10-21T06:00:01.905Z` 行:

```
sessionId: b822034d-f3e2-474d-ad5f-98fb68ddc755
verdict:   pass / blockedBy: [] / reasonCodes: []
excerpt:   Codex の修正完了を待っています。
```

同ターンの `handoff-audit-ledger.jsonl` 行（06:00:01.900Z）も同じ excerpt で `pass`。
`detect()` に通すと `W`（一致語 `完了を待って`）。当時の Stop ゲートは後続作業の近接を
要求するため pass。

## 2. 再発の有無（実物の台帳を全走査）

逐語一致（3 台帳の JSON 全行走査・2026-10-23 実行）:

| 台帳 | 原文一致行 | 時刻 |
|---|---|---|
| `stop-gate-runner-ledger.jsonl` | 1 | 2026-10-21T06:00:01.905Z（当該ターン） |
| `handoff-audit-ledger.jsonl` | 1 | 2026-10-21T06:00:01.900Z（当該ターン） |
| `handoff-audit-nightly-ledger.jsonl` | 0 | — |

同型 W の全走査 `node tools/permanent-fix-deferral-scan.mjs --since 2026-10-21T06:00:02Z`:

| 台帳 | total | hits | 内訳 |
|---|---|---|---|
| `stop-gate-runner-ledger.jsonl` | 388 | **1** | `W:1`（06:18:53.259Z / `b822034d`・e50806fb の対象行） |
| `handoff-audit-ledger.jsonl` | 668 | 0 | — |
| `handoff-audit-nightly-ledger.jsonl` | 36 | 0 | — |

当該セッションの前後（06:00〜06:33）の流れ:

| ts | excerpt（先頭） |
|---|---|
| 06:00:01.905Z | **原文**（Codex の修正完了を待っています。） |
| 06:10:28.647Z | `/shoyo` を本番で通した報告（block・next-action-gate） |
| 06:13:00.123Z | 同上の報告（pass） |
| 06:16:12.186Z | Codex がリンク表示を実装中 |
| 06:18:53.259Z | リンク実装の完了を待ってから実行（e50806fb・現在は block） |
| 06:24:12.774Z | Codex が退職金扱いの自動除外を実装中 |
| 06:33:13.034Z | **完了報告**（commit 57e5274・本番 e2e 8件通過） |

＝原文は長時間セッションの途中経過で、そのセッションは 33 分後に実質的な完了報告へ到達している。
待機で成果は失われていない。コストは「ターンを閉じた回数」そのもの。

## 3. 先送りされた修正の末路（実物で確認）

`C:\Users\test\Desktop\ClaudeCode\keiri-hub`:

| 実物 | 内容 |
|---|---|
| `57e5274`（2026-10-21 15:27:21 +0900） | 「賞与: 参照した元データ（シート・台帳・マニュアル）のリンクを画面に表示／前回 退職金扱いの人は次回の対象から外す」 |
| `src/lib/shoyo/calc.ts` の差分 | `applyPreviousExclusions()` を追加。前回 `kind === "退職金"` の人を次回の候補から除外し、理由付きで `excluded` に積む |
| `src/lib/shoyo/ids.ts` / `links.ts` | シート・フォルダ・台帳・マニュアルの URL を画面に出すための ID/リンク定義 |
| `git branch --contains 57e5274` | `main`・`origin/main` に含まれる |

06:33:13Z のターンで「本番の画面に出しました（commit 57e5274、本番 e2e 8件通過）」と報告済み。
待機の対象だった修正そのものは、違反ターンではなく**同じセッションの後続ターンで実装・確認まで完了**した。

## 4. 生きたゲートの実測（repo と配備先）

`judge('Codex の修正完了を待っています。')`:

| 対象 | 判定 |
|---|---|
| `tools/deferral-wait-gate.mjs`（repo, origin/main 8d974eb） | **pass** |
| `~/.claude/nightly-repo/tools/deferral-wait-gate.mjs`（Stop hook の実体） | **pass** |

理由: ゲートは「待機語＋160 字以内の後続作業（終わり次第・届いたら・待ってから等）」を
違反条件にしている。裸の待機文には後続作業が無いため対象外（`tools/handoff-audit-findings-deferral-3423fc16.md`
§5 と `52be4096` §5 の設計判断を維持）。夜間検出器 `permanent-fix-deferral-scan.mjs` の `W` は
候補抽出として裸の待機文も拾う（`tools/permanent-fix-deferral-scan.test.mjs` の
「委譲の完了待ちはW(待機)であって先送り(P1-P4)ではない」で固定）。両者の役割分担は意図どおり。

## 5. 当ターンで直したもの / 直さなかったもの

**直したもの（回帰テスト）:** 原文の実 excerpt を `tools/deferral-wait-gate.test.mjs` の
negatives に追加し、Stop ゲートが pass する境界を逐語で固定した。夜間検出器側でも
同じ excerpt が `W` になることを `tools/permanent-fix-deferral-scan.test.mjs` に追加し、
「nightly は拾う・gate は後続作業が無ければ通す」二段構えを明示した。

**直さなかったもの:** 裸の待機文の block 化。後続作業を書かない一文はステータス報告と
区別できず、`CI の完了を待っています。` のような既存の非対象ケースまで巻き込む。
未解決の先送りではなく、ゲートの設計境界として残す。

## 6. 未確認

| # | 未確認事項 |
|---|---|
| U1 | `/shoyo` 本番画面の実表示は当ターンで再確認していない（元セッションの e2e 8件通過と `main` の commit のみ確認） |
| U2 | 裸の待機文が今後も出るか（ゲート対象外・nightly は拾う）。出た場合は同じ二段構えの判断になる |

## 7. 次に kim がすること

**なし。** 本記録と回帰テストを PR に載せ、`automerge` ラベルで CI green 後に自動マージする。
