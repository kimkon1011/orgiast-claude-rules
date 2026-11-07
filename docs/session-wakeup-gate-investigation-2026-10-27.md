# セッション起床 gate と見張り再開の調査

## 変更

`auto-progress.mjs` の登録行は `status: 'open', check: check.trim(), checkCwd: cwd`。
next-action-gate は同一 sessionId の最新 open 行に空白以外の文字列 check があるときだけ起床証拠とする。
人待ち用の同じ判定も合わせた。当ターンの ScheduleWakeup（stop:true 除外）と Monitor の tool_use を
currentTurnEntries / blocks から検出する。headless / subagents の除外と既存 background 判定は維持。

## 再開経路と対話実行との差

- auto-progress-watch.resumeSession は runChild(executable, prompt, row.cwd, row.cwd, timeoutMs, runOptions) を呼ぶ。
  既定 timeoutMs は20分。runOptions.resumeSessionId は Claude 経路の --resume に使われる。
- auto-session.runChild は autoSessionExecutor() の設定に従い cheap-code → 代替 provider → codex-do →
  許可されている場合だけ Claude の順に試す。実行コードは prepareExecutorRoot の専用ツリーから読むため、
  調査 checkout と当時の実行コードが同じ revision とは断定できない。
- buildCodexDoArgs は `node <executorRoot>/tools/codex-do.mjs --prompt-file <一時ファイル> --cwd <row.cwd> --origin unattended`。
  --kind、--model、--lane、--timeout は渡さない（codex-do の既定 timeout はログ上1800秒）。
  外側 runChild の20分期限も適用される。プロンプトは `[headless:auto-session]` を付けてファイルで渡す。
- 子 env は sanitizeClaudeSupervisorEnv(process.env) に CLAUDE_HEADLESS=1 と
  ORGIAST_HEADLESS_JOB=auto-session:codex-do を追加。cwd は row.cwd。
- 対話例の `--kind implement` は明示指定。再開側は kind 自動判定（実ログでは verify と implement が混在）。
  --origin を省いた対話側は interactive であり、unattended の日次枠と異なる。
- 再開側の sessionId は Codex の --resume としては渡されず、プロンプトの transcriptPath 参照で会話を読む設計。

## 保存先と実測証拠

読み取りは ORGIAST_HOME=/mnt/c/Users/user を指定した。executor-usage.jsonl は6072行（末尾空行含む）。
codex-do.recordUsage は home/.claude/executor-usage.jsonl に exitCode、origin、kind、chain、stderrTail を保存する。
全文 stdout/stderr の専用保存はこの関数にはない。cheap-code も同台帳へ provider 別の結果を保存する。
watch は logs/auto-progress-watch.summary.log に集計、fallback は fallback-backend-history.jsonl に冷却履歴を保存する。
以下の行番号は調査時点。原ログは変更していない。

`/mnt/c/Users/user/.claude/logs/auto-progress-watch.summary.log:153`
> 2026-10-27T11:00:00.935Z … "resumeDeferred":1 … "resumeDeferredReason":"実行者なし: codex-do exit 124 / [codex-do] backend=gemini-cli が 600 秒でタイムアウトしたため次のバックエンドへ移ります"

同ファイル154行目:
> 2026-10-27T12:00:01.003Z … "resumed":0,"resumeDeferred":34 … "resumeDeferredReason":"実行者なし: codex-do exit 1 / 🚨 フォールバック(cheap-code:deepseek)は作業ツリーを1行も変更していません。指示が届いたか確認してください"

`executor-usage.jsonl:6012`（11時巡回中の結果。集計の先頭時刻と終了時刻は異なる）:
> "t":"2026-10-27T11:25:16.584Z","provider":"fallback","model":"gemini-cli/gemini-3.7-flash",…"timedOut":true,"status":"timeout","origin":"unattended","kind":"implement","exitCode":124

chain 内:
> "backend":"deepseek",…"stderrTail":"[API Error: 402 Insufficient Balance …]","outcome":"exhausted"
> "backend":"cheap-code:deepseek",…"status":3,…"stderrTail":"[cheap-code] deepseek はクールダウン中です(2026-10-28T04:00:33.800Zまで)。起動を省略しました。","outcome":"exhausted"
> "backend":"gemini-cli",…"status":124,"timedOut":true,…"secs":601.168,"budgetSecs":600,…"outcome":"timeout"

Gemini stderr には `.loop/quota-sweep-claude-state.md` が configured ignore patterns で読めない旨もある。
これが600秒消費の唯一の原因かは保存された末尾ログだけでは断定しない。

`fallback-backend-history.jsonl:1`:
> {"t":1793100314628,"backend":"gemini-cli","outcome":"timeout"}

これは 2026-10-27T11:25:14.628Z。fallback-backend-health.mjs の既定冷却は6時間なので、
12時巡回では Gemini が除外される。設定の候補順は qwen / cheap-code:glm / gemini-cli。
GLM 冷却中は cheap-code:glm が deepseek に置換される。

`executor-usage.jsonl:6018`:
> "t":"2026-10-27T12:01:04.888Z","provider":"fallback","model":"cheap-code:deepseek/deepseek-flash",…"origin":"unattended","kind":"implement","exitCode":1,…"reason":"empty_diff"

chain は deepseek 402（outcome exhausted）、cheap-code:deepseek exit 3（冷却、outcome exhausted）の2件だけ。
6043行目の12:07:44.827Zも同じ構造。exit 3 の exhausted 判定は現コードにも既に存在する。
empty_diff は全候補が実行不能だった末尾結果に実装用の空差分検知が付いたもので、認証エラーの証拠ではない。

対話側の比較（同ファイル6039行目）:
> "t":"2026-10-27T12:07:17.041Z","provider":"codex","model":"codex-cli/default",…"status":"ok","origin":"interactive","kind":"implement","exitCode":0

## Codex が使われない理由の照合と結論

executor-budget.json は codex.unattendedPerDay=8。Asia/Tokyo で当日分を独立集計した8行は、
5095/5096/5097/5098/5107行（UTC10月26日19時台＝JST10月27日）と5700/5702/5703行（UTC10月27日07時台）。
全8件は11時巡回より前。予算関数の再計算も used=8 / limit=8 / remaining=0 だった。
codex-cooldown.json の期限は10月23日で、この日の Codex 本体の冷却は原因ではない。
予算ファイルの当時スナップショットと全stderrはないため、無人枠の判定は現設定・保存台帳からの照合である。

結論: 対話用 Codex の正常動作と、無人枠枯渇→代替の残高不足／冷却→全滅は両立する。
12時の exit 1 を引数やアカウント指定だけで直せる証拠はない。
Gemini 冷却の解除や無人枠迂回、backend 順序の強制変更は行わない。タスクBの実装変更なし。
必要条件は無人枠の日付更新（2026-10-28 00:00 JST）、Gemini 冷却終了（2026-10-28 02:25 JST）後の再確認。
GLM のログは Weekly/Monthly Limit Exhausted / reset at 2026-10-29 19:53:29（provider表記、timezone不明）。
DeepSeek の402は提供側の残高不足で、コード変更では解消できない。追加アカウント・課金操作は提案しない。
現時点でユーザーの外部操作を必要とするコード上の解決策は確認できず、枠の自然回復後の実行ログ確認が必要。

実セッションの再開・本番通知・設定変更はしていない。gate・guard・hook の無効化や回避はしていない。

## 検証結果と環境制限

指定コマンド `node --test tools/next-action-gate.test.mjs tools/stop-gate-runner.test.mjs`:
```
# tests 2
# pass 1
# fail 1
```
この環境の --test はファイル単位の結果を出す。stop-gate-runner ファイルが exit 1。
詳細用 `node --trace-exit tools/next-action-gate.test.mjs`:
```
# tests 77
# pass 77
# fail 0
```
詳細用 `node tools/stop-gate-runner.test.mjs`:
```
# tests 60
# pass 2
# fail 58
```
先頭失敗は JSON.parse の Unexpected end of JSON input、起床テストは子が台帳を作らず ENOENT。
最小の spawnSync(process.execPath, ['tools/stop-gate-runner.mjs'], { input: JSON文字列, encoding: 'utf8' }) でも:
```
error: Error: spawnSync /usr/bin/node EPERM
errno: -1,
code: 'EPERM',
syscall: 'spawnSync /usr/bin/node'
status: 0,
stdout: '',
stderr: ''
```
Node 子プロセス生成がサンドボックスで拒否されている（status 0 だけでは成功と判定できない）。
指定の統合テスト全passは未達。制限を回避せず報告する。gate 本体の77件は直接実行で確認した。
検証ログは /tmp/wakeup-tests.log、/tmp/wakeup-trace.log、/tmp/wakeup-stop-direct.log。
