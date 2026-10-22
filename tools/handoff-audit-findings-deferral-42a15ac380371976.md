# handoff-audit 42a15ac380371976 再発検証（提案の採否を user 返信に委ねて停止）

検証日: 2026-10-23 / 走査窓: 2026-10-22T18:00:00Z 〜 台帳末尾（2026-10-22T22:06Z）

## 結論（3点）

1. 原文を特定した。夜間台帳 2 行（セッション f8387b05 / 677e8433、どちらも 2026-10-22 の提案採否待ち停止）。
2. 原文以降の窓では逐語再発 0 件・同型再発 0 件。ただし窓は約4時間・計 13 行で狭く、「再発なし」とは断定しない（C2 は時間依存）。
3. 検出器に欠陥がある。原文の2セッションは Stop gate の最終判定が `pass` で、4検出器に 採否／「承認」か「却下」の語彙が無い。C4（最小修正＋回帰テスト）が必要。

## §1 原文（C1）

ID `42a15ac380371976` = sha256(JSON([key("提案の採否をuser返信で決めさせて停止"), key("codex-do.mjs")])) の先頭16桁（`tools/handoff-audit-nightly.mjs` の `enqueueTodos` と同式で再計算し一致を確認）。

| ts | sessionId | verdict | 抜粋（quote） | 台帳 |
| --- | --- | --- | --- | --- |
| 2026-10-22T18:00:14Z | f8387b05-8e92-43b2-9e9f-6fb0b7f8ef73 | block | 「承認」か「却下 <理由>」で返信する（おすすめは却下） | handoff-audit-nightly-ledger.jsonl:165 |
| 2026-10-22T18:00:23Z | 677e8433-e2cf-4cb3-bdf9-5dd6fc3e13e0 | block | 「承認」または「却下 <理由>」を送ってください／返事が来るまでは何もしません | handoff-audit-nightly-ledger.jsonl:166 |

昇格: handoff-audit-promotions.jsonl:13（pattern「提案の採否をuser返信で決めさせて停止」/ route `codex-do.mjs` / high）。

## §2 全台帳走査（C2）

語彙: `採否|「承認」か/または「却下|却下 <|返事が来るまで|返信待ち|返信で決` ほか。`tools/permanent-fix-deferral-scan.mjs --since 2026-10-22T18:00:00Z` も実行（別系統の語彙。全台帳 hits 0）。

| 台帳 | total | 窓内 | 語彙ヒット | 内訳 |
| --- | --- | --- | --- | --- |
| stop-gate-runner-ledger.jsonl | 1012 | 5 | 1 | 966ac0df 10-22T22:05:53Z block(NEXT-ACTION-FOOTER)。本契約の Loop brief 文面が「採否」を引用したもの＝引用 |
| handoff-audit-ledger.jsonl | 794 | 5 | 1 | 同 966ac0df 22:05:53Z pass。同じ引用 |
| handoff-audit-nightly-ledger.jsonl | 167 | 3 | 2 | §1 の原文2行（原文そのもの） |
| handoff-audit-deferral-ledger.jsonl | 38 | 1 | 0 | — |

- (a) 逐語再発: 0 件
- (b) 同型再発（引用・原文を除く）: 0 件
- 引用（別枠）: 2 行（966ac0df、`[handoff-audit:42a15ac380371976]` を読んだだけで違反に数えない）

## §3 検出器判定（C3）

原文2セッションの Stop gate 実物（stop-gate-runner-ledger.jsonl、sessionId 先頭8桁で抽出）:

- f8387b05: 19 行。最終行 2026-10-22T12:06:43Z `pass`（途中は next-action-gate / handoff-regret-gate / user-burden-gate 等で block、sameTextRetries 1 → 0 で通過）
- 677e8433: 4 行。最終行 2026-10-22T11:48:34Z `pass`（NEXT-ACTION-FOOTER / PERMANENT-FIX-REQUIRED で block 後に通過）

検出器の語彙 grep（`採否|承認.{0,4}却下`）: `decision-research-gate.mjs` / `deferral-wait-gate.mjs` / `permanent-fix-deferral-scan.mjs` / `next-action-gate.mjs` すべて 0 件。

判定: 欠陥あり。Stop gate は当該文面を最終的に通し、夜間監査（18:00Z）が事後に block と判定した。検出器が「採否を user の返信に委ねて停止」を直接拾えていない。

## §4 修正（C4）

未実施（Iteration 1 は C1〜C3 まで）。次手: `tools/codex-do.mjs` へ最小修正＋回帰テスト1件を指示ファイル（`.loop/`）で委譲する。修正は検出語彙の追加であり、既存語彙は狭めない。

## §5 残件

- C4 修正委譲、C6 `node --test tools/`、C5 の結論更新（修正後に §4 を実物で更新）
- 窓が狭いため、時間が経った後の再走査で再発なしを確認する
