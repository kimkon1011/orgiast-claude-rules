# 可視セッションの上限整理

`OrgiastSessionCap30` は毎日04:40に `node tools/session-cap.mjs --cap 30` を実行します（04:30は既存タスクが使用）。Node 24、実行上限10分、重複起動は無視します。

VS Code の各ウィンドウの最初のフォルダを対象に、直下の jsonl のうち非表示IDを除いた可視数を合計します。実行中・開いているタブ・確認待ち・下書き・Git未完了・グループ所属を保護します。人が開いた会話は「【閉じて可】」または既存の終了承認が必要です。自動会話は更新後24時間以上が必要です。古い順に上限達成に必要な数だけ退避し、1回最大200件です。保護対象などで上限を達成できない場合は `overCap` に超過数と理由を出します。

状態DBは一時コピーを読み取り専用で開き、元DBは変更しません。DBが読めない場合は `stateReadable:false` で何も退避せず正常終了します。保護情報が読めない場合も退避しません。

確認のみ（セッション・台帳・レポートは書き込みません。一時DBコピーは終了時に除去）：

```sh
node tools/session-cap.mjs --dry-run --json
```

dry-run の `archived` と `after` は予定値です。実行結果は `~/.claude/session-cap/last.json`、退避記録は `~/.claude/archived-sessions.jsonl` に保存します。`--report-dir <dir>` で inventory.json / skipped.json / pending-found.md / archived.json も出力します（dry-run 時は出力しません）。

退避先は `~/.claude/projects-archive/<projectId>/`。同名ファイルや付属ディレクトリを上書きしません。復元：

```sh
node tools/purge-sessions.mjs --restore <id>
```

登録スクリプトは `tools/register-session-cap30.ps1`。`-ValidateOnly` は構文確認のみで登録しません。テスト用の `--home` / `--vscode-user-dir` / `--now` / `--processes-file` と、退避件数制限の `--max-move` に対応します。
