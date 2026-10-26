# handoff-audit 検証記録: 社内スタッフ宛の連絡 × route「Discord MCP」（2026-10-23）

対象 TODO: `[handoff-audit:d149c64e419fb482] 社内スタッフ宛の連絡 — この handoff が再発していないかを実物で検証し結果を記録する（再発防止の経路: Discord MCP）`

id は `sha256(JSON.stringify([NFKC(pattern), NFKC(route)])).slice(0, 16)` で再計算し一致を確認した
（`tools/handoff-audit-nightly.mjs` の `hash`/`key` と同一式・実測 `社内スタッフ宛の連絡` × `Discord MCP` = `d149c64e419fb482`）。

## 結論（3点）

1. **再発 0。** 原文検出（2026-10-21T18:02:03.431Z / `4d7e4383`）以降の 6 台帳 585 行に、内部スタッフ宛の連絡を保留・送信不可で締めた記述は無い（§2）。
   同語のヒットは `b822034d` の 01:32–01:33Z の 3 行だけで、宛先は **kim の Bot トークン発行依頼**（fleet-mail）であり、内部スタッフ宛ではない。
2. **保留されていた連絡は失われていない。** 同じ `b822034d` は同日 04:38Z 以降に `#経理チーム` へ実際に投稿しており（§3）、`41a63819` も 04:38Z / 05:35Z / 06:50Z に実送信を台帳へ残している。
3. **ただし経路「Discord MCP」はこのPC（HP）では実行できない。** MCP 自体が未構成で、`tools/discord-dm.mjs` は Bot トークン無し、`tools/discord-channel-id.mjs` は台帳 env 不在で ENOENT（§4）。
   このままでは次のセッションが同じ「存在しない送信口」を再試行するため、knowledge の route を実測に合わせて是正した（§5）。送信・権限変更は行っていない。

## 1. 原文の同定（一次証拠）

`~/.claude/handoff-audit-nightly-ledger.jsonl` の 2026-10-21T18:02:03.431Z 行（session `4d7e4383-0676-451a-9c40-1dcc90a7c40c` / verdict=block）:

```
rule 2: 「kim さんへの依頼文は、次の内容で私から Discord の DM で送れます。」
rule 5: 「次に kim がすること: 上の依頼文を kim さんへ DM で送ってよければ「送って」とだけ返す」
rule 12: 「DM の実送信です。どちらも、所有者の kim さんの設定が必要です。」
learned: {"pattern":"社内スタッフ宛の連絡","route":"Discord MCP","confidence":"high"}
```

同 route の昇格は `~/.claude/handoff-audit-promotions.jsonl` 6 行目（observation `a3ba93d3…`）。同日 18:02:12.994Z の
`8b90fb50` にも「宮地さんへの Discord DM … まだ送っていません。kim さんのOKが出てから送ります」（rule 7）がある。

## 2. 再発走査（実物・読み取りのみ）

窓 = `2026-10-21T18:02:22.929Z`（当該監査の最終行）より後〜2026-10-23 実行時。
一致語 = `Discord MCP|Discord コネクタ|送ってよければ|OKが出てから送|まだ送っていません|送信不可|送れません`。

| 台帳 | 窓内行数 | 一致 |
|---|---:|---:|
| `handoff-audit-ledger.jsonl` | 217 | 3（すべて `b822034d` 01:32–01:33Z の同一 excerpt） |
| `stop-gate-runner-ledger.jsonl` | 74 | 3（同上の重複記録） |
| `course-corrections-ledger.jsonl` | 226 | 0 |
| `auto-progress-ledger.jsonl` | 66 | 0 |
| `handoff-audit-nightly-ledger.jsonl` | 1 | 0 |
| `handoff-audit-deferral-ledger.jsonl` | 1 | 0 |
| **計** | **585** | **実質 1 件（内部スタッフ宛ではない）** |

補助として `~/.claude/next-session.md` / `~/.claude/auto-session/runs/*.summary.md` / `~/.claude/session-handoffs.md` も
同じ語で grep したが、当該 TODO 行以外に一致は無かった。`4d7e4383` 自身は当該ターン以降、台帳に行を残していない（再出力なし）。

唯一のヒットの全文（`b822034d` 01:32Z）は「fleet-mail で kim-PC へ依頼を送ってよければ『送って』」＝
**宛先が kim（HP の keyserve 登録・Vercel の Bot トークン設定の依頼）**であり、本 handoff の「社内スタッフ宛の連絡」ではない。

## 3. 保留されていた連絡の末路（実物）

| ts (UTC) | セッション | 内容 | 台帳 |
|---|---|---|---|
| 2026-10-22T04:38Z | `41a63819` | `#経理チーム` へ木下真弓さん・アブドゥルラティフ智望さんをメンションし「資金状況の確認をお願いします」と着手合図 | course-corrections / stop-gate / handoff-audit |
| 2026-10-22T05:35Z | `41a63819` | `#経理チーム` へ自動送信 | auto-progress / stop-gate |
| 2026-10-22T06:50Z | `41a63819` | `#経理チーム` の着手合図の受信・自動送信 | auto-progress / course-corrections |

つまり「送らずに待つ」で終わらず、**当日内に実送信まで到達している**。`b822034d` の 01:32Z の保留も
04:38Z の実送信以降 stop-gate の block が出ていない。

## 4. 経路「Discord MCP」の実物検証（このPC = HP / 2026-10-23）

| 確認 | 方法 | 実測 |
|---|---|---|
| MCP 構成 | `~/.claude.json` の `mcpServers` | `gemini-cli` のみ（Discord 無し） |
| MCP ツール | `~/.claude/settings.json` の matcher `mcp__claude_ai_Discord…__(send_dm\|send_message\|reply_message)` | 登録はあるが、ツール自体が無いので**一度も発火しない**（Gmail guard と同じ latent） |
| DM ツール | `node tools/discord-dm.mjs 宮地麻里 --body "…" --dry-run` | 「Discord Bot トークンが見つかりません」→ `{"ok":false,"error":"SEND_FAILED"}` |
| トークン | `resolveDiscordBotToken(os.homedir())` | `false`（env `DISCORD_BOT_TOKEN` も `~/.claude/orgiast-discord-bot-token.txt` も無い） |
| チャンネルID | `node tools/discord-channel-id.mjs 経理チーム --json` | `ENOENT: ~/.claude/fleet-sheet.env`（ローカル台帳へのフォールバック無し） |
| 実送信の実績 | 2026-10-22 の `#経理チーム` | keiri-hub の `/shoyo` 連携（`src/lib/shoyo/discord.ts`・`src/app/api/shoyo/kickoff/route.ts`）で動作。**アプリ専用で汎用の送信口ではない** |

→ このPCで到達可能なのは ①宛先/用件/本文の完成形をチャット表示（規約の既定・送信なし） ②kim 宛なら fleet-mail
（`b822034d` が 2026-10-22 に試作成功を実測） ③keiri-hub アプリ内の Discord 連携（チャンネル投稿・アプリ専用）。

## 5. 恒久策（当ターンで実施）

- `tools/handoff-audit-knowledge.json` に `pattern: 社内スタッフ宛の連絡` の entry を追加し、route を上記の実測に基づく
  **実行可能な手順**へ置き換えた。`mergeKnowledge` は同一 pattern の学習をスキップするため、以後同じ pattern が
  learned されても「存在しない Discord MCP」を経路にした TODO は積まれない。
- route の一意性は `tools/handoff-audit-nightly.test.mjs` の「knowledge.json の route は enqueueTodos と同じ正規化で一意」が検証する（§6）。
- Bot トークンの設置は権限変更にあたるため**実施していない**（既存の承認範囲のみ）。

## 6. テスト

`node --test tools/handoff-audit-nightly.test.mjs` = **18 pass / 0 fail**（route 一意性テストを含む）。
knowledge は 25 → 26 entry。

## 7. 残る穴（未確認を明記）

- MCP 有効環境（claude.ai コネクタ運用）での実発火は**未確認**（このPCでは再現不能）。
- 汎用 DM 送信は Bot トークンが無いため**未検証**。トークンがあれば `tools/discord-dm.mjs` で送れる設計（`tools/discord-dm.test.mjs`）。
- `tools/discord-channel-id.mjs` が `fleet-sheet.env` 不在で ENOENT になるのはローカル台帳フォールバック欠如（バグ候補）。今回は経路記録のみで修正しない。

## 8. B軸（人手・コスト）

- この検証で kim の手作業は 0（読み取りと dry-run のみ）。次セッションが「MCP が無い」ことを知らずに再試行する
  コストを 1 回分消した。
- 恒久の人手削減には Bot トークン 1 つの設置（1 回だけ）が要る。それまでは完成形のチャット表示が既定で、
  kim の手数は「コピペして渡す」1 回に収まる。
