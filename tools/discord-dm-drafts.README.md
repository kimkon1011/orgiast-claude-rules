# Discord DM・グループDM 自動返信 (kim-PC)

2026-11-12: DM・グループDMは `discord-beeper-autoreply` に移行。Beeper Desktop API から既読も取得し、kim 宛の質問には承認不要で自動返信する。本文先頭は `【AI自動返信】`。判断待ちと代理返信全文はリンク付き Bot DM で kim に報告する。

新しい運用・登録・検証手順は [プレイブック](../playbooks/discord-beeper-autoreply.md)。旧 UI Automation の定期 scan は重複するため移行対象。今回のコード変更では既存タスクの削除や新タスクの登録・実行は行わない。旧台帳の pending を新ツールで自動送信することもない。

## 旧 UI Automation ツール（履歴・既存台帳の参照用）

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
旧ツール自体は自動送信しない（新運用は Beeper から自動返信する）。send は対象会話を開き、安全確認付きスクリプトで送信し、
新しいkimの発言として本文が読めたときだけ `sent` にする。
`uncertain`／`sending` は再送不可。Discord上の実態と台帳を手動確認すること。
同時書き込みは `.jsonl.lock` で防ぐ。異常終了後のロックは実行プロセスがないことを確認して削除する。
タスク登録は15分間隔、Interactive/Limited、run-hidden 使用。登録直後の即時実行は行わない。


2026-11-12: scan は無操作5分を確認した後、Discord が未起動なら
`%LOCALAPPDATA%\Discord\Update.exe --processStart Discord.exe` で起動し、
ウィンドウを最大30秒待ちます。起動済みなら重複起動しません。
フレンド画面など元の会話が無い場合はスキャン後の復帰を省略します。
起動処理はキー入力・貼り付け・投稿を行いません。
