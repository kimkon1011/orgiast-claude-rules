# handoff-audit 検証記録: 「GAS の関数実行が要る」（2026-10-20 再検証・窓 2026-09-29〜10-20）

対象 TODO: `[handoff-audit:2a521d8efb465e3a] GAS の関数実行が要る — この handoff が再発していないかを
実物で検証し結果を記録する`（`~/.claude/next-session.md`）

前回記録: `handoff-audit-findings-gas-function-execution.md`（窓 **〜2026-09-29**・結論「再発 3 件・2 セッション。
止まっているのは関数実行ではなく本番反映（デプロイ）」）
経路の記録: `docs/gas-function-execution-route.md`（2026-09-25）

## 結論（3行）

1. **再発は続いている（窓内 9 turn・7 セッション）が、原因の局面が変わった。** 10-09〜10-13 は
   **`cr@` にコマンドキューの書き込み権限が無かった**ため関数実行そのものを人／kim-PC へ渡していた。
   10-13 23:38 に権限が付与されて以降、**人へ渡したのは 10-15 の 1 件だけ**（他PCからの依頼への回答）。
2. **route の前半「clasp run」は今日も不成立（実測）**。`clasp run listFailureCounters` は
   `Unable to run script function. Please make sure you have permission to run the script function.` で失敗する
   （org の `executionApi.access: MYSELF`。所有者以外は実行不可）。
3. **後半「コマンドキュー」は今日は成立する（実測）**。cr-PC から
   `node ~/.claude/tools-local/booth-cmd.mjs listFailureCounters '[]'` を打ち、コマンドキューの
   `cmd_cr1792433620107d7g2s2s.json` が Drive に置かれ、**`result_…txt` が生成された**（＝トリガーが実行した）。
   ただし**戻り値の本文は 403 で読めない**（`~/.clasprc.json` の cr@ トークンは `drive.file`）。

→ route を「clasp run / コマンドキュー経由」のままにしておくと、次のセッションが再び `clasp run` で失敗して
人へ渡す。**route 文言を実測に合わせて是正した**（`handoff-audit-knowledge.json`）。

送信なし・権限変更なし・kim への DM なし。本番のデータ・設定は変更していない（投入したのは読み取り専用コマンド1件）。

---

## 1. 再発の実測（一次記録）

新設した `tools/handoff-audit-gas-execution-scan.mjs`（読み取り専用・`--selftest` 12/12 pass）で走査。

```
node tools/handoff-audit-gas-execution-scan.mjs --since 2026-09-29T00:00:00Z
```

| 台帳 | 行数 | 窓内 |
|---|---|---|
| `~/.claude/handoff-audit-ledger.jsonl` | 1,155 | 1,155 |
| `~/.claude/stop-gate-runner-ledger.jsonl` | 934 | 934 |
| `~/.claude/handoff-audit-nightly-ledger.jsonl` | 23 | 23（当型の hit 0） |
| transcript（`projects/**/*.jsonl`） | 267 ファイル | assistant turn 15,197 |

- 生の hit: **118 行**（同一 turn の台帳・runner・transcript 重複を除くと **63 turn-minute / 27 セッション**）。
- 人手分類で「GAS の実行・反映を人または別PCへ渡した」= **9 turn / 7 セッション**（下表）。
  残りは (a) 過去の説明・進捗報告、(b) コマンドキューを **Claude 側から使って完了**した報告、
  (c) 検出語を含むだけの無関係な文。

### 1.1 実件（逐語の要部）

| # | 時刻 (UTC) | session | 手渡した内容 | 逐語（要部） |
|---|---|---|---|---|
| 1 | 2026-10-09T14:06 | `05d575bd` | 本番シートへの1行追加 | `cr@orgiast.jp には、CommandQueue のフォルダ（claude-booth-cmds）へ書き込む権限がないためです` |
| 2 | 2026-10-09T16:11 | `05d575bd` | 同上（kim-PC 待ち） | `kim-PC にコマンドの投入を頼んだところで返信待ちです` |
| 3 | 2026-10-12T08:26 | `e100b8d9` | TaskLedger_autoStatus の実行 | `clasp 経由の実行・ログ取得は GCP プロジェクト未設定で不可でした…kim-PC への CommandQueue 代行（依頼済み）待ち` **←監査が block（rule 12/4/2/5）** |
| 4 | 2026-10-12T10:10 | `dde4867f` | 本番反映（gas-overlay-push） | `次に kim がすること: 本番反映（gas-overlay-push.mjs --files …）を実行するか、私に指示する` |
| 5 | 2026-10-12T12:25 | `1198c97d` | 本番での動作確認 | `GAS をこちらから直接動かす経路は、どれも使えませんでした。…kim-PC にコマンドキューへの投入を代行してもらう形に` |
| 6 | 2026-10-12T16:33 | `7b9d8b8f` | Script Properties の設定 | `T10: GAS の API キー直書き 3 箇所を Script Properties へ（設定は kim-PC 代行）` |
| 7 | 2026-10-12T16:54 | `30401194` | Checklist_seedMerge の実行 | `kim-PC に Checklist_seedMerge 代行依頼を fleet-mail 送信` |
| 8 | 2026-10-13T12:16 | `3d864e33` | 当日アプリへの項目追加 | `当日アプリへの項目追加だけはまだで、kim-PC に実行を依頼しました` |
| 9 | 2026-10-15T14:12 | `f4de8d1d` | `CaseIntake_setupTrigger` の実行 | `### 1. 本番への即時反映（booth-production-app 側の担当者が実施） 1. GAS エディタ、または clasp run で CaseIntake_setupTrigger を1回実行します` |

`3d864e33` の 13:52–13:53 は「kim さんに一度だけ必要なこと」表で、同じ #8 の続き。

### 1.2 分岐点（なぜ 10-13 以降は減ったか）

- **2026-10-13 23:38 `8ee4682f`**: `kim-PC が昨夜、cr@ に CommandQueue の書き込み権限を付けていたので、
  そこからコマンドを投入しました` — ここで **cr@ から直接投入できる経路が開通**。
- 以降の hit はすべて「コマンドキュー経由で Claude 側から実行して完了」の報告（例 2026-10-19T03:51
  `09042acc`: `購入依頼と備品登録は、制作アプリの「コマンドキュー」経由でシートに書き込めると分かりました`）。
- 例外は #9（10-15）。他PCからの依頼メールへの回答で、**「このセッションは nightly-repo で経路がない」**と
  書いているが、cr-PC には `~/.claude/tools-local/booth-cmd.mjs` がある。ただし対象の
  `CaseIntake_setupTrigger` は**コマンド登録が無い関数**なので、キューでは実行できない（登録が先）。
  この構造（未登録関数はキューで動かせない）が route に書かれていなかったため、手順書に逃げた。

## 2. 経路の実物検証（本日 2026-10-20 実打ち・cr-PC）

| 主張 | 実測 | 判定 |
|---|---|---|
| `clasp run <関数>` | `cd booth-production-app && npx clasp run listFailureCounters` → `Unable to run script function. Please make sure you have permission to run the script function.` | **不可（今日も）** |
| コマンドキューで実行 | `node ~/.claude/tools-local/booth-cmd.mjs listFailureCounters '[]'` → `upload 200 {id: 1cwFY_IVUCIaVUeDQjPuCy9g47Y-oSdF1}` → `RESULT_FILE 1HSqdtGb2L62sxjOAyhT2x31AXQ_PK0iV (content not readable with this token: 403)` | **実行は成立。戻り値は読めない** |
| 未登録関数の実行 | `src/CommandQueue.js` の `_cmdQueue_commands()` に無い名前は投入しても実行されない | **不可（先に登録＋push が要る）** |
| 結果の読み戻し | result ファイルは生成されるが `alt=media` が 403（`drive.file` スコープ） | **ファイル生成＝実行成立の証拠。値は別経路で read-back** |

## 3. route の是正（本セッションで実施）

`tools/handoff-audit-knowledge.json` の本エントリ route を、実測に合わせて書き換えた。
**dedupe キー `hash(pattern, route)` が変わるため TODO id も変わる**。既存の next-session TODO
（`2a521d8efb465e3a`）は取り消し線で閉じ、新 route は次回の検出時に新しい id で 1 件だけ積まれる。
`handoff-audit-nightly.test.mjs` の「route は一意」テストは通している。

## 4. 未確認（断定しない）

- コマンドキューの**戻り値の本文**は読めていない（403）。「実行された」は result ファイルの生成で判断した。
- `f4de8d1d` の依頼（`CaseIntake_setupTrigger` 実行・`INTAKE_MODE=runner`）が**誰の手で完了したか**は未確認。
- 走査は 1 turn 内 ±120 文字の共起で拾う。長い turn で語が離れている場合や、語彙外の婉曲表現は
  取りこぼす（0 件は「測った 0」であって「皆無の証明」ではない）。
