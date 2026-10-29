# next-action-gate 登録済み起床手段の修正

基準: origin/main e9f6ce9fa538224a2aaca28b5530082c00ab65b8。

ScheduleWakeup の最新呼出しを追跡し、stop:true、失敗、期限切れを除外する。予定時刻は tool_result の toolUseResult.scheduledFor を優先し、なければ呼出し時刻と delaySeconds で求める。Monitor と run_in_background Bash は tool_use_id と taskId/task_id/backgroundTaskId を対応づけ、TaskStop または completed/stopped/failed task-notification で除外する。通常のユーザー発言や task-notification によるターン境界では登録を消さない。sidechain/API blob は登録として扱わない。既存の他の gate 条件は維持。

## テスト

Linux Node v22.23.4:

`node --test tools/next-action-gate*.test.mjs`

100 tests / 100 pass / 0 fail。詳細: next-action-gate-linux-test.log。
Windows Node も起動を試みたが WSL の `UtilBindVsockAnyPort:317: socket failed 1` により起動前に失敗。Windows のテスト通過は未確認（next-action-gate-windows-test.log）。

## 実 transcript の比較

対象: ~/.claude/projects/d--Claude-CLAUDE-md--/5fd545ff-f395-43fd-9d12-52f9c230229f.jsonl。
フッターを含む assistant 応答23件を、それぞれの応答までの transcript と応答 timestamp を now に指定して修正前後で再判定した。実台帳の session_id は注入せず、transcript による証拠だけを比較。

- 修正前: pass 11、AUTOPILOT-NO-SESSION-WAKEUP 11、NEXT-ACTION-DEFERRAL 1。
- 修正後: pass 22、NEXT-ACTION-DEFERRAL 1。
- 11件の起床手段の見落としが解消。他の判定は変化なし。

各行番号・時刻・判定: next-action-gate-transcript-comparison.json。

## 引き渡し

.git は環境の権限設定で読み取り専用のため、新ブランチ作成・push は実施していない。作業中に外部の auto-session-rescue によるコミット（0c091d6）が発生したため、HEAD 差分ではなく開始時 origin/main 基準で next-action-gate-wakeup.patch を出力した。パッチは実装2ファイルとテスト2ファイルを含む。
