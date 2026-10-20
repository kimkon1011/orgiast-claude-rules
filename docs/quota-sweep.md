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
3. テスト・import・構文エラーの修正。全部緑なら `docs/` の相対リンク修正

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
