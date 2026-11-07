# このPCで進んでいない処理を調べる

最初に同期済みリポジトリから `node tools/stall-scan.mjs` を実行する。日本語の表で症状・実データ・原因候補・次の自動処理を確認できる。機械処理には `--json` を使う。診断は通知・プロセス停止・タスク登録を行わず、結果だけを `%USERPROFILE%\.claude\stall-scan.json` に保存する。

1. **画面監視**: `heartbeat/stuck-dialog-watch.json` が10分以内か、ok=trueか確認する。`OrgiastStuckDialogWatch` はログイン中の利用者として5分ごとに290秒実行する。監視対象は OpenWith.exe、WerFault.exe、`tools/stuck-dialog-patterns.json` の文字列をタイトルに含む可視の最上位ウィンドウ。通知はPC・種類ごとに6時間に一度（送信失敗時も同じ制限）。
2. **タスクとログ**: Orgiastタスクの終了値、次回時刻、繰り返し間隔、`nightly-health-expectations.json` の更新期限を比較する。実行中(267009)と初回待ち(267011)は失敗に数えない。初回の予定時刻より前なら未実行扱いにしない。周期が不明なタスクは次回予定の超過のみ判断する。スリープ直後は追いつき実行も確認する。
3. **生存報告とローカルサーバー**: heartbeat の周期・成功値を確認する。常時必要なサービスのポートは `%USERPROFILE%\.claude\stall-scan-servers.json` に `{"servers":[{"name":"開発サーバー","host":"127.0.0.1","port":3000,"repairHint":"起動ログと既存の登録タスクを調査"}]}` の形式で登録する。任意起動の開発サーバーは登録しない。共通設定は `tools/stall-scan-servers.json`（初期値は空）。未設定ポートは推測しない。
4. **利用待ちと会話**: provider/codex の既存 provider-cooldown.json（codexも同じファイル）、stalled-session-resume.json、stall-sweeper-log.jsonl を確認する。利用待ちは失敗にせず期限まで既存 executor-gate に任せる。会話の内容から独自の停滞判定は作らず、再開ツールの結果を読む。

## 証拠の読み方

`%USERPROFILE%\.claude\logs\stuck-dialog\YYYY-MM-DD.jsonl` はUTC日付で分割する。各検知行の `at`、`dialogPid`、`title`、`creationDate`、`candidates`、`runningScheduledTasks` を見る。候補は画面プロセスの生成前15秒に起動したプロセスで、commandLine と最大4段の parents を含む。PIDだけでなく生成時刻で同一性を確認する。閉じられなかった場合は別行の `closeErrors` を読む。CIM失敗・権限不足はheartbeatのok=falseに残す。タスク照会失敗は `taskQueryError` に残す。

候補と実行中タスクは時刻の相関であり、原因の断定ではない。DCOMの svchost が親でも、直前に ShellExecute を呼んだ本来の起動元が候補に残る可能性がある。2026-10-17の事故原因は未確定。コマンドラインはローカル証拠へ保存し、通知には実行名・PID・証拠パスだけを送る。

監視は管理者権限に依存しない2秒ポーリングを標準とする（ProcessStartTrace の管理者イベント購読は実装しない）。Win32_Process は1回の照会で収集し、既存process-hygieneと列挙コードを共有する。終了したプロセスの情報は最終観測から60秒、稼働中の親情報は生存中保持する。2秒未満のプロセス、照会処理が長引いた間、5分周期の切替約10秒、再起動直後、ログアウト中、別ユーザーのデスクトップ、権限の異なる画面は取り逃し得る。稼働前からある画面の直前プロセスは復元できない。WM_CLOSEは要求なので、アプリが無視すれば次の照会でも残り、再試行する。強制終了は指定されたOpenWith/WerFaultのPIDだけに限定する。

## どのツールが直すか

- `register-stuck-dialog-task.mjs --ensure`: 未導入・停止した監視を登録し開始する。`--dry-run` は計画のみ。run-hidden.vbs、フルパスのNode、Interactiveユーザー、IgnoreNewを使用する。新規PCは setup --converge、既存PCは日次 fleet-poller.ps1 の自己修復とsetup収束を通る。配布対象は distribution-manifest の tools/docs に含まれる。
- `nightly-health.mjs`: 日次に stall-scan を実行し、異常を `.nightly-health-last.json` に渡す。`nightly-health-remediate.mjs` の専用playbookが監視を再登録・開始し、新しい正常heartbeatを確認する。画面検知そのものと他の異常は既存の修復レーンで調査する。利用待ちは修復PRを作らない。
- `process-hygiene.mjs` / `stall-sweeper.mjs`: 残留プロセスの整理・停滞作業の再確認。`stalled-session-resume.mjs` は既存の再開条件と上限を守る。
- SessionStart: 日次診断の保存済み異常を1行添える。30時間超の結果には古い旨を明記し、起動時に重いCIMやネットワーク照会を追加しない。

`stuckDialogs24h` は fleet-sheet-report の追加項目と fleet-beacon の既存steps経路で中央へ運ぶ。beaconは現行GASでも受信可能。シートの専用列は同梱GASを通常のデプロイ経路で更新後に表示する。GASの本番更新はこのPRでは実行しない。

kimへ求めるのは本人の認証・OAuth同意、OSで必要な権限変更や再起動、レビュー／マージなど、人しかできない操作だけとする。通常の未登録・ログ停止・利用待ちは自動修復と再確認へ回す。再発は証拠と試した修復を添えて、必要な人の操作を1点に絞る。

検証は外部通知・タスク登録・プロセス停止をモックする。fleet-mail-v2の既知赤はこの機能の回帰と混同せず、必要なら同じmainで再現比較して別課題として扱う。
