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

## §9 追記（2026-10-23 04:01Z・台帳更新待ちの再走査と回帰テスト）

**トリガー未成立。** 宣言「夜間監査で台帳が更新されたら再走査して C3 を判定」は、次の夜間監査がまだ実行されていないため完了できない。
- handoff-audit-nightly-ledger: 末尾 2026-10-22T18:01:30Z のまま（最終8行は全て `audit-unavailable` / provider=deepseek / `timeout-or-provider-unavailable`。うち session 0395ca72 は行22-23で block、行24-25は再試行が timeout）。
- handoff-audit-ledger: 末尾 2026-10-23T02:28:24Z のまま（02:28Z 以降の新規行なし＝評価対象のセッションが無い）。
- stop-gate-runner-ledger: 末尾 2026-10-23T02:28:24Z のまま。

同じ語彙（`script.new|GAS|clasp|Apps Script|.gs` × `実行してください|貼り付け|▶|kim がすること|1回実行`）で窓 2026-10-22T18:01:30Z〜04:01Z を再走査:
- 台帳4本の窓内ヒットは6件（live ledger）/6件（runner）。全て本ループ自身の ITERATING 報告（session 759da206 / de54c8dd / 89f7f92e / 6e4a9518 / 085c8530 / 8dcc79a8）で、本物の手渡し文言ではない。provider 付き verdict の手渡し文言行は **0件**。
- 夜間台帳・deferral 台帳の窓内ヒットは 0件。

**C3 の状態（不変）**: 検出器の欠陥は「あり」で原因（regex-blocked スキップ後の demote 素通り）は §8 で特定・修正済み。未取得なのは「修正後に本物の手渡し文言が provider 付きで判定される」ライブ実測のみ。

**C4 追補（未検証ギャップを1つ閉じた）**: §8 の「provider を呼ぶ経路のテストが無い」を、監査 provider を注入した決定論的テストで解消した。
- 追加: `tools/stop-gate-runner-audit-reeval.test.mjs`（2 tests）。`evaluateAudit` が `options.ask` を `requestAudit` へ透過することを利用し、実 provider を呼ばずに第2段の再評価を検証。
- 検証内容: ①先行 gate（user-burden-gate）が block → regex-blocked で第1段スキップ → demote で 0 件 → 第2段が provider 1回だけ呼ばれ block なら `blockedBy=['handoff-audit-gate']` で素通りしない。②第2段が pass なら通す（block を握りつぶさない）。
- 実行: `node --test tools/stop-gate-runner-audit-reeval.test.mjs tools/stop-gate-runner.test.mjs tools/handoff-audit-gate.test.mjs` → **88/88 pass**（既存86＋新規2）。

**残件（変わらず）**: ライブ実測は次の夜間監査 2026-10-23T18:01Z 以降。台帳に手渡し文言の行が出たとき、`skipped=regex-blocked` の後に provider 付き verdict が付くかを確認する。夜間監査の再試行が `audit-unavailable` で落ちる事象（10-22 18:01Z の8行）も、判定材料が揃わない要因として残る。

## §10 追記（2026-10-23 05:0xZ・「本番で効いたか」の確定判定）

**結論: 本番では効いていない。** 理由は検出結果ではなく配備で、修正 f94ee7a が本番コードに入っていない（main 未マージ）。

- 本番の実行体は `~/.claude/settings.json:519` の `node "C:\Users\kimko\.claude\nightly-repo\tools\stop-gate-runner.mjs"`。nightly-repo は origin/main を追従しており、本判定中にも HEAD が f78bfe4 → fd767b8（#1019）へ自動更新された。
- その HEAD に対し `git merge-base --is-ancestor f94ee7a HEAD` は不一致、追加行「先行 gate が発火」は grep 0 件。origin/main にも存在しない（`git branch -r --contains f94ee7a` は origin/quota-sweep/20261023-0202-claude-mvkbrycs のみ）。
- 台帳実測: 修正コミット（02:24:55Z）以降の handoff-audit-ledger 18 行のうち、`skipped=regex-blocked` かつ provider 付きの行は **0 件**（全期間でも 0 件）。iteration 7/8 が「再評価が動作」と見た 02:26:52Z（provider=null）→02:26:55Z（deepseek）は、session 6e4a9518 の**別々の Stop イベント**であり、1 回の run 内で第2段が再評価された記録ではない。→ 当該判断は誤りで、本節で訂正する。
- 決定論的実測（実 provider は呼ばず `ask` を注入。入力は §9 の回帰テストと同じ「DBの値を確認してください。／次に kim がすること: なし」）:
  - PRODUCTION（nightly-repo HEAD）: `decision=pass, blockedBy=[], demoted=[user-burden-gate], auditCalls=0` → 手渡しが無検査で通る（欠陥が現存）
  - FIXED（本ブランチ 64320e7）: `decision=block, blockedBy=[handoff-audit-gate], auditCalls=1` → 修正どおり止まる
- 夜間監査: 最終は 2026-10-22T18:01:30Z、次回は 2026-10-23T18:01Z で**未実行**。ただし本番コードが未修正のままでは、夜間監査が走ってもこの経路は検出されない。
- マージ可否（実測）: 本ブランチは origin/main に対し ahead 4 / behind 7、`git merge-tree --write-tree` は衝突なし、main 側で `stop-gate-runner.mjs` / `handoff-audit-gate.mjs` はブランチ分岐後に変更なし。→ マージは技術的に安全。
- 回帰テスト: `node --test tools/stop-gate-runner-audit-reeval.test.mjs` → 2/2 pass。

**残件（1点・人の判断が要る）**: f94ee7a を main へ載せること。ループ brief の「push/PR/merge は行わない」制約があるため未実施。マージ後に nightly-repo が origin/main を取り込めば（数分〜次回同期）、本番の Stop gate は自動で修正版になる。
