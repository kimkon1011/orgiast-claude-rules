# リセット直前の残枠掃除

`OrgiastQuotaSweep` は15分間隔とスリープ復帰時に Claude Code / Codex の実測枠を確認し、リセット直前の余剰枠で専用 worktree の保守作業を進めます。makeloop は契約を作るだけで、継続はこのジョブだけが担当します。ヘッドレス `/goal` や他バックエンドへのフォールバックは使いません。

## 判定と終了

- リセットまで90分以内、残り15%以上の窓が対象です。
- Claude の5時間・7日枠は両方の残りを確認します。Codex は primary / secondary の両方を確認します。
- Claude API のリセット時刻にあるミリ秒単位の揺れは窓IDでは秒に切り捨てます。deadline は観測した実時刻から計算します。
- 同じ provider の最も早いリセットの3分前を絶対期限にします。期限まで10分未満なら開始しません。
- どれかの枠が97%以上、上限到達、観測不能、対話利用を検知したら止めます。実行中も30秒ごとに再確認します。
- 契約生成は最大15分、tick は最大45分です。どちらも絶対期限を優先します。Windows の `/T /F` によるプロセスツリー終了、独立 watchdog、WSL の `timeout --signal=KILL` を組み合わせます。
- 1リセットの試行は累積8 tick。予約は起動前に永続化し、中断した tick も消費済みです。連続2回の実行エラーで停止し、同じ窓の失敗は1回だけ再試行します。
- `final / ceiling / exhausted / deadline / no-goal` で終わった窓は再実行しません。`exhausted` は枠の上限到達または8 tick消費を表し、成功を意味しません。
- 新しいリセットでは前窓の状態と予算を `.loop/archive-*` に退避して新しい試行を開始します。同じゴールの契約は再利用し、最初に再検証します。ゴール変更時は契約も退避します。

期限後のモデル子プロセスは起動しません。push・PR作成・通知などモデルを呼ばない終了処理は期限後にも行います。処理はローカルの子プロセスを停止するもので、すでに送信したリクエストのサーバー側計上時刻までは制御できません。使用率の観測には遅延があるため、97%の判定だけで単一リクエスト中の増加や別PCの消費を厳密には制限できません。

## ゴール

優先順は次のとおりです。

1. `~/.claude/quota-sweep-goals.md` の最初の未完了行
2. `~/.claude/next-session.md` の実行可能な残TODO（「なし」や完了済みを除く）
実行可能な目標がなければ `outcome=no-goal` を記録し、子プロセスもDMも起動しません。「なし（完了）」「none (done)」なども空目標です。組み込みの保守目標への暗黙フォールバックはありません。

```markdown
- [ ] tools の既知のテスト失敗を修正し node --test tools/ を緑にする
- [ ] docs の壊れた相対リンクを修正する
- [x] 完了済みの項目
```

出典とゴールを state・レジャ・ログに残します。明示ゴールの完了チェックは人が更新してください。契約生成が質問で止まるなど、契約ファイルを生成できなかった場合は `tools/quota-sweep-contract.tmpl.md` を使います。

## 実行と配布

Windows のログインユーザーごとに `node tools/setup.mjs --converge` が optional の登録・導入を修復します。`OrgiastQuotaSweep` は同期リポから hidden 起動し、`StartWhenAvailable / MultipleInstances IgnoreNew / ExecutionTimeLimit PT2H30M` を使います。非Windowsでの通常実行・登録は何も開始せず終了します。WSL/Linux の `--dry-run` は利用できます。

作業先は `~/.claude/quota-sweep-repo` の専用 worktree。`~/.claude/nightly-repo` から origin/main を fetch して作り、人の作業ツリーは使いません。既存の未コミット作業は削除せず停止して保存します。同じ窓の再試行は同じブランチを使います。コミットがある場合だけ push と PR作成を行い、マージしません。`.loop/` はコミットせず作業先に残します。

Claude は既定 Sonnet、`--permission-mode auto`。Codex は WSL の ChatGPT 認証を優先し、WSL が無ければ native Codex を使います。既存のログインが必要です。他モデルサービスや API キーへのフォールバックはありません。

## 設定

`~/.claude/auto-session.env` に以下を設定できます。

```dotenv
ORGIAST_QUOTA_SWEEP=0
ORGIAST_QUOTA_SWEEP_MODEL=sonnet
```

`0` を削除するか `1` にすると有効です。モデルは環境変数でも指定できますが、Opus/Fable は拒否します。

## 証跡と検証

- `~/.claude/quota-sweep-state.json`: 窓ごとの実行状態、試行数、ゴール、ブランチ、PR
- `~/.claude/quota-sweep.jsonl`: 実行ごとの消費率 before/after・tick数・結果
- `~/.claude/quota-sweep.log`: 日時付き実行ログ
- `~/.claude/executor-usage.jsonl`: `quota-sweep:claude / quota-sweep:codex` の `in / out / tokens / secs`
- `~/.claude/quota-sweep.lock`: PID・開始時刻。所有プロセスの終了が確認できる場合だけ回収
- `~/.claude/.makeloop-installed.json`: プラグインの読戻し結果

```sh
node tools/quota-sweep.mjs --dry-run --json
node tools/quota-sweep.mjs --status --json
node tools/install-makeloop.mjs --dry-run
node tools/register-quota-sweep.mjs
node tools/setup.mjs --json
node --test tools/lib/quota-windows.test.mjs tools/quota-sweep.test.mjs tools/install-makeloop.test.mjs tools/lib/scheduled-task.test.mjs tools/setup.test.mjs tools/delegation-health-check.test.mjs tools/import-cycle.test.mjs tools/no-bare-node.test.mjs
```

`--provider claude|codex|all`、`--lead-min 90`、`--min-remaining 15`、`--home <隔離先>` も指定できます。dry-run はプロセス起動・通知・ロック・state書込みを行いません。判定候補には対話ガードや既実行窓の除外を適用していません。

## 既知の制約

Codex の利用率は API ポーリングではなくセッションログの最新ファイルの最終 `rate_limits` です。Windows とアクセス可能な WSL の両方から mtime 最新を採用し、6時間超は stale と明示します。最新ファイルに枠が無ければ過去の値に戻さず起動しません。ログの値は取得したアカウントのものなので、アカウント切替直後は新しいログが必要です。全PC間のロック共有や同一アカウントの排他はありません。

Claude の直近10分の対話記録、Codex の TUI プロセスがある間はその provider を使いません。Codex は監督ジョブ自身が `exec` の場合は対話扱いしません。Windows から到達できない WSL ホームは観測できません。読み書き権限・認証・git/gh の利用権限が不足した場合は成功扱いせず証跡を残します。

## 失敗診断と自動修復

台帳には `reason`（例外または停止条件）、`failureKey`（同じ原因の識別子）、`stopOutcome`、`deliveryError` を保存します。DMにも理由を表示し、PRが存在する未完了実行は `partial`（成果あり・未完了）と表示します。再試行可否は元の `stopOutcome` で判定します。

git fetch/push は1回300秒、失敗時に1回だけ再試行します。他のgit操作は120秒です。エラーにはサブコマンドを含めます。相対 `.git` ポインタは書き換えず、絶対ポインタの書込みがEPERM/EACCESで再試行しても失敗した場合は一時ファイルから置換します。既存ブランチ・未コミット作業は削除しません。

同じproviderで同じ原因が2回連続したら、既存の `handoff-audit-nightly.enqueueTodos` と `next-session-rotate.writeHandoff` で `next-session.md` に調査・回帰テスト・修正PRのタスクを重複なく起票します。利用窓が変わっても失敗回数は保持し、失敗以外の結果でリセットします。配布は既存の同期リポ・setup converge経路を使用します。

`executor-usage.jsonl` の `quota-sweep:<provider>` 行にも同じ `reason` / `failureKey` を書きます。これは `delegation-health` が `executor-usage.jsonl` しか読まないためです。`quota-sweep.jsonl` にだけ理由を置くと、全滅行が `no_output`（原因不明）と表示され、EPERM・窓情報不足・対話検出のどれだったのかを追えません（2026-10-21 の codex 6連続 failed がこの状態でした）。

利用窓の読み取り（`api.anthropic.com/api/oauth/usage`）は、1回のスイープで decision 用・開始前 check 用・再取得用と短時間に繰り返し呼びます。成功した読み取りは15秒だけ再利用し、失敗はキャッシュしません。読み取り理由が一時障害（HTTP 408/429/5xx、`network:`）で窓が0件のときは1回だけ読み直します。それでも失敗した場合は、空配列だけを残さず読み取り理由付きの `window-info` failed として記録します（2026-10-23T07:10Z/07:25Z の ticks=0 failed がこの形で、理由が落ちて原因を追えませんでした）。

`delegation-health` の全滅判定は、`quota-sweep:<provider>` では `status: failed` の行だけを分母にします。`deadline` / `ceiling` / `exhausted` / `no-goal` は「窓が無いので見送った」等の正常停止で、トークン0でもレーン故障ではありません（3回続くと high 起票になっていたため区別します）。

### 2026-10-23 調査証跡

- kim-PC `quota-sweep.log` 2026-10-21T12:55:55.781Z: `spawnSync git ETIMEDOUT`。旧commandRunnerは全コマンド60秒固定、再試行なし。旧ログにはサブコマンドがなくfetch等のどのgit操作だったかは確定不能。
- 同18:56:48.811Z: `.claude/quota-sweep-repo/.git` open EPERM。旧prepareTreeの絶対ポインタ書換え経路と一致。OS側の拒否要因（属性・共有ロック等）はログから確定不能。最新mainのchmod再試行/native継続策を保持し、置換を追加した。調査時点のポインタは既に相対。
- 2026-10-22T04:19:49.134Z、19:50:36.883Z: 理由なしfailed/ticks=0。checkの窓情報不足・対話検出分岐が理由を返さず、台帳・DMにも理由欄がなかった。どちらの条件だったかは過去ログから復元不能。
- 同14:21:18.934Z: child exit=1 stop=deadline、その後14:58:02.896ZにPR delivery ETIMEDOUT。finallyが元の停止結果をfailedで上書きし、例外を台帳に含めていなかった。
- 台帳2026-10-21T18:57:16.846Z: goal=なし（完了）。旧フィルタは「なし」単体だけ除外し、空の場合も組み込み目標へフォールバックしていた。
- PR #1014のブランチとCI全成功をGitHubで確認。WSL列挙結果はUbuntuのみ、`/home/kim/.claude` にquota-sweep台帳・両ログは存在せず、Windows台帳にも該当行なし。特定実行の停止理由は未確認。旧実装はPR作成後にもfailedを維持することをコードで確認し、回帰テストで再現・修正した。
