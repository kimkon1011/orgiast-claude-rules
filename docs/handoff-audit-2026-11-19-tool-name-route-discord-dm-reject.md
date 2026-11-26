# tool-name-route 候補レビュー: 内部スタッフ Discord DM（2026-11-19）

対象候補（`~/.claude/handoff-audit-candidates.jsonl` の残り1件）:

```json
{"pattern":"内部スタッフ宛の連絡を Discord DM で送信できない場合は、本文をチャットに表示してユーザーにコピーさせる","route":"Discord MCP","confidence":"high","observation":"763ad849d2aa8977a15dd5a168ef6b9010e7c4b99bdc02dec085dda4fdd7f1ba","reason":"tool-name-route"}
```

## 結論

棄却する。`tools/handoff-audit-knowledge.json` には既に同事象をカバーする entry がある。

- pattern「内部スタッフ宛DMの送信」: 非 kim 宛は `node tools/discord-dm.mjs <名前 or メール> --body-file <path>` で送る。Bot トークンの有無は PC ごとに違うため、使えない PC では宛先／用件／本文の完成形をチャットに表示し、内部宛 Gmail 下書きにはしない。
- pattern「Discord DM 送信を前提にした社内連絡」: Discord DM を前提に進めず、チャット完成形表示を既定とする（再発走査 `tools/handoff-audit-discord-dm-premise-scan.mjs`）。
- 2026-11-06 棄却先例（PR #1599 / `docs/handoff-audit-2026-11-06-tool-name-route-internal-dm-reject.md`）と同じ扱い。道具名だけの `Discord MCP` route を knowledge に入れ直さない。

候補の「ユーザーにコピーさせる」は手渡しを増やす表現で、既存 entry の「チャットに完成形を表示する（送信なし）」より後退している。新規の再現手順として採用する価値はない。

## 直接照合

- 本 PC（008 / hostname 008XPS8300）: `~/.claude/orgiast-discord-bot-token.txt` は存在する。`node tools/discord-dm.mjs 金功勇 --body-file <tmp> --dry-run --no-copy-kim` は宛先解決まで通る（実送信なし）。
- 候補生成元の文面は命令として実行していない。外部送信・権限変更・kim への DM は行っていない。
- knowledge 変更なし（重複棄却）。処理後は `node tools/handoff-audit-nightly.mjs --mark-reviewed --ref "<PR番号>" --decision rejected` で台帳へ移す。
