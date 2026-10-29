# レーン故障の修復優先: 実装・検証記録（2026-10-29）

## 作業場所と先行差分

正本の `.git` はこのセッションから読み取り専用で、開始時の `git fetch` が `cannot open .git/FETCH_HEAD: Read-only file system`。さらに外部処理が作業ツリーを繰り返し復元したため、退避された `rescue/auto-session-20261029-164003` から変更を回収した。

独立 clone `/tmp/lane-repair-pr` で `git fetch && git checkout main && git pull` を実行し、最新 main `e9f6ce9`（PR #1273、quota-sweep停止・cost-directive日次更新・Codex計測）から `feat/lane-repair-first-20261029` を作成。元の基準 `830d4bb` から今回変更するファイルに先行作業との差分がないこと、パッチが `git apply --check` で適用できることを確認した。先行した DeepSeek の OpenRouter 経路を維持した。

## 1. 実呼び出しによるレーン判定

変更ファイル: `tools/lane-doctor.mjs`、`tools/lib/lane-real-health.mjs`、`tools/lane-real-health.test.mjs`、`tools/lane-doctor.test.mjs`。

cost-work-loop と同じ `executor-usage.jsonl` の24時間窓を集計し、5件以上・非quota失敗率50%以上で probe より優先して `real_fail_rate` にする。失敗理由はHTTPステータス、またはstderr先頭を集計。429/usage_limit と既知の再開時刻は `quota_wait` に分離する。不正・未来・期限外の行、未ルーティング行は除外する。probe再実行でも実績の故障判定を消さない。

実測コマンド（本物のデータ）:

```sh
ORGIAST_HOME=/mnt/c/Users/user node tools/lane-doctor.mjs --json
```

```json
{"ts":"2026-10-29T07:47:45.849Z","deepseek":{"alive":false,"reason":"real_fail_rate","calls":27,"failures":27,"failRate":1,"error":"HTTP 402 (23); cooldown (4)"},"errors":["lane-health.json: EROFS"]}
```

残課題: 判定は実測できたが、このセッションは本物の `~/.claude/lane-health.json` に書き込めない。DeepSeekの実績は過去24時間の集計であり、現在のAPI経路の復旧可否を新たな実呼び出しで検証した結果ではない。

## 2. 修復を先に行うPreToolUseと修復台帳

変更ファイル: `tools/lane-repair-first-gate.mjs`、`tools/lane-repair-log.mjs`、`tools/lib/lane-repair-state.mjs`、`tools/sessionstart-lane-health.mjs`、`tools/pretooluse-lane-guard.mjs`、`tools/gate-runtime.mjs`、`tools/gate-rollout-manifest.json`、`tools/gate-remedies.md`。テストは `lane-repair-first-gate.test.mjs`、`gate-guard-contract.test.mjs`、`pretooluse-lane-guard.test.mjs`、`gate-contract.test.mjs`。

新gateはGATE_CONTRACTと既存runnerを使い、全PCで即時denyする明示ポリシーを登録。無人・モデル・permission_modeに依存せず判定する。修復可能な故障があり、同一故障の記録が6時間以内になければEdit/Write/MultiEdit/NotebookEditと通常shellをexit 2で止める。参照ツールと信頼する診断・修復コマンドを許可し、コマンド連結・リダイレクト・別パスの同名スクリプトを許可しない。既存lane guardでも修復記録コマンドを呼べるようにした。

修復記録は `lane-repair-log.jsonl` に追記し、同一故障の修復不可が3回連続するとnotify-kimで1回通知する。排他・クラッシュ後の古いlock回復・秘密のマスクを実装。gate例外は `gate-errors.jsonl` に記録しfail-open。Codex probeの誤警報は直接WSL実行の終了コードで切り分ける手順を表示する。

実測: `/tmp/lane-repair-work/smoke-home-yB7QhM` を ORGIAST_HOME に指定し、故障レーンを用意して同じEdit入力をCLIへ送信。

```text
node tools/lane-repair-first-gate.mjs
  before: exit 2 / [LANE-REPAIR-FIRST] 修復を最優先: deepseek: real_fail_rate HTTP 500 (8)
node tools/lane-repair-log.mjs --lane deepseek --tried "API疎通とキー設定を確認。HTTP 500 が継続" --result unfixable
  exit 0 / result: unfixable
node tools/lane-repair-first-gate.mjs
  after: exit 0 / stderrなし
```

残課題: 実機settingsへの登録は項目4。通知の3回連続・1回抑制はモックで実行確認し、実在の相手へテスト通知は送っていない。

## 3. 監査・自動昇格・日次タスク

変更ファイル: `tools/rules-registry.json`、`tools/rule-detectors.mjs`、`tools/lib/lane-repair-detector.mjs`、`tools/rule-compliance-loop.mjs`、`tools/register-rule-compliance-task.mjs`、`tools/lane-abandonment-gate.mjs`。テストは `lane-repair-detector.test.mjs`、`rule-compliance-loop.test.mjs`、`lane-abandonment-gate.test.mjs`、`lane-repair-convergence.test.mjs`。

実際のtool_result・lane-healthの観測後、修復記録のない本体実装、または有効なLANE-REPAIRなしの代替を検出する。引用、テスト出力、quota、失敗した記録コマンド、別レーン・別故障・期限切れ・未来の修復記録を区別する。判定はセッション単位で重複計上しない。

精度実測:

```sh
node --test tools/lane-repair-detector.test.mjs
```

```json
{"fixtureCount":28,"truePositives":16,"falsePositives":0,"trueNegatives":12,"falseNegatives":0,"precision":1,"recall":1}
```

これは人工の正例・負例トランスクリプトの実行結果。実データの人手ラベル精度を示す値ではない。registryのvalidationにこの実測値を記載した。

```sh
ORGIAST_HOME=/mnt/c/Users/user node tools/rule-compliance-loop.mjs --days 7 --json
```

```json
{"rows":56238,"rule":"repair-failed-lane-first","applicable":5,"violation":5,"bypass":0,"mode":"block","precision":1}
```

既存 `register-rule-compliance-task.ps1` は毎日03:50に `run-rule-compliance-loop.mjs` を実行し、そのラッパーは既に `runAudit({apply:true,dryRun:false})` を呼ぶ。新Node登録ラッパーをsetup-manifestへ追加し、未登録ならconvergeで登録する。enforcementが欠けている場合は `rule-compliance-loop.mjs --days 7 --apply` で初期生成する。block昇格時にはlane-abandonment-gateがenforcementを読み、Sonnet等にもblock判定を適用し、runner側のwarnへの降格を防ぐ。

テスト用HOMEでは `runAndPersist({home})` とconvergeを実行し、実ファイル `rule-enforcement.json` の生成・read-back、新ルールのmode/precision、既存ルール保持を確認した。

本物のHOMEでも `--days 7 --apply` を試したが、`EROFS: read-only file system, open '/mnt/c/Users/user/.claude/rule-enforcement.json'`。残課題は本物のenforcement生成とWindows実機での日次タスク登録。WindowsのPowerShell呼出し・Daily・実行ユーザーの指定は登録コードとモックで確認した。

## 4. 全PCへの配布経路

変更ファイル: `CLAUDE.md.template`、`ONBOARDING.md` §1.18、`tools/register-hooks.mjs`、`tools/setup-manifest.json`、`tools/lane-repair-convergence.test.mjs`。

正式ルールに修復優先・解除コマンド・6時間の期限・quota_wait・Codex直接確認を記載した。既存のonboarding-sync → setup --converge → register-hooks / fleet-convergenceの経路へ載せた。SessionStartは既存の同期hookを拡張する。新PreToolUseはrunner経由・同期・timeout 15秒・NotebookEditを含むmatcherで登録し、二重登録しない。

実測コマンド:

```sh
node tools/setup.mjs --converge --home /mnt/c/Users/user --manifest /tmp/lane-repair-work/setup-manifest.json --json
```

今回の項目だけを既存manifestから取り出して実行。`task:rule-compliance / state:rule-enforcement / settings:lane-repair-first` はNG。registrarの実測は `clean な main / detached HEAD の同期 checkout がありません`。本物のsettingsを読み戻した結果、新gateは0件、既存SessionStartは1件、enforcementは未生成だった。

テスト用HOMEのconvergeでは state:rule-enforcement / settings:lane-repair-first / settings:lane-health-SessionStart の3項目がOK。日次タスクのWindows登録はモック検証であり、実タスクを登録したとは扱わない。settingsを読み戻してrunner経由・同期・15秒・matcher・再登録しても1件だけであることを確認した。

残課題: 本物のHOMEはこのセッションの書込許可範囲外。正本へのpush/PRとマージ後、各PCで通常のconvergeが完了するまでは、全PC・全アカウントで適用済みとは報告できない。

## 検証と成果物

- 追加テスト4ファイル: 48 pass / 0 fail / 0 skip。
- 関連16ファイル: 305 tests / 304 pass / 0 fail / 既存Windows専用1件はLinuxで対象外。追加したSonnet昇格テストも実行確認。
- `node tools/selftest-guards.mjs`: 68 PASS、ALL PASS。
- `git diff --check` と新規実装の `node --check`: 通過。
- `control-group-check.mjs` で lane-repair-first-gate / lane-abandonment-gate / pretooluse-lane-guard の3件すべて killed（原本を無効化せず、一時コピーの変異をテストが検出）。
- 広域の既存 `gate-readonly.test.mjs` を含む追加実行は長時間化したため中断。テスト本体の削除・skip追加・gate解除はしていない。
- 実行ログ: `/tmp/lane-repair-work/`。

## push・PR・automergeの状態

認証がある実行環境での完了が必要。Windows版 `gh.exe --version` は `WSL UtilBindVsockAnyPort: socket failed 1` で実行不能。LinuxにはGH_TOKEN/GITHUB_TOKENがなく、非対話の `git credential fill` はexit 128（`could not read Username for https://github.com`）。Windowsの標準GitHub CLI設定にはユーザー名のみがあり、平文OAuth tokenはなかった。

実装・検証済みのブランチとPR本文をローカルに保全した。GitHubへpushしてPRを作成しautomergeラベルを付けたことは未確認・未完である。

実際のpush試行:

```sh
GIT_TERMINAL_PROMPT=0 git push --set-upstream origin feat/lane-repair-first-20261029
```

```text
exit 128
fatal: could not read Username for 'https://github.com': terminal prompts disabled
```

PR URL: 未作成。automergeラベル: 未付与。PR本文は `/tmp/lane-repair-work/pr-body.md` に準備済み。
