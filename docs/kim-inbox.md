# kim-inbox

kim 宛の報告を Discord からセッション内の会話へ移す（2026-10-27、全PC・全アカウント）。台帳は `~/.claude/kim-inbox/<id>.json`、1件1ファイル。本文と返答は秘密を除去して最大4000字。

- `ask`: 判断・操作が必要。会話で返答を受け取り `--answer` で記録するまで open。
- `info`: 完了・定時・失敗の報告。伝えたら `--seen`。失敗の修復TODOは従来の next-session.md に残る。
- SessionStart / UserPromptSubmit は ask を「何の件／起きたこと／判断してほしいこと／返事の例」の4行形式で注入する。Stop の `kim-inbox-relay` は kim 操作席の有人セッションで、注入された open ask と未配達 high info を最後の `【受信箱】` 節に要求する。目的外の作業依頼とは扱わない。無人 `claude -p` と subagent は対象外。
- `shownCount` は注入回数。`deliveredToKim` は全 Stop チェックを通った最終メッセージの ID と要点を検証した受領記録（revision・count・lastAt・sessions）。同じ ask は同セッションで JST 1日1回、info は内容が変わるまで再掲しない。新規セッションの ask は改めて伝える。
- 直前の受信箱節の番号に `1 可`、または ID に `ki-... 可` と返答した場合、UserPromptSubmit が既存の `--answer` と同じ `answerItem` を実行する。回答のみの発話・同セッション・同内容の ask に限定し、複数の内部選択肢がある ask の番号回答は自動確定しない。曖昧な返答や詳しい返答は Claude が `--answer --body-file` で記録する。
- kim 席（kim-PC、所有者が kim の PC、`tools/lib/kim-operated.mjs` の kim 操作アカウント）ではその場のセッションで回収する。非 kim 席では fleet-mail の note として kim-PC へ転送。失敗はローカルに open とエラーを残し、ローカル hook で提示する。kim 席では受信メールを重複なく取り込み、既読・完了とサーバー同期待ちを記録する。
- GAS の fleetMailSweep は直接 webhook を送らず、通知待ちを watchdog に渡す。GAS への本番反映も含め、この変更はリポジトリへの実装のみで、デプロイは別途必要。
- kim 宛 Discord DM とメールによる報告は使わない。例外なし。keyserve の登録リンクの既存チャンネル投稿は残し、呼び出し側の `knowledge-lock passkey-link` が kim-inbox にも ask として保存する。
- 直接の kim 宛 DM・claude-code チャンネル投稿は PreToolUse ゲートで拒否。正規の通知ツールは台帳へ振り分ける。他メンバー宛 DM は従来どおり。
- セッションのクローズは止めない。未回収 ask の件数を成果報告と引き継ぎの「未決」に書き、次セッションで回収する。

### 同じ質問を繰り返さない（2026-11-19）
- 原因の実測: `auto-progress-escalate` が自動進行台帳の判断待ち行ごとに毎日新しい ask を作っていた（190 行から 1273 件、1083 件が重複）。受信箱で回答しても台帳の行は open のままで、翌日また聞いていた。社外返信待ちの回答（`kim-awaiting --answer ex:…`）も保存されるだけで読まれず、同じ項目が質問として出続けた。
- エスカレーションは `dedupeKey: auto-progress-escalate:<行キー>` で1行1件。受信箱に同じ行の ask（旧形式の本文一致を含む）があれば新しく積まない。回答・取り下げは `lib/escalation-answer-sync.mjs` が台帳の行に `kimAnswer`・`nextKim: なし` として書き戻す（`answerItem` / `dropItem` と escalate の両方から）。
- `kim-awaiting` は `external-waiting-answers` の回答を読み、回答済みの社外項目を「✅ kim 回答済み・Claude が対応」に分け、hook の質問一覧からは外す。回答後に同じスレッドへ新しい受信が来たら再び質問に戻る。
- 質問前の照合: `node tools/kim-inbox.mjs --lookup "<語> <語>"` で回答済み ask を探す。セッション内で受けた答えは kim-inbox に記録して他セッションと共有する。
- kim が外すと決めた MCP は `~/.claude/mcp-optout.json`（`{"disabled":["gemini-cli"]}`）に書く。`register-hooks.mjs` と `tool-adoption-check.mjs` はこれを見て再登録しない。

### 外部完了メールによる自動クローズ (--done-when-gmail)
完了時にメールが届く手作業（保険継続・支払い・予約・配送・手続き等）の `ask` を登録する際は、必ず `--done-when-gmail "<user>|<gmail query>"` を指定する。該当メールが到着すると `autoCloseByGmail` が自動で項目を回答済みにし、再提示を防止する。

```sh
node tools/kim-inbox.mjs --add --kind ask --done-when-gmail "seisaku-team@orgiast.jp|【自動車保険】継続手続完了のお知らせ" --body-file <本文ファイル>
node tools/kim-inbox.mjs --list --open --json
node tools/kim-inbox.mjs --status
node tools/kim-inbox.mjs --auto-close
node tools/kim-inbox.mjs --answer <id> --body-file <返答ファイル>
node tools/kim-inbox.mjs --seen <id>
node tools/kim-inbox.mjs --lookup "gemini 外して"
node tools/kim-inbox.mjs --drop <id> --reason "不要になった理由"
```

### 表示規則（最後のメッセージだけ・新着だけ・loop 起床は抑止）
hook の一覧注入は `inbox-display-policy` で制御する。同セッションの既出は再掲せず、新着のみを【最終まとめ】の中に載せる。`<<autonomous-loop` や `/loop` の起床では一覧を注入しない。既出は「ほか既出 N 件」の1行に縮める。別セッションでも24時間以内に表示済みなら同様に省略する。

配布は `setup.mjs --converge` → `register-hooks.mjs --hooks-only` と hook-selfcheck の修復経路で行う。settings.json の手編集は不要。
