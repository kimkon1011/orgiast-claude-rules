# kim-inbox

kim 宛の報告を Discord からセッション内の会話へ移す（2026-10-27、全PC・全アカウント）。台帳は `~/.claude/kim-inbox/<id>.json`、1件1ファイル。本文と返答は秘密を除去して最大4000字。

- `ask`: 判断・操作が必要。会話で返答を受け取り `--answer` で記録するまで open。
- `info`: 完了・定時・失敗の報告。伝えたら `--seen`。失敗の修復TODOは従来の next-session.md に残る。
- SessionStart / UserPromptSubmit は ask を ID と要点1行で注入する。Stop の `kim-inbox-relay` は kim 操作席の有人セッションで、注入された open ask と未配達 high info を最後の `【受信箱】` 節に要求する。目的外の作業依頼とは扱わない。無人 `claude -p` と subagent は対象外。
- `shownCount` は注入回数。`deliveredToKim` は全 Stop チェックを通った最終メッセージの ID と要点を検証した受領記録（revision・count・lastAt・sessions）。同じ ask は同セッションで JST 1日1回、info は内容が変わるまで再掲しない。新規セッションの ask は改めて伝える。
- 直前の受信箱節の番号に `1 可`、または ID に `ki-... 可` と返答した場合、UserPromptSubmit が既存の `--answer` と同じ `answerItem` を実行する。回答のみの発話・同セッション・同内容の ask に限定し、複数の内部選択肢がある ask の番号回答は自動確定しない。曖昧な返答や詳しい返答は Claude が `--answer --body-file` で記録する。
- kim 席（kim-PC、所有者が kim の PC、`tools/lib/kim-operated.mjs` の kim 操作アカウント）ではその場のセッションで回収する。非 kim 席では fleet-mail の note として kim-PC へ転送。失敗はローカルに open とエラーを残し、ローカル hook で提示する。kim 席では受信メールを重複なく取り込み、既読・完了とサーバー同期待ちを記録する。
- GAS の fleetMailSweep は直接 webhook を送らず、通知待ちを watchdog に渡す。GAS への本番反映も含め、この変更はリポジトリへの実装のみで、デプロイは別途必要。
- kim 宛 Discord DM とメールによる報告は使わない。例外なし。keyserve の登録リンクの既存チャンネル投稿は残し、呼び出し側の `knowledge-lock passkey-link` が kim-inbox にも ask として保存する。
- 直接の kim 宛 DM・claude-code チャンネル投稿は PreToolUse ゲートで拒否。正規の通知ツールは台帳へ振り分ける。他メンバー宛 DM は従来どおり。
- セッションのクローズは止めない。未回収 ask の件数を成果報告と引き継ぎの「未決」に書き、次セッションで回収する。

### 外部完了メールによる自動クローズ (--done-when-gmail)
完了時にメールが届く手作業（保険継続・支払い・予約・配送・手続き等）の `ask` を登録する際は、必ず `--done-when-gmail "<user>|<gmail query>"` を指定する。該当メールが到着すると `autoCloseByGmail` が自動で項目を回答済みにし、再提示を防止する。

```sh
node tools/kim-inbox.mjs --add --kind ask --done-when-gmail "seisaku-team@orgiast.jp|【自動車保険】継続手続完了のお知らせ" --body-file <本文ファイル>
node tools/kim-inbox.mjs --list --open --json
node tools/kim-inbox.mjs --status
node tools/kim-inbox.mjs --auto-close
node tools/kim-inbox.mjs --answer <id> --body-file <返答ファイル>
node tools/kim-inbox.mjs --seen <id>
node tools/kim-inbox.mjs --drop <id> --reason "不要になった理由"
```

配布は `setup.mjs --converge` → `register-hooks.mjs --hooks-only` と hook-selfcheck の修復経路で行う。settings.json の手編集は不要。
