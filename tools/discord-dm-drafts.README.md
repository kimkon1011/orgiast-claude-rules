# Discord DM drafts (kim-PC)

Windows の Discord デスクトップと日本語の UI Automation 表示を使用する。ユーザートークンは不要。
`cost-reporter.env` の `REPORTER_LABEL=kim-PC` がある PC だけで実行・hook登録する。

```powershell
node tools/discord-dm-drafts.mjs scan --dry-run
node tools/discord-dm-drafts.mjs scan
node tools/discord-dm-drafts.mjs list
node tools/discord-dm-drafts.mjs edit <id> <UTF-8本文ファイル>
node tools/discord-dm-drafts.mjs send <id>
powershell -NoProfile -ExecutionPolicy Bypass -File tools/register-discord-dm-drafts.ps1
node tools/register-hooks.mjs --hooks-only
```

scan は5分以上無操作のときだけ未読DMを確認する。dry-run は切替・LLM・台帳更新なし。
通常 scan は会話ごとに元の会話に戻してから Gemini で案を生成する。
UI操作やユーザーの入力で無操作時間がリセットされた場合、残りは次回巡回に回す。
画面内のUIAツリーに存在する未読DMのみ対象（仮想化で非表示の会話は取得できない）。
直近20件以内、質問・依頼語を含むメッセージを対象にし、kim／金功勇の発言は除く。
返信案の文脈として直近の会話を Gemini に送る。

台帳は `~/.claude/discord-dm-drafts.jsonl`。同じIDの最終行が現在状態。
checkpoint は会話別の処理日時。初回は取得した直近20件から抽出する。
`pending` の案は UserPromptSubmit の additionalContext に要点を出し、list は全文表示する。
自動送信はしない。send は対象会話を開き、安全確認付きスクリプトで送信し、
新しいkimの発言として本文が読めたときだけ `sent` にする。
`uncertain`／`sending` は再送不可。Discord上の実態と台帳を手動確認すること。
同時書き込みは `.jsonl.lock` で防ぐ。異常終了後のロックは実行プロセスがないことを確認して削除する。
タスク登録は15分間隔、Interactive/Limited、run-hidden 使用。登録直後の即時実行は行わない。
