# nishi-PC AIレーン修復報告（2026-10-29）

作業ブランチ: `fix/nishi-ai-lanes-20261029`（独立コピー `/tmp/nishi-ai-repair`）。基点 `830d4bb`、修正コミット `58e5bf0` / `bd895e5`。変更一式は同じフォルダーの `nishi-ai-repair-20261029.patch` に保存した。

**未配備・PR未作成。** 元の `.git` と Windows プロファイルはこの実行環境から書き込み不可。元リポジトリでの `git switch -c fix/nishi-ai-lanes-20261029` は `cannot lock ref ... unable to create directory`。書き込み可能な `/tmp` に独立コピーを作り、新ブランチで実装・コミットした。GitHub接続ツール、gh、トークン環境変数はなく、push は `fatal: could not read Username for 'https://github.com': terminal prompts disabled`。したがって PR URL と automerge ラベルは取得・付与できていない。PR本文案は `/tmp/nishi-ai-repair-pr.md`。

## (1) quota-sweep

**原因:** 利用枠の `resetsAt` が変わると、同じ目標でも累積試行予算と状態をアーカイブしてゼロに戻していた。窓内の上限があっても、翌窓に再実行できる。既存の `failureStreaks` は同じ failureKey の連続失敗をTODO化するだけで、実行停止しない。理由が変わると連続数もリセットされる。

実台帳（2026-10-22T07:00Z以降）の例: Claude の `git-add-1` 8件、未コミット作業保護4件、理由キーのない failed 8件、Codex の exhausted 18件、window-info失敗3件。`quota-sweep-repo/.loop/quota-sweep-claude-state.md` は C1〜C4 証拠あり、C5独立checkerの user/kim 判断待ち、明示メッセージだけで再開と記録されている。過去の ignored `.loop` 救済失敗については基点コードに既に修正があり、今回の新規修正の効果とは数えない。全未完了をレーン故障とは扱わない。

**修正内容:** 同じ目標の累積試行数・FINALを窓が変わっても保持。目標変更時だけ旧契約を保存して新しい予算にする。failed/exhausted/deadline/ceiling が3回連続するプロバイダを台帳から復元して永続停止。deferralは回復として数えず、成功・目標なしで連続数をリセットする。窓API・モデル起動の前に停止を確認し、通知試行を先に永続化して重複通知を防ぐ。通知失敗も状態へ保存。修復後の明示的な `--resume claude` / `--resume codex` は停止解除の記録だけを行い、その場ではモデルを起動しない。

**実測結果:** 実台帳を `/tmp/nishi-stop-evidence/.claude/` へ複写し `enforceFailureStops` を2回実行。`allowed: []` が両回返り、Claude連続未完了7回、Codex31回を停止。通知先はテスト用記録関数で、通知は各プロバイダ1回・合計2回、2回目の増加なし。実DM配信および本番停止状態への書き込みは未実施。回帰テストでは実台帳と同じ起動経路 `main(..., {platform:'win32'})` で窓APIが呼ばれず、通知失敗後も再通知されないことを確認。窓変更後の8回上限保持と別目標の開始も検証。

**PR URL:** 未作成（共通の認証制約）。

## (2) DeepSeek

**原因:** 同期間の台帳464件は HTTP402=350件（`http_402` 346件 + 数値402が4件）、cooldown=59件、成功55件。失敗409件の内訳は残高不足とそのcooldownで一致。stderr相当の reason は `HTTP402: ... Insufficient Balance ... insufficient_balance_error`。429/413やモデル名エラーではない。

**修正内容:** 基点コードの `provider-routing.mjs` / `llm-ask.mjs` は既に OpenRouter のウォレットと `deepseek/deepseek-v4-flash` を使うよう修正済み。この変更を今回の成果には数えず、現行経路を実測した。残高追加、キー変更、cooldown解除は行っていない。

**実測結果:** `ORGIAST_HOME=/mnt/c/Users/user node tools/llm-ask.mjs --provider deepseek --no-fallback --max 32 --per-provider-timeout-ms 30000 'Reply OK only'` → exit 0、`OK only`、`[openrouter:deepseek/deepseek-v4-flash] in=7 out=3tok`。フォールバックなしで成功。

**PR URL:** 新規修正なし。既存経路の成功確認のみ。

## (4) cost-directive日次更新

**原因:** `register-cost-improve-task.ps1` の登録対象は `tools/cost-improve-loop.mjs`。同ファイルは `cost-work-loop.mjs` を呼んでいなかった。bootstrapログには `2026-10-29 07:23:58 / 対象実行 / ok:cost-improve-loop.mjs 終了コード=0` があり、日次処理の成功と指示書生成が結び付いていない。

**修正内容:** CLI起動時、フリート照会などより先に指示書生成を呼ぶ。選択されたhomeを子プロセスに渡し、5分の上限を設定。失敗・timeoutは非ゼロ終了として表に出す。成功ログは出力先とexit 0をstderrへ記録し、JSON出力を壊さない。dry-runは生成しない。

**実測結果:** `ORGIAST_HOME=/tmp/nishi-measured CODEX_HOME=/root/.codex node --input-type=module -e 'import {refreshCostDirective} from "./tools/cost-improve-loop.mjs"; console.log(refreshCostDirective({home:process.env.ORGIAST_HOME}));'` → `cost-directive refreshed: /tmp/nishi-measured/.claude/cost-directive.md (exit 0)`。実プロファイルのprojectsと台帳を読み取り用リンクで参照し、書き込みは `/tmp` に隔離した。Windowsタスクへの直接照会 `Get-ScheduledTask ...; Get-ScheduledTaskInfo ...` は `WSL ... UtilBindVsockAnyPort ... socket failed 1` で失敗。現在のタスクActionsとLastTaskResultの直接取得、本番更新・次回07:20の実行は未確認。

**PR URL:** 未作成（共通の認証制約）。

## (5) Codex計測

**原因:** Windowsの探索はWSL内の `/home/*/.codex/sessions` のみで `/root/.codex/sessions` を除外。WSLでWindows homeを報告対象にした場合もnative homeが漏れ、`CODEX_HOME` も未参照だった。実ログはroot配下に存在し、累積 `total_token_usage.output_tokens` とapply_patchが現在のパーサーで読める。加えてモデル別表示は旧 `gpt-5.6-sol` 固定で、実ログの `gpt-6.1-sol` を表示できない。

**修正内容:** WSL root、Windows homeからのWSL native home、`CODEX_HOME/sessions` を探索対象へ追加。WSLの二重UNC別名を同時走査しない。モデル別表示は実測モデル一覧から生成。

**実測結果:** `CODEX_HOME=/root/.codex node --input-type=module -e 'import {collectCodexUsage} from "./tools/usage-stats.mjs"; console.log(JSON.stringify(collectCodexUsage({home:"/tmp/nishi-measured",includePatchLines:true})))'` → `outputTokens:1155279, sessions:321, added:3207, deleted:146`。生成指示書は `out 1,155,279 tok / 321セッション`、`28.0% (Codex ±3,353行 / Claude手打ち ±8,639行)`。台帳の呼び出し回数とセッションログ件数は異なる母集団なので同一視しない。新モデル表示は実ファイル生成のテストでも `gpt-6.1-sol 1セッション/1.2k tok` を確認。

**PR URL:** 未作成（共通の認証制約）。

## (6) Stop gate

**原因・集計:** `stop-gate-runner-ledger.jsonl` の同期間、`verdict=block` 行の `blockedBy` を集計すると上位3件は `next-action-gate` 622回、`user-burden-gate` 161回、`verify-before-done-detector` 138回。対象は1095ブロックイベント、複数gate同時発火を含め1917ヒット。提示された2287回はprojects transcriptのStopフィードバックを数える指標で、runner台帳のgate別ヒット数とは母集団が異なる。今回生成時は追記も入り2301回になった。

**修正内容:** なし。上位gateの実装と直近の該当台帳行を確認したが、台帳excerptは短く、全文・検証証跡を欠くため誤検知を確証できなかった。バックグラウンド実行中の報告にも verify-before-done が出た事例は調査候補だが、確証済み誤検知とは報告しない。gate・hook・cooldownを緩和していない。

**実測結果:** PythonでJSONLを読み、`ts >= 2026-10-22T07:00:00` かつ `verdict == block` の行について `Counter.update(blockedBy)` → 上記件数。確証のある誤検知0件。

**PR URL:** 修正なし。

## 共通検証

`node --test tools/nishi-ai-repair.test.mjs tools/quota-sweep.test.mjs tools/usage-stats.test.mjs tools/cost-improve-loop.test.mjs tools/cost-work-loop.test.mjs` → **180 tests / 180 pass / 0 fail / 0 skipped**。`git diff --check` も成功。全toolsテストや本番Windowsタスク実行の成功は主張しない。
