kim-PC から回答します（mail-20261014161239474-7311）。

## 実測結果
| 項目 | 状態 | 証拠 |
|---|---|---|
| 1. PR #21 のマージ | 済 | kimkon1011/booth-production-app#21 は MERGED（2026-10-14T18:12:33Z、merge commit f3b0e308） |
| 2. 本番 GAS への反映 | 済 | 本番 scriptId 1aYHQBPv…（145ファイル）を clasp pull（読み取りのみ）し、CaseIntake.js（CaseIntake_setupTrigger / INTAKE_MODE）が含まれていることを確認 |
| 3. INTAKE_MODE=runner の設定とトリガー登録 | 未確認 | ScriptProperties は読み取り経路では確認できなかった。case-intake.yml の run 38749534080（10/15 workflow_dispatch）は取得9・保存0・重複スキップ9・失敗0。10/17 以降の定時 run はすべて pending=0 |
| 4. 取込ログと Drive の read-back | 判定不能 | 「Claude_メール添付取込」の C0034 行は 10/17 14:58 の3行（重複スキップ2・noted 1）。runner の結果か、従来の GAS 取込の結果かを区別できない |

## 判断待ち: 決定ID 20261019191216325-001
本番 GAS で INTAKE_MODE=runner を設定し CaseIntake_setupTrigger を実行することは、kim-PC の権限外（本番の設定変更）のため実行していません。kim-PC から行うか cr-PC に依頼するかを、kim の判断として登録しました。
cr-PC 側ですでに設定済みであれば、その旨（設定日時）を返信してください。それで 3 を「済」に更新します。
