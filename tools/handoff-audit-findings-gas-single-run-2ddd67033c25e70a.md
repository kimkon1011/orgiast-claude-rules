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

## §11 追記（2026-10-23 05:1xZ・再走査の仕組みを実装し、ライブで実測）

宣言「夜間監査後に再走査して、手渡し文言の行に provider 付きの verdict が出るかを確認する」の
**未確認2点**（①再走査を実行する仕組みが動くか ②手渡し文言行に provider 付き verdict が出るか）を、当ターンに実測した。

### ① 再走査の仕組み（新規・テスト付き）

これまで再走査は毎回その場の ad-hoc な読み取りで、手順が残っていなかった。CLI に落とした。

- `tools/handoff-audit-rescan.mjs` — 4台帳を読み、窓内の行を手渡し語彙で照合し、各行に
  provider / skipped / blockedBy を突き合わせて verdict を1語で返す（読み取りのみ）。
  `verdict` は `no-handoff-wording-in-window` / `only-self-report-echoes` /
  `handoff-wording-judged-with-provider` / `handoff-wording-without-provider` の4値。
- `tools/handoff-audit-rescan.test.mjs` — 合成行で 9 tests / 9 pass。
  実際に踏んだ2つの偽陽性を回帰テスト化した: (a) lookahead のバックトラックで
  「次に kim がすること: なし」を拾ってしまう件、(b) 案件名「GAS 1回実行の手渡し再発検証」を
  手渡し命令として拾ってしまう件。
- 実行例: `node tools/handoff-audit-rescan.mjs --since 2026-10-23T02:24:55.000Z`

### ② ライブ実測 — 本番では provider 付き verdict が出ていない（実物で確定）

窓（修正 f94ee7a のコミット時刻 02:24:55Z 以降〜now）を実走査した結果、
**本物の手渡し文言行が 2 件あり、どちらも provider=null・skipped=regex-blocked・blockedBy=[]・verdict=pass**:

```
2026-10-23T05:10:52.536Z session=2bb98fd7  provider=null verdict=pass blockedBy=[]
  "次に kim がすること: デスクトップ「アイアンコースター_発送_20261023」を開き 箱53782の在庫が36個以上あるか確認する"
2026-10-23T05:11:50.866Z session=2bb98fd7  provider=null verdict=pass blockedBy=[]
  （同上）
```
runner 台帳の同時刻 05:11:50.939Z は `blockedBy=[]` /
`demoted=[manual-request-fullsteps-gate, handoff-investigation-gate, user-burden-gate]`。
= §8 で特定した「regex-blocked で第1段を飛ばし、demote で 0 件になり、第2段が走らない」経路が
**推測ではなく 2026-10-23 05:11Z の実トラフィックでそのまま再現している**（§10 の合成入力による証明の実物版）。

### ③ 実 excerpt での反実仮想（PRODUCTION vs FIXED）

§10 の合成入力ではなく、上記 05:11:50.866Z の**実 excerpt（988字）**を両実装に通した（`ask` 注入・実 provider 非呼び出し）:

| 実装 | decision | blockedBy | auditCalls |
|---|---|---|---|
| PRODUCTION（nightly-repo HEAD） | pass | `[]` | 0 |
| FIXED（本ブランチ） | **block** | `["handoff-audit-gate"]` | 1 |
| FIXED（provider が pass を返した場合） | pass | `[]` | 1 |

PRODUCTION の出力（demoted 3件・blockedBy 空）は、実台帳 05:11:50.939Z の行と一致した
＝この反実仮想ハーネスは本番の挙動を正しく再現している。FIXED は同じ実 excerpt を 1 回だけ provider に掛けて止める。

### ④ 判定

- ①再走査の仕組み: **動く**（CLI・9/9 test・実台帳で完走）。
- ②手渡し文言行の provider 付き verdict: **本番では出ていない**（実物2件が provider=null）。
  修正 f94ee7a は依然 origin/main に無く、本番 hook は未修正版を実行している。

**残件（1点・人の判断が要る / §10 と同じ）**: f94ee7a を main へ載せること。ループ brief の
「push/PR/merge は行わない」制約があるため未実施。マージ後、nightly-repo が origin/main を取り込んだ次の
Stop イベントで、本再走査器の verdict が `handoff-wording-judged-with-provider` に変わるかを同じコマンドで確認できる。

## §12 追記（2026-10-23 05:2xZ・夜間監査前のライブ再走査 — 実物が 2 件増え、判定は変わらない）

夜間監査（次回 2026-10-23T18:01Z、未実行）を待たずに `tools/handoff-audit-rescan.mjs` で再走査した。
このループの宣言「夜間監査後に再走査して provider 付き verdict を確認する」のうち、
**夜間監査に依存しない部分（本番 Stop gate が手渡し文言に provider 判定を付けているか）は実物で更新できた**。

### ① 窓（修正 f94ee7a のコミット時刻 02:24:55Z 以降〜05:21Z）の実測

```
node tools/handoff-audit-rescan.mjs --since 2026-10-23T02:24:55Z
verdict: handoff-wording-without-provider
totals: rowsMatched=4 handoffWording=4 withProviderVerdict=0 blockedByHandoffAuditGate=0
```

手渡し文言行は §11 の 2 件から **4 件**に増えた。すべて session `2bb98fd7`（Makuake アイアンコースター発送/化粧箱発注）で、
**4 件とも `fired=true` / `provider=null` / `skipped=regex-blocked` / `verdict=pass` / `blockedBy=[]`**:

| ts (Z) | excerpt 長 | 手渡し文言（引用） |
|---|---|---|
| 05:10:52.536 | 988 | 次に kim がすること: デスクトップ「アイアンコースター_発送_20261023」を開き 箱53782の在庫が36個以上あるか確認する |
| 05:11:50.866 | 988 | （同上） |
| 05:19:42.883 | 1565 | 次に kim がすること: 今日中に化粧箱net(ID 517087)にログインし 53782と58572と58245を各1カートして支払い確定する |
| 05:20:59.246 | 1802 | （同上） |

### ② 同一 Stop の runner 台帳との突き合わせ（今回初めて取れた「同時刻ペア」）

05:20:59 の Stop イベントは、audit 台帳と runner 台帳の両方に行がある:

```
handoff-audit-ledger 2026-10-23T05:20:59.246Z fired=true provider=null skipped=regex-blocked verdict=pass
stop-gate-runner-ledger 2026-10-23T05:20:59.374Z verdict=block blockedBy=["decision-research-gate"]
                          demoted=[] handoffKind=manual-steps excerpt=200字
```

読み取れること:
- runner 側は `handoffKind=manual-steps` ＝ **手渡し文言だと認識している**（認識漏れではない）。
- それでも `blockedBy` に `handoff-audit-gate` が入らない。同時刻の audit 行が `provider=null / skipped=regex-blocked / pass` を返しているため。
- ＝ §8 で特定した経路（regex-blocked で第1段を飛ばす → demote で 0 件 → 第2段が走らない）が、
  **合成入力ではなく同一イベントの 2 台帳ペアとして実物で確認できた**。§10 の決定論的証明と一致する。
- なお runner の excerpt は 200 字に切り詰められており、audit 側（1802 字）とは長さが違う。文言一致での突き合わせはできないため、
  対応付けは `sessionId` + 時刻（128ms 差）で行った。

### ③ マージ可否の再測定（origin/main が進んだため）

- `git fetch` 後の origin/main = `2757964`（§10 時点の fd767b8 から前進）。`git merge-base --is-ancestor f94ee7a origin/main` は **不一致のまま**＝修正は未着地。
- 本ブランチは origin/main に対し **ahead 10 / behind 6**（§10 時点は ahead 4 / behind 7）。
- `git merge-tree --write-tree origin/main HEAD` → **exit 0（衝突なし）**。main 側の `stop-gate-runner.mjs` はブランチ分岐後に変更なし（差分は本ブランチ側の +5 行のみ）。

### ④ 判定

- 手渡し文言行への provider 付き verdict: **本番では依然として出ていない**（実物 4 件・0 件が provider 付き）。
- 夜間監査（18:01Z）後の再走査は**まだ実行できない**（05:2xZ 時点で未実行）。同じコマンド
  `node tools/handoff-audit-rescan.mjs --since <夜間監査時刻>` で、監査後にそのまま確認できる。
- 回帰テスト: `node --test tools/handoff-audit-rescan.test.mjs` → **9/9 pass**（変更なし・再確認）。

**残件（1点・人の判断が要る / §10・§11 と同じ）**: f94ee7a を main へ載せること。
ループ brief の「push/PR/merge は行わない」制約があるため未実施。マージは技術的に安全（衝突なし・対象ファイルの main 側変更なし）。
