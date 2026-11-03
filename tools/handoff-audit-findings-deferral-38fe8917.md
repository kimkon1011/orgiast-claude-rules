# handoff-audit 検証記録: `38fe891783fc6ce2`（W / 4d7e4383）の再発検証（2026-10-23）

対象 TODO: `[handoff-audit:38fe891783fc6ce2] 恒久修正の先送り文を検出（2026-10-21T05:14:03.146Z / 4d7e4383 / W）`
「アプリ作りのセッションは、実装を任せた Codex の完了待ちです。まだ完了していません。」
（`~/.claude/stop-gate-runner-ledger.jsonl`）。検出器は `tools/permanent-fix-deferral-scan.mjs`（夜間 `handoff-audit-nightly`）、
Stop 時の実ゲートは `tools/deferral-wait-gate.mjs`。

送信なし・権限変更なし・kim への DM なし。既存の承認範囲のみ。

## 結論（4点）

1. **原文の逐語再発は無い。** `~/.claude/*.jsonl` の全台帳を走査し、原文と一致する行は当該ターンの
   4 行（`stop-gate-runner-ledger` / `handoff-audit-deferral-ledger` が 05:14:03.146Z、
   `handoff-audit-ledger` が 05:14:03.142Z、`course-corrections-ledger` が 05:14:02.872Z）だけ。以後の出現は 0（§2）。
2. **同型（他レーンの完了待ち）は、同じセッションが 05:06〜06:00 に 14 ターン閉じている。**
   そのうち 5 ターン（05:35:35 / 05:36:38 / 05:37:59 / 05:47:55 / 05:53:36）は
   「完了はまだです」「〜しているところです」「結果を待っています」と言い換えていて、
   2026-10-23 時点のゲートでは **素通り**していた（§3 の前後表）。当ターンで W とゲートを拡張し、
   この 5 ターンを block するようにした（回帰テスト固定）。
3. **先送りしていた実装は完了している。** `keiri-hub` の `b3473ee`
   （人事評価賞与 `/shoyo` ＋ `e2e/shoyo.spec.ts` ＋ feedback-kit）が main 履歴にあり、
   同じセッションが 06:14:04.718Z のターンで本番 URL・main のコミット・Drive 共有を実測して
   「本番で動いています」と報告している（§4）。待機で成果は失われていない。失われたのはターン数。
4. **現行ゲートはこの原文を block する。** repo（`origin/main` 95ecad2 由来）と配備先
   `~/.claude/nightly-repo` の両方で `block / DEFERRAL-WAIT` を実測（§5）。拡張後は言い換え 5 ターンも block。

## 1. 原文の再現（一次証拠）

`~/.claude/stop-gate-runner-ledger.jsonl` の `2026-10-21T05:14:03.146Z` 行:

```
sessionId: 4d7e4383-0676-451a-9c40-1dcc90a7c40c
verdict:   pass / blockedBy: []
excerpt:
アプリ作りのセッションは、実装を任せた Codex の完了待ちです。まだ完了していません。

次に kim がすること: なし
この後の自動進行: アプリ作りのセッションの完了報告が届いたら、結果を確かめて報告する
このセッション: まだ閉じない（作業中）
```

同じターンの `handoff-audit-deferral-ledger.jsonl` は `kind:"hit" / pattern:"W" / verdict:"pass"`、
`observation` は excerpt の SHA-256 `8fb693c2…`。当時のゲートは「待機語＋近接する後続作業」の
述語を持っておらず pass した。05:36:10.905Z（`handoff-audit:106a259c042d0a32`）は同じ型で、
すでに別途検証・修正済み。

## 2. 再発の有無（実物の台帳を全走査・2026-10-23 実行）

逐語一致（`~/.claude/*.jsonl` の全行走査）:

| 台帳 | 原文一致行 | 時刻 |
|---|---|---|
| `stop-gate-runner-ledger.jsonl` | 1 | 2026-10-21T05:14:03.146Z（当該ターン） |
| `handoff-audit-deferral-ledger.jsonl` | 1 | 2026-10-21T05:14:03.146Z（当該ターン） |
| `handoff-audit-ledger.jsonl` | 1 | 2026-10-21T05:14:03.142Z（当該ターン） |
| `course-corrections-ledger.jsonl` | 1 | 2026-10-21T05:14:02.872Z（当該ターン） |
| `handoff-audit-nightly-ledger.jsonl` | 0 | — |

05:14:03Z より後の W ヒットは 3 件だけで、いずれも既に検証済み
（05:36:10.905Z `106a259c`／06:00:01.905Z `e50806fb`／06:18:53.259Z `6ac1c046`）。

## 3. 当時の素通り（同じセッションの 14 ターン、実 excerpt で前後比較）

`origin/main` のゲート（左）と当ターンの拡張後（右）。すべて `stop-gate-runner-ledger.jsonl` の実 excerpt。

| 時刻 (UTC) | 旧 | 新 | excerpt の要点 |
|---|---|---|---|
| 05:06:43 | pass | pass | 調査中。サブエージェントの結果待ち（レーン名から待機語が 60 字超） |
| 05:07:51 | pass | pass | 調査中（待機語なし） |
| 05:07:58 | pass | pass | 調査中。完了報告が届いた時点で確認（待機語なし・§6 の残り） |
| 05:14:03 | **block** | **block** | 対象の原文（完了待ち） |
| 05:15:06 | **block** | **block** | 完了はまだです＋「終わったら検証する」 |
| 05:32:22 | pass | pass | 型検査・テスト実行中（待機語なし） |
| 05:35:35 | pass | **block** | 画面操作を確かめている最中です＋完了はまだです |
| 05:36:10 | **block** | **block** | 106a259c の原文（完了を待っています） |
| 05:36:38 | pass | **block** | Edge でやり直しているところです |
| 05:37:59 | pass | **block** | 画像を直して再実行しているところです |
| 05:39:51 | pass | pass | 作業内容の説明（待機語なし） |
| 05:47:55 | pass | **block** | 通し確認を実行しているところです |
| 05:53:36 | pass | **block** | 動作確認の結果を待っています＋完了はまだです |
| 06:00:15 | pass | pass | Codex に直させているところです（後続作業を持たない＝設計境界） |

素通りしていた 5 ターンはいずれも「他レーン（アプリ作りのセッション／Codex）が作業中」と
「後続作業（終わったら確認して報告する）」を同じ excerpt に持ちながら、W の語彙
（完了を待って／〜のを待っています）に一致しないだけで通っていた。

## 4. 先送りしていた実装の完了（実物）

- `keiri-hub` `b3473ee`「人事評価賞与 /shoyo を追加（計算→報告画像→金さん承認→社員へPDFをDiscord DM）と feedback-kit 導入」。
  `git merge-base --is-ancestor b3473ee HEAD` が成立（main 履歴に含まれる）。同コミットに
  `src/app/shoyo/`（page/client/layout）・`src/app/api/shoyo/`（calc/image/pdf/approve/kickoff/send/route）・
  `e2e/shoyo.spec.ts`・`docs/shoyo-DESIGN.md` を含む。
- 後続の `f8e631a` も main 履歴に存在。
- 当セッションは 06:14:04.718Z のターンで、本番 URL・GitHub main の 2 コミット・Drive 共有を
  実測して「経理ハブに『賞与』画面ができ、本番で動いています」と報告している。
  待機していた対象は完了しており、成果は失われていない。

## 5. ゲートの実測

```
node -e "import('./tools/deferral-wait-gate.mjs').then(m=>console.log(m.judge(原文)))"
→ {"decision":"block","code":"DEFERRAL-WAIT",...}
```

- repo（当ブランチ）: `block / DEFERRAL-WAIT`
- 配備先 `~/.claude/nightly-repo`（95ecad2）: `block / DEFERRAL-WAIT`
- 拡張後、§3 の 5 ターンも `block / DEFERRAL-WAIT`（上表）。

## 6. 実装した恒久策（当ターン内）

`tools/permanent-fix-deferral-scan.mjs` の W に `LANE_STATUS_WAIT` を追加した。

```
(?:セッション|Codex|codex-do|他AI|レーン)[^\n」"']{0,60}?(?:完了は?まだ|まだ完了|完了待ち|結果を待って|
(?:している|ている|待っている|動いている|走っている)ところです|(?:している|ている)最中|
を待っています|を待っている)
```

- レーン名から 60 字以内に限る。離れた言及（前置きの「セッション」など）と結び付けないため。
- `サブエージェント` はレーン名に入れない。`サブエージェントの結果を待っています。` は
  自分のサブエージェント待ちで、既存の非対象テスト（`permanent-fix-deferral-scan.test.mjs`
  「返信待ち・結果待ちはWと誤検出しない」）を維持する。
- 夜間監査（`handoff-audit-nightly`）は前日分だけを走査するので、過去の台帳を遡って
  新しい TODO を大量に積むことはない（§3 の 5 ターンは 2026-10-21 の分で、既に日付外）。
- 回帰テスト: `deferral-wait-gate.test.mjs` の陽性 6 件（05:15 と 5 ターン）＋
  非対象 1 件（06:00:15）、`permanent-fix-deferral-scan.test.mjs` の W 検出 7 件。

## 7. 残り（検出境界として記録）

- 05:06:43（`サブエージェントの…結果を待っているところです`）と 05:07:58（`完了報告が届いた時点で確認します`）は、
  レーン名から待機語までが 60 字を超える／待機語そのものが無いため pass のまま。広げると
  `作業中` を巡って 150 件規模の誤検出が出る実測（2026-10-23）があるため、境界を動かしていない。
- 06:00:15 は後続作業を持たない裸の状態報告なので pass（`6ac1c046` と同じ二段構え）。
