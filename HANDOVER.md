# 引き継ぎ

- 期限台帳の所有者は kim@orgiast.jp。移管時は `.claude/deadline-watch/config.json` の sheetId／mailboxes／driveUsers／lineSheets／vehicleSheetId／kimNames／calendar.calendarId と、DWD代理ユーザー・共有先・kim席判定を確認する。運用は [期限台帳](docs/deadline-watch.md)。
- Beeper Relay（beeper-relay）：中継サーバーは tools/beeper-relay-server.mjs、kim-PC のタスクスケジューラ `OrgiastBeeperRelay` で管理。全クライアントの設定は `~/.claude/beeper-relay/clients.json`（トークンハッシュ保存）。移管時は Beeper Desktop の再セットアップ・全クライアント失効と再発行が必要。運用は [docs/beeper-relay.md](docs/beeper-relay.md)。
