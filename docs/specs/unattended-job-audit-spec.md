# 指示書: 無人ジョブの自己監査と自己修復（unattended-job-audit）— 全PC・全アカウント共通

## 背景（kim 2026-10-18）
> 「聞かれなくても自身で監査して、全プロジェクトに対して発見して解決する機能を作って。全てのパソコンの全てのアカウントの全ての Claude Code で適用されるように」

直前の実害: kim-PC の `OrgiastCostImproveLoop`（毎日 07:20・StartWhenAvailable）が 2026-10-18 に動かず、誰も気付かなかった。人（kim）が「回っているか」と聞いて初めて判明した。既存の `nightly-health.mjs` / `stall-scan.mjs` は**手書きの期待値（nightly-health-expectations.json）に載っているジョブだけ**を見るため、新しいジョブや期待値未登録のジョブは監査されない。また検出しても「修復: なし」で止まる。

## 目的
各PCが自分の無人ジョブ（Windows スケジュールタスク）を**自動発見**し、**止まっていれば自分で再実行**し、直らなければ **kim に届く経路で報告**する。手書きの期待値に頼らない。

## 作るもの

### 1. `tools/unattended-job-audit.mjs`（新規）
- **発見**: `tools/lib/scheduled-task.mjs` の `listScheduledTasks()` を拡張（または新関数 `listScheduledTaskDetails()`）し、`Get-ScheduledTask | Where TaskName -match 'Orgiast|Claude'` に対して `State / LastRunTime / LastTaskResult / NextRunTime / Triggers(種別・DaysInterval・Repetition.Interval・WeeksInterval) / Settings.StartWhenAvailable` を PowerShell 1回で JSON 取得する（`fleet-agent.mjs` の `scheduledTaskStatus` と同じ呼び方。CimClass 名 `MSFT_TaskDailyTrigger` / `MSFT_TaskWeeklyTrigger` / `MSFT_TaskTimeTrigger` / `MSFT_TaskLogonTrigger` を見る）。
- **期待周期の自動導出**（手書き不要）: Repetition.Interval があればその分、Daily なら 24h×DaysInterval、Weekly なら 168h×WeeksInterval、それ以外（Logon/一回限り）は監査対象外。許容遅れ = 周期×1.5 + 1h（最低 2h）。`tools/unattended-jobs.json`（新規・任意）で `{ "<TaskName>": { "maxAgeHours": n, "artifacts": ["~/.claude/xxx.jsonl"], "ignore": true } }` の上書きだけ許す。
- **判定**（純粋関数 `auditTasks(tasks, overrides, now)` を export）:
  - `missed`: State が Ready/Running 以外でなく、`now - LastRunTime > 許容遅れ`（LastRunTime が 1999 年＝未実行も missed）。
  - `failed`: `LastTaskResult` が 0 / 267009(実行中) / 267011(未実行) / 267014(前回中断) 以外。
  - `disabled_required`: State=Disabled かつ `tools/setup-manifest.json` の `scheduled-task` 項目（severity required）に名前がある。
  - `artifact_stale`: overrides.artifacts のいずれかの mtime が許容遅れを超えている。
  - `missing_required`: manifest の required `scheduled-task` にあるのにタスク自体が無い。
- **修復**（`healTasks(findings, { startScheduledTask, enableScheduledTask, runConverge, state, now })`、1タスクにつき 1日1回だけ。状態は `~/.claude/unattended-job-audit-state.json`）:
  - missed / failed → `startScheduledTask(name)`（`tools/lib/scheduled-task.mjs` 既存）。
  - disabled_required → `enableScheduledTask(name)` → start。
  - missing_required → `node tools/setup.mjs --converge` を背景起動。
  - 修復を試みたら `state.heals[name] = { at, kind }` に記録。
- **検証と昇格**: 次回の監査で同じタスクが `heals` に記録済みかつ `LastRunTime` が修復時刻より進んでいなければ `unresolved` に昇格し、**kim に届ける**: `notifyKim`（Discord token がある PC）→ 無ければ `node tools/fleet-mail.mjs --send --to kim-PC --kind note --body-file <tmp> --why "無人ジョブ未修復"` を `tools/lib/background-spawn.mjs` で背景起動（`api-billing-guard.mjs` の `notifyBilling` と同じ流儀）。同じ unresolved は 1日1回。
- **出力**: 日本語の短い行（`✅ 監査 N件: 異常なし` / `🔧 再実行: <task>（<理由>）` / `🚨 未修復: <task> …`）。`--json` で構造化、`--dry-run` で修復しない、`--quiet` で異常時だけ出力。非 win32 では `skip: unsupported platform` を1行出して exit 0。
- 例外で落ちない（try/catch、PowerShell 失敗時は `計測不能` を1行）。

### 2. 実行経路（全PCに自動で入る）
- **SessionStart**: `tools/sessionstart-lane-health.mjs`（既に全PCの SessionStart に登録済み）から `unattended-job-audit.mjs --quiet` を **6時間ガード**（`~/.claude/.unattended-audit-guard`）付きで背景起動。異常があればその出力を `~/.claude/unattended-job-audit-last.txt` に残し、次回 SessionStart の additionalContext に `[無人ジョブ監査] …` として1〜3行注入する（`sessionSummary` と並べる）。
- **ヘッドレスPC（人が Claude Code を開かない PC）**: `tools/fleet-agent.mjs` の定期実行（15分ごと）で、`scheduledTaskStatus()` を取った直後に **1日1回** `unattended-job-audit.mjs --quiet` を背景起動する（ガードは同じファイル）。
- **夜間**: `tools/nightly-health.mjs` から同じ監査を呼び、結果の `unresolved` を既存のレポートに1節追加する。

### 3. 登録・配布
- 新規ファイルは `tools/fleet-scope.json` に `scope: fleet` で登録（step は `settings:lane-health-SessionStart`）。
- `tools/setup-manifest.json` に `hook:unattended-job-audit`（file-nonempty・**optional**、clean-install は main の clone を見るため）を追加。
- `tools/gate-remedies.md` は不要（ゲートではない）。
- `fleet-agent.mjs` は既に全PCで動いているので、新しいタスク登録は不要。

### 4. テスト（node:test、cwd=repo）
- `tools/unattended-job-audit.test.mjs`: 期待周期の導出（Daily/Weekly/Repetition/Logon除外）、missed/failed/disabled_required/missing_required/artifact_stale の判定、1日1回の修復ガード、未修復の昇格、非 win32 skip、PowerShell 失敗時の計測不能。フィクスチャに実機の `OrgiastCostImproveLoop`（Daily 07:20、LastRunTime 2026-10-17 07:20、now 2026-10-18 20:00 → missed）と `OrgiastMorningBatch`（LastTaskResult 267014 → 失敗扱いにしない）を含める。
- `sessionstart-lane-health.test.mjs` / `fleet-agent.test.mjs` / `nightly-health.test.mjs` に呼び出しのテストを足す（spawn はスタブ）。
- 実行: `node --test tools/unattended-job-audit.test.mjs tools/sessionstart-lane-health.test.mjs tools/fleet-agent.test.mjs tools/nightly-health.test.mjs tools/fleet-scope.test.mjs tools/no-undistributed-imports.test.mjs` が全部 pass。`node tools/selftest-guards.mjs` も回す。

## 守ること
- 修復は「再実行・有効化・converge」だけ。タスクの削除・無効化・設定変更はしない。
- `detached: true` を直書きしない（`tools/lib/background-spawn.mjs`）。秘密値を出力しない。BOM を書かない。
- 既存の `nightly-health-expectations.json` は残す（ログ内容の検査はそちら、周期の監査はこちら）。
- commit / push はしない。完了報告は変更ファイル一覧とテスト件数だけ。
