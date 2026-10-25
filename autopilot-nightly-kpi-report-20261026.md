# OrgiastNightlyKpi 調査報告（2026-10-26）

## 失敗一覧（表）

対象は2026-10-23〜26。以下の B23〜B26 は `C:\Users\uers\.claude\logs\nightly-batch-2026-10-DD.log`、S23〜S26 は同ディレクトリの `nightly-bootstrap-2026-10-DD.log` を指す。Lは行番号。サマリに再掲されたエラーは二重計上していない。連続回数はこの4日間の観測範囲内。

**バッチの実失敗は6処理・13件（23日4、24日4、25日2、26日3）。KPIプロセスの異常終了を示す証拠はない。**

| 処理名 | 日付・証拠 | エラー文の引用 | 連続回数 |
|---|---|---|---|
| feedback-zero-sweep | 23/24/25/26日 各B:L26 | `unknown_rows=aujust／営業自動化:Issue化失敗: Issue lookup failed (status=1); 倉庫アプリ:Issue化失敗: Issue lookup failed (status=1)` | 4日連続（2アプリとも） |
| session-auto-close | 23日 B23:L8、24日 B24:L8 | 23日 `[cooldown] groq はスキップ (daily_limit, 残り281分)`、24日 `(http_429, 残り4分)`。両日 `llm失敗` / `終了コード1` | 2日連続、25/26日はok |
| stalled-session-resume | 23日 B23:L10、24日 B24:L10、26日 B26:L10 | 23/24日 `"outcome": "error", / "reason": "timeout"`、26日 `"reason": "failure"`。いずれも `"aborted": true` | 23〜24日2連続、26日1回（累計3日） |
| memory-publish | 23日 B23:L13、26日 B26:L13 | 23日 `NG:vercel deploy failed (ETIMEDOUT)`、26日 `The operation was aborted due to timeout` | 各1回、累計2日（24/25日はok） |
| stale-work-watch | 24日 B24:L42 | `PR: spawnSync gh ETIMEDOUT` / `branches: spawnSync git ETIMEDOUT` | 1回 |
| webhook-health | 25日 B25:L30 | `Error: fleet sheet rejected request: busy` | 1回（26日はok） |

bootstrapは `error:` / `ng:` / `ng` が0件。以下のwarnは共有bootstrapの全タスク分であり、KPI自身の失敗件数ではない。

| 警告 | 23日 | 24日 | 25日 | 26日 |
|---|---|---|---|---|
| 排他待ちtimeout・既存版で続行 | 201件 S23:L5ほか | 127件 S24:L20ほか | 5件 S25:L2494ほか | 11件 S26:L511ほか |
| git checkout終了コード128・既存版で続行 | 3件 S23:L2082ほか | 119件 S24:L324ほか | 102件 S25:L113ほか | 5件 S26:L1203ほか |
| git fetch終了コード1・既存版で続行 | 3件 S23:L79,L1642,L2064 | 0 | 2件 S25:L2617,L2623 | 0 |

全warnの行番号一覧は後述の証跡ファイルに保存。4日連続で同期警告が存在するが、checkout/fetchの標準エラーがないため原因の断定は不可。

全行番号証跡: `autopilot-nightly-kpi-evidence-20261026.md`（nightly-repo直下）。

## 根本原因

1. **「夜間KPI失敗」の通知対象は子ステップ失敗。** `tools/nightly-kpi.mjs` の `parseBatchLog` → `improvementTodos` → `notifyKim` がその経路。出力先は `C:\Users\uers\.claude\nightly-kpi\YYYY-MM-DD.json`。各保存値のfailedSteps（23日:L55、24日:L24、25日:L64、26日:L24）は上表と完全一致する。現在のnext-session.mdには該当ToDo文が残っておらず、DM送達内容そのものは未確認。追加起票の有無・重複抑止があるため、JSONだけで毎日のDM送達は断定しない。
2. **23日の「途中停止」は確定事実ではない。** 同日の保存JSON:L52は `batchCompleted:false`、L62は `lastStep:"batch-run"`。一方B23:L41は07:08:48にbatch-run終了、L42/L43は07:11:22にstale-work-watchと全体サマリ完了。入力ログを読むのはGitHub照会より前で、KPI保存はその後なので、途中のスナップショットを使ったことと整合する（JSON更新時刻07:11:41 JST）。コードがサマリ不在だけで「途中停止」と断定する点は確認できた不具合。全4日とも最終ログにはL43の完了サマリがある。
3. **4連続のIssue化失敗は、Issueの既存照会が終了コード1で失敗したため。** `tools/feedback-to-issues.mjs:lookupFeedbackIssue` は既に3回再試行するが、従来はstderrを捨ててstatusのみを残す。これが根本原因を絞れないコード上の理由。GitHub認証・権限・API制限・接続・CLI引数のどれが元の失敗原因かは未確認。既存照会の失敗を「Issueなし」と扱わない設計は維持した。
4. **session-auto-closeはLLM処理失敗。** ログにGroqのdaily_limit/http_429によるcooldownが明記されている。`session-auto-close.mjs` は候補全件のLLM失敗時にexitCode=1を返す。別候補の `構造上の事実: 特になし` という切り詰められた文だけでは、その候補も同じ制限で失敗したとは断定できない。監督/kimがkim-PCのLLM利用枠・provider切替状況を確認し、枠回復後に対象件数を限定して検証する。
5. **stalled-session-resumeは子実行失敗と連続2件エラーによる中止。** `stalled-session-resume.json` の23日reason=timeout（L2838,L4075）、24日（L4054,L4088）、26日reason=failure（L4103,L4123）で裏付けられる。既定実行期限は20分。26日の子実行は約45秒と7秒で失敗し、時間切れとは異なる。子stderrを保存しない `execute()` がstatusだけに縮約しており、26日の失敗の根本原因は未確認。監督がkim-PCの当該子セッション/実行器ログを時刻指定で確認する。
6. **memory-publishは23日が公開コマンド300秒timeout、26日がmanifest確認通信10秒timeout。** `memory-publish.mjs` のdeployとverifyの期限設定に対応する。資格情報を含むメモリの除外は安全処理であり、このエラーの原因ではない。通信先側の遅延・ローカル負荷等は未確認。監督/kimがmemoryserveの既存デプロイ状態とmanifestのgeneratedAtを読み取り確認し、公開が済んでいるかを先に判定する。失敗verifyで成功stateを書かない現行処理は維持する。
7. **stale-work-watchは収集コマンドの60秒timeout。** 古いセッションが524件あること自体をエラーとは扱わず、gh/git収集のtimeoutを原因として記録している。監督がkim-PCの同時実行負荷と各読み取りコマンドの所要時間を個別確認する。通信・ロック・I/Oの内訳は未確認。
8. **webhook-healthはfleet sheetのbusy拒否。** 再試行は既存コミット `7265ce6`（PR #1126）で最大3試行に修正済み。今回のcheckoutに存在し、関連テストも成功したため再実装しない。GAS共有ロック競合との解釈はコード上の説明に基づくもので、当時のサーバーログは未確認。再発時は監督/Sheet管理者がGAS実行履歴の競合を確認する。

## 修正内容と検証結果（PR/コミット）

- Issue既存照会失敗時にstderr（またはspawn error）を記録。既存redactorとURL除去を適用してから空白を正規化し500文字に制限。既存3回再試行・失敗扱いは維持。
- KPIのサマリ不在時の表現を「集計時点で完了未確認（実行中の可能性あり）」へ変更。監視を抑止せず、停止の断定だけを除去。保存済みJSONやToDoは変更していない。
- 回帰テスト追加：HTTPエラーの詳細保持、資格情報/URLの除去・長さ制限、途中ログと完了ログの判定。
- 検証：`node --test tools/feedback-to-issues.test.mjs tools/nightly-kpi.test.mjs tools/feedback-zero-sweep.test.mjs tools/webhook-health.test.mjs` → **95 tests / pass 95 / fail 0 / skipped 0、exit 0**。`git diff --check`成功。`test-results.txt`に実行結果。
- PR作成・push・本番適用はなし。外部サービス送信/書き込み、notify-kim実行、タスク設定・settings.json変更なし。
- 元リポジトリの `.git` が読み取り専用でブランチ作成は `Read-only file system` により拒否された。許可範囲内の `.wt/nightly-kpi-investigate-20261026` に作業コピーを作成し、そこでブランチ `fix/nightly-kpi-investigate-20261026` にコミット。元リポジトリの `git log -1` は変更されない。
- コミット: `ad363df` — `fix(nightly): preserve lookup diagnostics and qualify incomplete snapshots`（4ファイル、+39/-3）。read-backは作業コピーを指定して `git log -1`。適用用パッチ: `autopilot-nightly-kpi-fix-20261026.patch`（nightly-repo直下）。

## 未確認事項

- Issue照会status=1の歴史的なstderr、26日の子実行failureの詳細、各timeoutの環境側原因。これらを認証切れと断定していない。外部要因を隠す成功扱いやtimeoutの一律延長はしていない。
- KPI内部例外を示す記録は見つかっていないが、DM本文・全標準エラーの送達記録を取得していないため、過去通知の完全再現はできない。
- サマリ不在の表現を直しても、途中の集計値を後から自動更新する仕組みは追加していない。
- 指定先 `C:\Users\uers\.claude\scratchpad\autopilot-nightly-kpi-report-20261026.md` はセッションの書込許可範囲外。この場所への保存は未実施。代替としてnightly-repo直下の同名ファイルへ保存した。監督側で指定先へコピーが必要。

## 次の1施策の提案

**4日連続のfeedback-zero-sweepのIssue照会失敗を、kim-PCのタスクと同じWindowsユーザー・PATH・認証環境で切り分ける。** 担当は監督（認証の再設定が必要と判明した場合のみkim）。対象は営業 `kimkon1011/aujust-sales-automation` と倉庫 `cr568/warehouse-app`。修正をレビュー・適用した上で、sweep全体を再実行せず、`gh issue list --state all --search` の同じ引数による読み取りだけを実行し、redact済みstderrを採取する。実際のrepo環境変数上書きの有無も照合する。401/403、429、接続失敗、引数エラーを分類し、それぞれの対応後に照会成功と既存Issue再利用を確認する。原票・Issue・Sheetsへの書き込みは別工程。
