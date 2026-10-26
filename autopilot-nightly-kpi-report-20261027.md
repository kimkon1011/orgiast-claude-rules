# OrgiastNightlyKpi 夜間バッチ調査 — 2026-10-27

## 結論

**未実行**。PR #1159 マージ後の夜間バッチは、2026-10-27 01:32 JST 時点で0回。修正による解消はまだ実ログで確認できない。
マージ前4夜の内部失敗は6処理・13件と再現できた。feedback-zero-sweep の Issue 照会成功への変化、および他5処理の修正後の残存状況は未判定。
次回予定は **OrgiastNightlyBatch: 2026-10-27 03:01:37 JST**、**OrgiastNightlyKpi: 同日07:05:05 JST**。

## マージ日時とログの所在

- `gh pr view 1159 -R kimkon1011/orgiast-claude-rules --json mergedAt,mergeCommit` の結果: `mergedAt=2026-10-26T11:37:07Z`（JST 20:37:07）、`mergeCommit=337f1563df172a988c238b1bdb1595b78dccb841`。
- PR: https://github.com/kimkon1011/orgiast-claude-rules/pull/1159
- 指定リポジトリで `git log --merges --oneline -20` を実行した結果は `d4b338b Merge pull request #887 from cr568/auto/20261018-timeout-waste-judge` のみ。#1159 は squash commit のためこの一覧には出ない。`git show -s` で上記SHA、コミット時刻 `2026-10-26T20:37:07+09:00`、件名末尾 `(#1159)` を確認。
- 実行環境のパス対応: `C:/Users/uers/.claude/nightly-repo` = `/mnt/c/Users/uers/.claude/nightly-repo`。壊れた `.wt/nightly-kpi-investigate-20261026` は未使用。

`schtasks /query /tn <タスク名> /v /fo list` により、両タスクの状態は「準備完了」、前回結果は0。KPIの前回実行は2026-10-26 07:05:13、バッチ本体は同日03:02:00で、いずれもマージ前。Task To Run は一覧では末尾が切れるため、読み取り専用の `/xml` で完全な引数も確認した。

起動経路（作業ディレクトリはいずれも `C:/Users/uers/.claude/nightly-repo`）:

```text
C:/WINDOWS/System32/wscript.exe //nologo
  C:/Users/uers/.claude/tools/run-hidden.vbs
  powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass
  -File C:/Users/uers/.claude/tools/nightly-bootstrap.ps1
  -Target tools/nightly-kpi.mjs       # OrgiastNightlyKpi
  -Target tools/nightly-batch.ps1     # OrgiastNightlyBatch（別タスク）
```

KPIタスク自体はバッチを実行せず、日別のバッチログを読み集計する。起動スクリプトはbootstrap経由でリポジトリ内の対象を選択する。

| 用途 | 絶対パス |
|---|---|
| バッチ本体 | `C:/Users/uers/.claude/nightly-repo/tools/nightly-batch.ps1` |
| KPI集計 | `C:/Users/uers/.claude/nightly-repo/tools/nightly-kpi.mjs` |
| 内部処理ログ | `C:/Users/uers/.claude/logs/nightly-batch-2026-10-{23,24,25,26}.log`（4ファイル） |
| 起動・終了記録 | `C:/Users/uers/.claude/logs/nightly-bootstrap-2026-10-26.log` |
| KPI保存先 | `C:/Users/uers/.claude/nightly-kpi/YYYY-MM-DD.json` |

`nightly-batch.ps1:5-6` とインストール済み `nightly-bootstrap.ps1:15-16` でログ出力先を確認。`nightly-kpi.mjs:375,378,393` で入力ログとKPI保存先を確認した。

bootstrapログの実行証拠:

```text
nightly-bootstrap-2026-10-26.log:813:2026-10-26 05:22:28 / 対象実行 / ok:nightly-batch.ps1 終了コード=0
nightly-bootstrap-2026-10-26.log:1106:2026-10-26 07:12:22 / 対象実行 / ok:nightly-kpi.mjs 終了コード=0
```

日付別バッチログは10月26日が最新で、27日以降のファイルは存在しなかった。26日の全バッチ記録も早朝でマージ前。27日のbootstrapログに本体・KPIの実行記録はない。これとスケジューラの前回／次回時刻を合わせ、マージ後0回と判断した。

## 夜ごと × 処理ごとの失敗件数

集計単位は「処理結果行の失敗1件」。`timestamp / 処理名 / 結果` を分割し、サマリ行を除外、結果先頭が `error:` または `ng` の行を数えた。`ok` / `ok:` は成功、`warn:` は警告、`skip:` は成功に含めない。これは `nightly-kpi.mjs:27-30,199-217` の判定に沿う。サマリに再掲される失敗や、1行内の複数エラーは重複加算しない。

| 夜（JST） | feedback-zero-sweep | session-auto-close | stalled-session-resume | memory-publish | webhook-health | stale-work-watch | 合計 |
|---|---:|---:|---:|---:|---:|---:|---:|
| 2026-10-23（マージ前） | 1 | 1 | 1 | 1 | 0 | 0 | 4 |
| 2026-10-24（マージ前） | 1 | 1 | 1 | 0 | 0 | 1 | 4 |
| 2026-10-25（マージ前） | 1 | 0 | 0 | 0 | 1 | 0 | 2 |
| 2026-10-26（マージ前） | 1 | 0 | 1 | 1 | 0 | 0 | 3 |
| 前4夜合計 | 4 | 2 | 3 | 2 | 1 | 1 | 13 |
| 2026-10-27（マージ後、未実行） | — | — | — | — | — | — | — |

「—」は未観測であり0件ではない。feedback-zero-sweep は毎夜1回の処理失敗で計4件。各失敗行には営業・倉庫の2つの `Issue lookup failed` が記録されるが、処理失敗を2件とは数えない。

表の根拠（以下は `rg -n`、すなわち `grep -n` 相当の行番号つき抽出結果）。ログのルートはすべて `C:/Users/uers/.claude/logs/`。

```bash
rg -n ' / [^/]+ / error:| / feedback-zero-sweep /' /mnt/c/Users/uers/.claude/logs/nightly-batch-2026-10-{23,24,25,26}.log
```

```text
nightly-batch-2026-10-23.log:8:2026-10-23 04:20:43 / session-auto-close / error:終了コード1: llm失敗 c94d8c2d: 構造上の事実: 特になし / llm失敗 208c627c: [cooldown] groq はスキップ (daily_limit, 残り281分) / System.Management.Automation.RemoteException
nightly-batch-2026-10-23.log:10:2026-10-23 05:30:47 / stalled-session-resume / error:終了コード1: "startedAt": "2026-10-22T20:08:05.295Z", / "outcome": "error", / "reason": "timeout", / "endedAt": "2026-10-22T20:29:21.136Z" / } / ], / "aborted": true / }
nightly-batch-2026-10-23.log:13:2026-10-23 05:45:36 / memory-publish / error:除外(対象外ファイル): project_pc_memory_upgrade.md.bak.2026-08-20-correct-oom — バックアップ/隠しファイル / 除外(対象外ファイル): project_pc_memory_upgrade.md.bak.2026-08-20-fix-diagnosis — バックアップ/隠しファイル / 除外(資格情報): feedback_credentials_never_reask_universal.md — 秘密パターン Discord webhook URL に一致 / 除外(資格情報): feedback_discord_from_gas_needs_user_agent.md — 秘密パターン Discord webhook URL に一致 / 除外(資格情報): project_booth_case_meet_dedicated_calendar.md — 秘密パターン 40文字以上のhex に一致 / 除外(資格情報): project_discord_mcp_connector.md — 秘密パターン 40文字以上のhex に一致 / 除外(資格情報): project_stash_rescue_awaits_kim_click.md — 秘密パターン 40文字以上のhex に一致 / memory-publish 失敗: NG:vercel deploy failed (ETIMEDOUT)
nightly-batch-2026-10-23.log:26:2026-10-23 06:32:20 / feedback-zero-sweep / error:終了コード1 (警告・後続処理続行): "deferred": 0 / } / ], / "notification": { / "delivered": "dm" / } / } / unknown_rows=aujust／営業自動化:Issue化失敗: Issue lookup failed (status=1); 倉庫アプリ:Issue化失敗: Issue lookup failed (status=1)
nightly-batch-2026-10-24.log:8:2026-10-24 04:13:23 / session-auto-close / error:終了コード1: llm失敗 fde8c404: 構造上の事実: 特になし / llm失敗 6ac0edcd: [cooldown] groq はスキップ (http_429, 残り4分) / System.Management.Automation.RemoteException
nightly-batch-2026-10-24.log:10:2026-10-24 05:10:50 / stalled-session-resume / error:終了コード1: "startedAt": "2026-10-23T19:46:02.835Z", / "outcome": "error", / "reason": "timeout", / "endedAt": "2026-10-23T20:08:45.320Z" / } / ], / "aborted": true / }
nightly-batch-2026-10-24.log:26:2026-10-24 05:31:34 / feedback-zero-sweep / error:終了コード1 (警告・後続処理続行): "deferred": 0 / } / ], / "notification": { / "delivered": "dm" / } / } / unknown_rows=aujust／営業自動化:Issue化失敗: Issue lookup failed (status=1); 倉庫アプリ:Issue化失敗: Issue lookup failed (status=1)
nightly-batch-2026-10-24.log:42:2026-10-24 06:44:57 / stale-work-watch / error:終了コード1: - 50.4日 / C--Users-uers-Downloads-orgiast-claude-rules\215c313c-4531-4dcf-81ea-2cbe6dca7316.jsonl / 要確認 / - 再開: claude --resume '215c313c-4531-4dcf-81ea-2cbe6dca7316' / - 50.4日 / C--Users-uers-Downloads-orgiast-claude-rules\dd0b5139-c1e7-45e9-a014-9f65692fa415.jsonl / 要確認 / - 再開: claude --resume 'dd0b5139-c1e7-45e9-a014-9f65692fa415' / - 他524件 / ## 収集・実行エラー / - PR: spawnSync gh ETIMEDOUT / - branches: spawnSync git ETIMEDOUT
nightly-batch-2026-10-25.log:26:2026-10-25 03:17:35 / feedback-zero-sweep / error:終了コード1 (警告・後続処理続行): } / ], / "notification": { / "delivered": "suppressed", / "reason": "same-source-cause-24h" / } / } / unknown_rows=aujust／営業自動化:Issue化失敗: Issue lookup failed (status=1); 倉庫アプリ:Issue化失敗: Issue lookup failed (status=1)
nightly-batch-2026-10-25.log:30:2026-10-25 03:20:46 / webhook-health / error:終了コード1: Error: fleet sheet rejected request: busy / at postSheet (file:///C:/Users/uers/.claude/nightly-repo/tools/webhook-health.mjs:170:23) / at process.processTicksAndRejections (node:internal/process/task_queues:104:5) / at async run (file:///C:/Users/uers/.claude/nightly-repo/tools/webhook-health.mjs:255:20)
nightly-batch-2026-10-26.log:10:2026-10-26 04:14:34 / stalled-session-resume / error:終了コード1: "startedAt": "2026-10-25T19:13:50.811Z", / "outcome": "error", / "reason": "failure", / "endedAt": "2026-10-25T19:13:57.541Z" / } / ], / "aborted": true / }
nightly-batch-2026-10-26.log:13:2026-10-26 04:19:37 / memory-publish / error:除外(対象外ファイル): project_pc_memory_upgrade.md.bak.2026-08-20-correct-oom — バックアップ/隠しファイル / 除外(対象外ファイル): project_pc_memory_upgrade.md.bak.2026-08-20-fix-diagnosis — バックアップ/隠しファイル / 除外(資格情報): feedback_credentials_never_reask_universal.md — 秘密パターン Discord webhook URL に一致 / 除外(資格情報): feedback_discord_from_gas_needs_user_agent.md — 秘密パターン Discord webhook URL に一致 / 除外(資格情報): project_booth_case_meet_dedicated_calendar.md — 秘密パターン 40文字以上のhex に一致 / 除外(資格情報): project_discord_mcp_connector.md — 秘密パターン 40文字以上のhex に一致 / 除外(資格情報): project_stash_rescue_awaits_kim_click.md — 秘密パターン 40文字以上のhex に一致 / memory-publish 失敗: The operation was aborted due to timeout
nightly-batch-2026-10-26.log:26:2026-10-26 04:27:48 / feedback-zero-sweep / error:終了コード1 (警告・後続処理続行): "deferred": 0 / } / ], / "notification": { / "delivered": "dm" / } / } / unknown_rows=aujust／営業自動化:Issue化失敗: Issue lookup failed (status=1); 倉庫アプリ:Issue化失敗: Issue lookup failed (status=1)
```

## 残存失敗の詳細と次の1施策案

修正後の残存失敗は未判定。以下はマージ前の直近エラー（各処理1行、最大5行以内）と推定原因。10月26日の時点でも stalled-session-resume、memory-publish、feedback-zero-sweep は失敗。他3処理は同日のログで `ok` だが、恒久解消とは断定しない。

### feedback-zero-sweep

```text
nightly-batch-2026-10-26.log:26: error:終了コード1 (警告・後続処理続行): "deferred": 0 / } / ], / "notification": { / "delivered": "dm" / } / } / unknown_rows=aujust／営業自動化:Issue化失敗: Issue lookup failed (status=1); 倉庫アプリ:Issue化失敗: Issue lookup failed (status=1)
```

PR #1159 が対象とした Issue 照会の引用符破損と整合する。旧ログは status=1 のみでstderrがなく、この行だけから別原因の有無は確定できない。次回の結果が ok になり、Issue lookup failed が消えるか確認する。

### session-auto-close

```text
nightly-batch-2026-10-24.log:8: error:終了コード1: llm失敗 fde8c404: 構造上の事実: 特になし / llm失敗 6ac0edcd: [cooldown] groq はスキップ (http_429, 残り4分) / System.Management.Automation.RemoteException
```

直近エラーは groq の http_429 に伴う cooldown。レート制限／フォールバック不足が候補だが、併記された別セッションの失敗原因はこの抜粋では不明。再発時は対象セッションのLLM呼び出しログと利用枠を照合する。

### stalled-session-resume

```text
nightly-batch-2026-10-26.log:10: error:終了コード1: "startedAt": "2026-10-25T19:13:50.811Z", / "outcome": "error", / "reason": "failure", / "endedAt": "2026-10-25T19:13:57.541Z" / } / ], / "aborted": true / }
```

直近は outcome=error / reason=failure で内部の具体的理由は不足。23・24日は timeout。再発時は対応する startedAt のセッション実行記録を読み、timeoutと子処理の即時失敗を区別する。

### memory-publish

```text
nightly-batch-2026-10-26.log:13: error:除外(対象外ファイル): project_pc_memory_upgrade.md.bak.2026-08-20-correct-oom — バックアップ/隠しファイル / 除外(対象外ファイル): project_pc_memory_upgrade.md.bak.2026-08-20-fix-diagnosis — バックアップ/隠しファイル / 除外(資格情報): feedback_credentials_never_reask_universal.md — 秘密パターン Discord webhook URL に一致 / 除外(資格情報): feedback_discord_from_gas_needs_user_agent.md — 秘密パターン Discord webhook URL に一致 / 除外(資格情報): project_booth_case_meet_dedicated_calendar.md — 秘密パターン 40文字以上のhex に一致 / 除外(資格情報): project_discord_mcp_connector.md — 秘密パターン 40文字以上のhex に一致 / 除外(資格情報): project_stash_rescue_awaits_kim_click.md — 秘密パターン 40文字以上のhex に一致 / memory-publish 失敗: The operation was aborted due to timeout
```

直近は operation aborted due to timeout、23日は vercel deploy ETIMEDOUT。配信処理の時間超過が候補。列挙された資格情報除外は安全フィルタの動作で、致命原因と断定しない。再発時は配信のどの段階が上限に達したか実行ログを照合する。

### webhook-health

```text
nightly-batch-2026-10-25.log:30: error:終了コード1: Error: fleet sheet rejected request: busy / at postSheet (file:///C:/Users/uers/.claude/nightly-repo/tools/webhook-health.mjs:170:23) / at process.processTicksAndRejections (node:internal/process/task_queues:104:5) / at async run (file:///C:/Users/uers/.claude/nightly-repo/tools/webhook-health.mjs:255:20)
```

fleet sheet rejected request: busy。Sheet側の一時的な競合・過負荷が候補。再発時は同時刻のSheet側応答／ロック記録を確認する。

### stale-work-watch

```text
nightly-batch-2026-10-24.log:42: error:終了コード1: - 50.4日 / C--Users-uers-Downloads-orgiast-claude-rules\215c313c-4531-4dcf-81ea-2cbe6dca7316.jsonl / 要確認 / - 再開: claude --resume '215c313c-4531-4dcf-81ea-2cbe6dca7316' / - 50.4日 / C--Users-uers-Downloads-orgiast-claude-rules\dd0b5139-c1e7-45e9-a014-9f65692fa415.jsonl / 要確認 / - 再開: claude --resume 'dd0b5139-c1e7-45e9-a014-9f65692fa415' / - 他524件 / ## 収集・実行エラー / - PR: spawnSync gh ETIMEDOUT / - branches: spawnSync git ETIMEDOUT
```

gh と git の spawnSync ETIMEDOUT。収集コマンドの制限時間超過であり、古いセッションの存在自体がエラー原因ではない。再発時は各コマンドの所要時間・対象を確認する。

**次の1施策:** 10月27日の夜間バッチ完了後、KPI予定時刻07:05:05以降に、本レポートと同じ日別ログの集計を1回行う。bootstrapの実行対象・終了記録、feedback-zero-sweep の結果（失敗なら修正で追加されたstderr）、他5処理の結果を照合する。次回予定は実行完了を保証しないため、ログのサマリまで確認する。今回、手動バッチ実行・コード修正・通知・タスク変更は行っていない。

## 進捗の自己評価

**70 / 100（目的全体）**。マージ時刻・実行経路・次回予定を確定し、前4夜の6処理13件を行番号付きで再現した。主要原因への修正はマージ済みだが、必須完了条件である「修正後の夜間実行で失敗が解消したこと」の実ログ証明がまだない。他5処理にも具体的原因が不足するものがあり、目的完了とはしない。今回の調査は未実行という観測結果で完了。

出力はこのレポート1ファイルのみ。UTF-8 BOMなし。コード変更なし。
