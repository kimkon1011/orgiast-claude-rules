# handoff-audit 2ddd67033c25e70a 再発検証（GAS スクリプトの1回実行を user に手渡す）

検証日: 2026-10-23（02:04Z）/ 走査窓: 2026-10-22T18:01:30Z（昇格時刻）〜 2026-10-23T02:04Z（約8時間）
送信・権限変更・kim への DM なし。既存の承認範囲のみ。

## 結論（3点）

1. 原文を特定した。セッション 0395ca72（夜間台帳 line 23、2026-10-22T18:01:30Z、verdict=block）。
   quote は「次に kim がすること: 02b_申込フォーム作成.gs を https://script.new で1回実行する（初回だけ許可画面が出ます）」。
2. 原文以降の窓では、逐語再発 0 件・同型再発 0 件（台帳4本・transcript 4本）。ただしこの PC の台帳は窓内の行が 0 で、
   窓が狭い。「再発なし」とは断定せず、未確認として残す。
3. 検出器の欠陥は未判定。原文セッションの Stop gate 実物はこの PC の runner 台帳が 10-22T07:12Z で止まっており、照会できない（§3）。

## §1 原文（C1）

ID `2ddd67033c25e70a` = promotions.jsonl:4（pattern「GAS スクリプトの1回実行を user に手渡す」/ route「clasp run / コマンドキュー経由で Claude 側から実行。『▶実行してください』は違反」/ confidence high）。
由来 observation `97d47735760d…` → handoff-audit-nightly-ledger.jsonl:23（sessionId 0395ca72-22e5-4975-aa11-bcdc7c8aa067）。
違反 rule 2/3/5。監査の fix は「clasp run-function を当ターンに実試行し error/denied の記録を根拠にする」。

## §2 走査（C2）

語彙: (script.new|GAS|clasp|Apps Script|.gs) × (実行してください|貼り付け|貼って|▶|kim がすること|お願い|1回実行)。

| 台帳 | total | 窓内 | ヒット |
| --- | --- | --- | --- |
| handoff-audit-ledger.jsonl | 1234 | 0（末尾 10-22T15:54Z） | 0 |
| stop-gate-runner-ledger.jsonl | 515 | 0（末尾 10-22T07:12Z） | 0 |
| handoff-audit-nightly-ledger.jsonl | 31 | 0（末尾 10-22T18:01Z） | 0 |
| handoff-audit-deferral-ledger.jsonl | 20 | 0 | 0 |

transcript: `~/.claude/projects/**/*.jsonl` のうち 10-22 18:00 以降に更新されたのは 4 本。
assistant/user 本文に `script.new|clasp run|▶実行` を含む行（窓内）は 0。
4 本のうち 1 本は本ループ自身のプロンプト echo（引用・違反に数えない）。

## §3 route と検出器（C3）

- 同型の過去実測: `tools/handoff-audit-findings-gas-function-execution.md`（2026-09-29）が、
  route の「clasp run」は Workspace ポリシーで不成立、実際に通るのは Web App ゲートウェイ（`tools/gas-client.mjs`）と
  コマンドキュー、塞がるのは `Production Deploy` と整理済み。今回は再実測していない（実行は本番書き込み・送信になり得るため）。
- 原文の場合、手渡し先は新規フォームの作成（`.gs` を script.new で実行）。route の「コマンドキュー経由」は
  Setup.gs の setupOnce が既にある案件でのみ成立する。案件の GAS に Setup.gs があるかは未確認。
- 原文セッション 0395ca72 の Stop gate 最終判定は、この PC の runner 台帳が窓の前で止まっているため未確認。
  検出器欠陥の有無は、台帳が更新された後に判定する。

## §4 修正（C4）

実施せず。再発 0 件で、検出器の欠陥も確認できていないため。根拠なく語彙は足さない。

## §5 残件

- 再走査: 台帳が窓まで更新された後（次の夜間監査以降）に同じ語彙で再実行する。
- 0395ca72 の runner 判定の確認。

## §6 検証ゲート（C6）

`node --test tools/` は本環境の Node でディレクトリをファイル扱いして即失敗する（0 tests）。代替の全テスト実行（Codex 経由）:
tests 6231 / pass 6203 / fail 17 / skipped 11。内訳は既知の fleet-mail-v2 11 件、ai-news-inject 5 件（日付依存）、
distribution-coverage 1 件（未追跡の `.loop/` が未分類として検出。`.loop/` は本ループの作業物でコミットしない）。
本変更は docs のみ。fail は変更前から存在する（`.loop/` 起因の1件を除く）。

## §7 追記（2026-10-23 02:25Z・台帳更新後の再走査）

台帳は 02:21Z まで更新済み（handoff-audit 1253 行 / runner 518 行）。窓内の語彙ヒットは本ループ自身の出力 echo のみで、再発 0 件。

C3 の判定材料（原文セッション 0395ca72、行数は台帳実測）:
- handoff-audit-ledger: `script.new` を含む excerpt の行 12 件が全て verdict=pass（violations 空、provider=null・latencyMs=0。LLM 判定ではなく即 pass の経路）。最終行 04:48Z も pass。
- stop-gate-runner-ledger: 同様の行 12 件のうち blockedBy 空が 4 件。残りは他の gate（next-action / user-burden 等）が止めたが、手渡し自体を理由に止めた記録はない。
- 判定: ライブの handoff-audit は原文を検出できず、夜間監査（18:01Z）で初めて block になった。検出器の欠陥は「あり」（ライブ gate が provider=null で pass を返している）。
- 未修正: provider=null / latencyMs=0 の pass 経路の原因は未調査。次ループで fired=true かつ provider=null の行の発生条件を調べる。

## §8 追記（2026-10-23・provider=null 経路の原因と修正）

原因（台帳実測）: handoff-audit-ledger の fired=true かつ provider=null は 278 件で、全件 `skipped: regex-blocked`。
原文セッション 0395ca72 の 12 件も全て同じ。`stop-gate-runner.mjs` は先行 gate が block/warn を1件でも出すと第2段監査を飛ばす（`regexBlocked: results.length > 0`）。
その後 policy/demote/retry-cap で先行 gate が全て無効化されると、runner の blockedBy が空になり、手渡しは誰にも検査されずに通る
（runner 台帳で原文 12 件中 4 件が blockedBy=[]）。§7 の「LLM 判定ではなく即 pass」は検出器欠陥ではなく、この経路の帰結。

修正（C4）: `tools/stop-gate-runner.mjs` run() で、監査が regex-blocked で skip され、かつ demote 後の有効 block が 0 件なら、第2段を regexBlocked=false で再評価して block なら結果に加える。
検証: stop-gate-runner.test.mjs 58/58、handoff-audit-gate.test.mjs を含む 86/86 pass。
未検証: 再評価が実 provider で block を返す統合テストは追加していない（テストは ORGIAST_HANDOFF_AUDIT=off 固定で、provider を呼ぶ経路を作れない）。
残件: 本番での効果は次の夜間監査以降の台帳（skipped=regex-blocked の後に provider 付き行が続くか）で確認する。
