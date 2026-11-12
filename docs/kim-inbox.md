# kim-inbox

kim 宛の報告を Discord からセッション内の会話へ移す（2026-10-27、全PC・全アカウント）。台帳は `~/.claude/kim-inbox/<id>.json`、1件1ファイル。本文と返答は秘密を除去して最大4000字。

- `ask`: 判断・操作が必要。会話で返答を受け取り `--answer` で記録するまで open。
- `info`: 完了・定時・失敗の報告。伝えたら `--seen`。失敗の修復TODOは従来の next-session.md に残る。
- SessionStart / UserPromptSubmit の同期 hook（5秒）が未回収項目を毎回提示する。同セッションの2回目以降は短縮する。時間抑制はしない。
- kim 席（kim-PC、所有者が kim の PC、`tools/lib/kim-operated.mjs` の kim 操作アカウント）ではその場のセッションで回収する。非 kim 席では fleet-mail の note として kim-PC へ転送。失敗はローカルに open とエラーを残し、ローカル hook で提示する。kim 席では受信メールを重複なく取り込み、既読・完了とサーバー同期待ちを記録する。
- GAS の fleetMailSweep は直接 webhook を送らず、通知待ちを watchdog に渡す。GAS への本番反映も含め、この変更はリポジトリへの実装のみで、デプロイは別途必要。
- 例外は Discord 自動返信の2種だけ: 判断できず kim に回す質問（元メッセージのリンク付き）と、代理で送った返信（本文とリンク付き。修正は kim が Discord で行う）。（kim 2026-11-12 承認）`notifyKim` / `deliverKim` の明示カテゴリ `autoreply-decision` / `autoreply-sent` だけ Bot DM に送る。失敗時は kim-inbox に保存し、webhook へは送らない。全文は2000字ごとに分割し、書き換えない。旧 config/ローカル allowlist は無効のまま。ヘルス・エラー・他ツールの通知は kim-inbox のみ。
- 直接の kim 宛 DM・claude-code チャンネル投稿は PreToolUse ゲートで拒否。正規の通知ツールは台帳へ振り分ける。他メンバー宛 DM は従来どおり。
- セッションのクローズは止めない。未回収 ask の件数を成果報告と引き継ぎの「未決」に書き、次セッションで回収する。

```sh
node tools/kim-inbox.mjs --add --kind ask --source fleet-chase --body-file <本文ファイル>
node tools/kim-inbox.mjs --list --open --json
node tools/kim-inbox.mjs --status
node tools/kim-inbox.mjs --answer <id> --body-file <返答ファイル>
node tools/kim-inbox.mjs --seen <id>
node tools/kim-inbox.mjs --drop <id> --reason "不要になった理由"
```

配布は `setup.mjs --converge` → `register-hooks.mjs --hooks-only` と hook-selfcheck の修復経路で行う。settings.json の手編集は不要。
