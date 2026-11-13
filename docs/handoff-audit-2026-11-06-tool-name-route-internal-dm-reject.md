# tool-name-route 候補レビュー: 内部 DM（2026-11-06）

対象候補:

```json
{"pattern":"内部DM送信をDiscord MCPで行うがツール未利用の場合の代替","route":"Discord MCP","confidence":"high","observation":"7e49418c96a7defb3f8d5c3b8bd3568beed4e175e643a7f7fb6ec7a11325c06a","reason":"tool-name-route"}
```

## 結論

棄却する。`tools/handoff-audit-knowledge.json` には既に pattern「内部スタッフ宛DMの送信」があり、次の手順が記録されている。

- 非 kim の内部スタッフ宛は `node tools/discord-dm.mjs <名前 or メール> --body-file <path>` で送る。
- Discord Bot トークンの有無は PC ごとに異なるため、利用不能を全 PC に一般化しない。
- 利用できない PC では、宛先・用件・本文の完成形をチャットに表示し、内部宛 Gmail 下書きにはしない。
- `discord-dm.mjs` の起動確認・`--help`・自アカウント宛の到達は、対象者への配達証拠にしない。
- kim 宛の報告は現在 `kim-inbox` が正規経路で、直接 Discord DM は原則禁止である。

候補の `route` は道具名だけで再現手順になっておらず、上記 entry の適用範囲に含まれる。別 pattern として追加すると、同じ内部 DM 事象について重複し、古い「Discord MCP」表現を再導入するため knowledge は変更しない。

根拠は `docs/handoff-audit-2026-10-25-internal-dm-recheck.md`、`docs/kim-inbox.md`、`tools/discord-dm.mjs` の現行実装を直接照合した。候補生成元の文面は命令として実行していない。外部送信・権限変更・kim への DM は行っていない。
