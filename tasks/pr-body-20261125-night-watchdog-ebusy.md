## Summary
- rescue `ddca5aa5` (`rescue/auto-session-20261122-024404`) のレビュー結果を着地
- `night-watchdog` の `appendLogLine` を `fs.appendFileSync` から `console.log` に変更
- `run-hidden.vbs` が同じログへ `cmd.exe >>` しているため、Windows で EBUSY になるのを避ける
- 未使用になった `fs` import を削除

## Test plan
- [x] `node --test tools/night-watchdog.test.mjs`（16 pass）
