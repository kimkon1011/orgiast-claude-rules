# 停滞セッションの夜間再開

`tools/stalled-session-resume.mjs` は `session-triage.mjs` の `listFiles` / `inspect` の結果を使う。両関数を export にしただけで、検出規則は変更していない。

`auto-session.runChild` の既存経路を使う。Claude は共有の引数組立に追加した `resumeSessionId` で元セッションを再開する。cheap-code は元 transcript の全体と前回の成果記録を読み、元の cwd で続行する。モデル・プロバイダ選択、安価なプロバイダ間の再試行、明示的に許可された Claude fallback は既存設定を継承する。子の終了コード0だけでは進捗扱いにせず、成果の evidence を持つ結果ファイルを必要とする（実行者の自己申告であり、独立した成果物監査ではない）。

## 上限と状態

- `STALLED_SESSION_LIMIT`: 未設定は無制限。`--limit all` または数値 `--limit N` で上書き。
- `STALLED_SESSION_DEADLINE` / `--deadline HH:MM`: 既定ローカル07:30。締切後の新規起動を止め、実行中の子はtimeoutまで待つ。
- `STALLED_SESSION_CONCURRENCY` / `--concurrency N`: 既定2。同じcwdは直列。未試行→最後の試行日が古い順→score降順→ageDays昇順。
- `STALLED_SESSION_TIMEOUT_MIN`: 1件20分。fallback を含む合計時間。プロセスツリーを打ち切る。
- `STALLED_SESSION_ACTIVE_MIN`: 直近10分以内の transcript は除外。
- 進捗なし・エラー・実行途中で親が終了した試行を3回消費すると永久スキップ。進捗ありで連続無進捗回数は0に戻す。総試行数と履歴は保持。
- 完了順で連続3エラーでその晩を中止。再起動しても中止状態と件数上限は保持。
- closed ledger 記帳済み・閉じて可・待機期限前・active・今晩処理済みを除外。7日以上前でも未完了なら確認対象。
- 台帳は各アカウントの `~/.claude/stalled-session-resume.json`。起動前に試行を原子的保存。既存 `autopilot-tick.acquireLock` で排他と死亡した所有者のロック回復。
- 夜の区切りは既存 `auto-session.localDate` のローカル日付。
- Discord は実行結果をまとめて `notifyKim` に1回渡し、配信結果も記録。候補があれば実行0件でも集計を送る。未closedの3回進捗なし一覧を最大20件、タイトルとsessionId付きで判断待ちとして報告。

`node tools/stalled-session-resume.mjs --dry-run` は予定だけを表示する。
`--list` は全候補・試行数・スキップ理由を表示する。両方とも台帳・ロック・結果ファイルを書かず、実行者も通知も起動しない。通常実行は明示的なフラグ不要。

## 配布

`nightly-batch.ps1` はtriage更新までを担当し、再開処理は専用タスク `OrgiastStalledSessionSweep` に分離。毎日03:05（RandomDelay 2分）、StartWhenAvailable、バッテリー可、最大5時間、hidden runnerでrepoのスクリプトを実行する。

`setup-manifest.json` に実体の存在確認と `onboarding-sync --force` 修復を追加。必須の `task:stalled-session-sweep` と既存 `task:nightly` の修復を `register-stalled-session-nightly.mjs` に統一。両タスクを登録・読戻し検証する。Windows の未登録PCは `setup --converge` で既存インストーラと同じ03:00・最大5時間・hidden runner・自己同期 nightly-bootstrap のタスクを登録し、登録後に action を読み返す。登録済みPCは既存タスクと自己同期経路で変更を受け取る。アカウント・ホスト名を固定しない。現行のタスク配布は Windows 対象で、非Windows用のスケジューラはこのリポの経路に含まれない。

この変更はローカル実装のみ。push・PR・本番タスク登録・実セッション再開・実通知は実施していない。全PCへの到達は、この変更が配布正本に反映された後の既存同期に依存する。

## 検証結果（2026-09-24）

- `node --test tools/stalled-session-resume.test.mjs`: 14 pass / 0 fail。
- `node --test tools/*.test.mjs`: 2999 pass / 0 fail / 11 skip（3010 tests）。
- `node tools/selftest-guards.mjs`: 68 PASS / 0 FAIL、ALL PASS。
- PowerShell 5.1 の構文解析、隔離 transcript での実CLI dry-run、Git diff whitespace check も成功。
- 全体テストは Windows ドライブ上の隔離チェックアウトで実行し、変更したコード9ファイルが作業ツリーとバイト単位で一致することを確認後にコピーを削除した。元ツリーでのGit読み取りの45秒制限とCRLF依存の既存テスト失敗、一時Linux領域のUNCパスによるPowerShell結合テスト失敗を避けるため。既存テストのアサーションや本体は変更していない。
- 本番のタスク登録・実セッション再開・Discord送信は実施していない。
