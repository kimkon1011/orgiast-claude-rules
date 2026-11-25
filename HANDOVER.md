# 引き継ぎ

- 期限台帳の所有者は kim@orgiast.jp。移管時は `.claude/deadline-watch/config.json` の sheetId／mailboxes／driveUsers／lineSheets／vehicleSheetId／kimNames／calendar.calendarId と、DWD代理ユーザー・共有先・kim席判定を確認する。運用は [期限台帳](docs/deadline-watch.md)。
- 停滞セッション再開は `config/auto-resume.json` と `config/standing-send-permissions.json` に個人依存しない設定を集約し、`tools/register-stalled-session-nightly.mjs` を `setup --converge` から実行する。移管時はリポジトリと fleet のPC登録を引き継げばよく、個別PCへの手登録は不要。
