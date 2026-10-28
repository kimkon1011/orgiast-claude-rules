# OrgiastNightlyKpi 調査報告（2026-10-29）

## 真因（1 行）
未確定：タスク終了結果と15分設定は確認できたが、起動と処理段階を結び付けるPID・開始ログ・当日のイベント履歴がなく、遅延箇所を一つに絞れない。

## 時系列表
時刻は JST。B = `C:/Users/uers/.claude/logs/nightly-bootstrap-2026-10-28.log`。E = `evidence/kpi-timeout-20261029/`。共通ログの開始行は対象不明。終了行から開始行を逆算して結び付けていない。

| 時刻・区間 | 確認内容 | 所要時間 | 証拠 |
|---|---|---|---|
| 10/28 07:06:49 | タスクの LastRunTime | — | E/task-info.json:5 |
| 07:06:49–07:21:49 | 設定 PT15M から計算した枠。終了実時刻ではない | 15分（計算値） | E/task-info.json:5、E/task-info.json:7 |
| 上記15分内 | mutex・git同期・開始heartbeat・KPI本体・終了heartbeatへの配分 | すべて未確認。合計を配分できない | tools/nightly-bootstrap.ps1:135、170、321、347、354 |
| 07:03:32 | 対象実行：ok:booth-feedback-intake.mjs 終了コード=0 | 開始/終了の対応不明 | B:259 |
| 07:05:10 | リポ同期：ok:origin/main 9cbbfc5 | 開始/終了の対応不明 | B:260 |
| 07:07:02 | nightly-bootstrap：ok:開始 | 開始/終了の対応不明 | B:261 |
| 07:07:13 | nightly-bootstrap：ok:開始 | 開始/終了の対応不明 | B:262 |
| 07:09:24 | 対象実行：ok:feedback-to-issues.mjs 終了コード=0 | 開始/終了の対応不明 | B:263 |
| 07:10:14 | 排他制御：warn:他のタスクが同期中のためタイムアウト。既存版で続行 | 開始/終了の対応不明 | B:264 |
| 07:12:51 | nightly-bootstrap：ok:開始 | 開始/終了の対応不明 | B:265 |
| 07:14:06 | 対象実行：ok:fleet-agent.mjs 終了コード=0 | 開始/終了の対応不明 | B:266 |
| 07:15:40 | nightly-bootstrap：ok:開始 | 開始/終了の対応不明 | B:267 |
| 07:15:53 | 排他制御：warn:他のタスクが同期中のためタイムアウト。既存版で続行 | 開始/終了の対応不明 | B:268 |
| 07:16:36 | nightly-bootstrap：ok:開始 | 開始/終了の対応不明 | B:269 |
| 07:17:03 | nightly-bootstrap：ok:開始 | 開始/終了の対応不明 | B:270 |
| 07:18:41 | 排他制御：warn:他のタスクが同期中のためタイムアウト。既存版で続行 | 開始/終了の対応不明 | B:271 |
| 07:19:35 | nightly-bootstrap：ok:開始 | 開始/終了の対応不明 | B:272 |
| 07:19:37 | 排他制御：warn:他のタスクが同期中のためタイムアウト。既存版で続行 | 開始/終了の対応不明 | B:273 |
| 07:20:16 | nightly-bootstrap：ok:開始 | 開始/終了の対応不明 | B:274 |
| 07:20:31 | 対象実行：ok:decision-watch.mjs 終了コード=0 | 開始/終了の対応不明 | B:275 |
| 07:20:50 | 排他制御：warn:他のタスクが同期中のためタイムアウト。既存版で続行 | 開始/終了の対応不明 | B:276 |
| 07:22:36 | 排他制御：warn:他のタスクが同期中のためタイムアウト。既存版で続行 | 開始/終了の対応不明 | B:277 |
| 07:22:38 | nightly-bootstrap：ok:開始 | 開始/終了の対応不明 | B:278 |
| 07:23:18 | 排他制御：warn:他のタスクが同期中のためタイムアウト。既存版で続行 | 開始/終了の対応不明 | B:279 |
| 07:24:22 | 対象実行：ok:funnel-probe.mjs 終了コード=1 | 開始/終了の対応不明 | B:280 |
| 07:25:38 | 排他制御：warn:他のタスクが同期中のためタイムアウト。既存版で続行 | 開始/終了の対応不明 | B:281 |
| 07:27:10 | 対象実行：ok:plaud-to-tldv.mjs 終了コード=0 | 開始/終了の対応不明 | B:282 |
| 07:27:11 | nightly-bootstrap：ok:開始 | 開始/終了の対応不明 | B:283 |
| 07:29:23 | 対象実行：ok:sga-autopilot.mjs 終了コード=1 | 開始/終了の対応不明 | B:284 |
| 07:30:12 | 排他制御：warn:他のタスクが同期中のためタイムアウト。既存版で続行 | 開始/終了の対応不明 | B:285 |
| 07:34:47 | 対象実行：ok:booth-feedback-intake.mjs 終了コード=0 | 開始/終了の対応不明 | B:286 |
| 07:35:03 | 対象実行：ok:fleet-mail.mjs 終了コード=75 | 開始/終了の対応不明 | B:287 |
| 07:36:32 | リポ同期：ok:origin/main 9cbbfc5 | 開始/終了の対応不明 | B:288 |
| 07:37:59 | 対象実行：ok:nightly-kpi.mjs 終了コード=0 | 開始/終了の対応不明 | B:289 |
| 07:38:21 | nightly-bootstrap：ok:開始 | 開始/終了の対応不明 | B:290 |
| 07:38:52 | nightly-bootstrap：ok:開始 | 開始/終了の対応不明 | B:291 |
| 07:39:07 | 対象実行：ok:fleet-mail-watchdog.mjs 終了コード=1 | 開始/終了の対応不明 | B:292 |
| 2026-10-28T07:33:47.8711010+09:00 | KPI JSONの最終更新（プロセスIDなし） | — | E/task-info.json:16 |
| 07:06:49–07:37:59 | 起動記録とKPI終了記録の時刻差。同一起動か未確認 | 31分10秒（差のみ） | E/task-info.json:5、B:289 |

## 証拠（ファイル:行）
- `E/task-info.json:3`：Operational は無効。100/129/200/201/203/331/332 を照合できない。指定の `schtasks /query /v /fo list /tn OrgiastNightlyKpi` も実行し、LastRunTime・267014・00:15:00 を再確認した。UTF-8 JSON は Get-ScheduledTask / Get-ScheduledTaskInfo の同じ値を保存したもの。
- `E/task-info.json:6`：267014。終了結果だけから15分上限による終了の実時刻・理由イベントまで確定したとは扱わない。
- `E/bootstrap-window.txt:1` 以降：対象窓の全ログ抜粋。元ファイル名・行番号を各行に保持。PID別フォールバック27ファイルには07:00–07:40の記録なし（`E/fallback-inventory.txt:1` 以降）。
- `logs/nightly-kpi.log:624`：通知失敗、625–633：10/28のKPI出力。行自体には時刻・PIDなし。`tools/run-hidden.vbs:36` 以降で対象名から標準出力先を選び、`nightly-kpi.log` に追記する。`nightly-batch.log` はKPIの出力先ではない。
- `tools/nightly-kpi.mjs:375` 付近：日付付き nightly-batch ログを入力し、nightly-kpi/YYYY-MM-DD.json に出力する。`E/kpi-result.json:21` は batchCompleted=false、33 は scheduledTask=null。この scheduledTask は OrgiastNightlyBatch の情報でありKPIタスクの結果ではない。
- `tools/lib/heartbeat.mjs:24` 以降：保存先は `.claude/heartbeat/<job>.json`（heartbeats ではない）。bootstrap は全対象で job=nightly-bootstrap を共用し上書きする。`E/heartbeat-at-investigation.json:3` 以降は10/29の別対象。10/28の startedAt を復元できない。KPI専用heartbeat呼出しはない。
- `logs/nightly-bootstrap-2026-10-25.log:1415`：07:07:19終了。10/26:1106：07:12:22終了。10/27:883：07:17:06終了。これらも本体開始時刻ではない。
- 追加確認：Security の4688は取得可能な対象イベントなし。Systemの同時間帯にプロセス対応付けを補う記録は見つからなかった。

### 候補の採否
| 候補 | 判定 | 証拠と理由 |
|---|---|---|
| (a) mutexとgit同期の遅延 | 未確認 | B:264ほかで競合は確認。ただしWaitOneは1起動1回（tools/nightly-bootstrap.ps1:135）。複数プロセスの180秒待ちをKPIに直列加算できない。git開始終了も未記録。 |
| (b) 本体の長時間ブロック | 未確認 | nightly-kpi.log:624で通知timeoutは確認できるが所要時間不明。本体開始行がない。 |
| (c) 別起動の07:37終了 | 未確認 | B:289にはPIDなし。共通ログ開始行も対象名なし。201イベントなし。同一起動の子プロセスが残った可能性とも区別不能。 |
| その他：本体前後のheartbeat通信 | 未確認 | tools/nightly-bootstrap.ps1:321、354が同期呼出し。tools/lib/heartbeat.mjs:46以降のfetchに明示的timeoutなし。本体前の待ちも候補になる。 |

## 修正内容と差分ファイル
真因特定を条件とする指示に従い、本番コード・登録テンプレートは変更していない。待ち短縮・PT30M化・本体予算のいずれも現時点で根拠不足。変更は本報告書と証拠だけ。

指定worktree作成は共有 `.git/refs/...lock` が Read-only file system で失敗した。代替は同じ `.wt/kpi-timeout-20261029` に作った独立クローン。共有ツリーのindex/HEADは変更していない。タスク変更・削除・手動実行、既存ログの改変、通知送信はしていない。

## テスト結果
本番コード変更なし・追加テストなし。package.jsonにtestスクリプトなし。CIの全件コマンドは `node --test`（.github/workflows/test.yml:23）。今回は文書・証拠のみのため全件テストは未実行（pass/fail数は未計測）。証拠照合: `python3 evidence/kpi-timeout-20261029/verify-evidence.py`。結果: pass=3 / fail=0（共通ログの全抜粋行、KPI標準出力の抜粋行、窓内PID別ログ0件を照合）。これは本番コードの回帰テストではない。

## 未確認事項
- 真因、実際の強制終了時刻、15分の処理別内訳、07:37終了と07:06起動の同一性。完了条件の時系列確定・真因修正は未達。
- JSONのmtimeは現存ファイルの属性であり当時のプロセス同一性の証明ではない。
- 07:36:32同期完了（B:288）と07:37:59 KPI終了（B:289）が隣接していても同一プロセスとは限らない。

## 次の 1 手
bootstrapに実行ID（PID＋開始時刻）・Target・段階開始終了（mutex/git/heartbeat/本体）の永続ログを追加して回帰テストを行い、次の自然起動で採取する。今回の原因修正とは区別した診断改善として扱う。現存ログだけから不足情報を復元することはできない。

## 作業記録
独立クローンのローカルコピー完了前にfetchを開始したため、cloneのref初期化が競合してexit 134となった。fetchで得たorigin/mainからブランチ作成に成功し、以後はこの独立クローンだけで作業した。
