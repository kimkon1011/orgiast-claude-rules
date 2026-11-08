# handoff-audit 検証記録: 「内部スタッフ宛DMの送信」× route「チャット表示」（2026-10-25 再検証）

対象 TODO: `[handoff-audit:c91e35b4bc3b7ee2] 内部スタッフ宛DMの送信 — この handoff が再発していないかを実物で検証し結果を記録する（再発防止の経路: チャット表示）`

id は `sha256(JSON.stringify([NFKC(pattern), NFKC(route)])).slice(0, 16)` で再計算し、`内部スタッフ宛DMの送信` × `チャット表示` = `c91e35b4bc3b7ee2` に一致した（`tools/handoff-audit-nightly.mjs` の `key`/`hash` と同じ式）。

送信なし・権限変更なし・kim への DM なし。Discord DM の**実送信はしていない**（dry-run と読み取り照会のみ）。

## 1. 結論

1. **検出後の再発は 0 件。** 窓 = `2026-10-23T18:11:08.951Z`（最後の原文検出）〜`2026-10-24T19:58Z`。
   台帳 13 行・transcript 37 行の計 **50 ヒット**を人手分類し、内部スタッフ宛 DM を user に手渡した記述・
   「DM で送ります」と言って送っていない記述・自アカウント宛の到達を証拠にした記述は **0 件**（§3）。
2. **原文は 2 件。** どちらも同一夜間監査（2026-10-23T18:05:50Z / 18:11:08Z）の別セッション（§2）。
   1 件は「グループ DM に説明付きで送ります」と言って送っていない。もう 1 件は
   `discord-dm.mjs` の起動確認と**持ち主宛の DM 送信**を送信可否の証拠にしていた。
3. **走査ツールの穴を当ターンで塞いだ。** 既存の `tools/handoff-audit-discord-dm-premise-scan.mjs` は
   原文 3 文を **1 つも検出できなかった**（実測: すべて `false`）。修飾語入りの「DM に説明付きで送ります」と
   自アカウント宛証拠の 2 系統を検出するよう拡張し、原文を対照（P6/P7）に固定した（§5）。
4. **経路は PC で違う。** このPC（作業用011）は Discord Bot トークンが**有効**で、`discord-dm.mjs --dry-run` が
   宛先（宮地麻里 / id 1288790954186375168）を解決した。**トークン不在だった HP とは同じ判定を使えない**（§4）。
   トークンが無い PC ではチャット本文に完成形を表示する（Gmail 下書きにしない）。
5. knowledge に本 pattern の entry を追加した（§5）。同一 pattern の再学習は `mergeKnowledge` が飛ばすため、
   以後同じ指摘で監査 TODO が増えない。

## 2. 原文の同定（一次証拠）

`~/.claude/handoff-audit-nightly-ledger.jsonl`。`learned` に
`{"pattern":"内部スタッフ宛DMの送信","route":"チャット表示","confidence":"high"}` を持つ行は全期間で 2 行。

| 検出行 | session | rule | 引用 |
|---|---|---|---|
| 2026-10-23T18:05:50.309Z | `0c1269c9` | 2 | 「送信: 撤収の流れと一緒に、白川さん・大平さん・澤山さんのグループ DM に説明付きで送ります。」 |
| 2026-10-23T18:11:08.951Z | `bc7b1727` | 3 | 「実際の送信は、同じ部品を使う持ち主宛ての DM 送信で行いました。」 |
| 同上 | 同上 | 4 | 「本番に置かれた `tools/discord-dm.mjs` を実行し、起動することを確かめました。」 |

nightly が付けた fix は共通して「Discord 送信経路を当ターンで本文付きで実行し、失敗したらチャット本文に
宛先／用件／本文の完成形を表示する」。`~/.claude/handoff-audit-promotions.jsonl` 3 行目にも同内容が残る。

## 3. 再発走査（実物・読み取りのみ）

窓: `2026-10-23T18:11:08.952Z` 〜 `2026-10-24T19:58Z`。走査は
`node tools/handoff-audit-discord-dm-premise-scan.mjs --since 2026-10-23T18:11:08.952Z --json`。

| 出所 | ヒット | 分類 |
|---|---:|---|
| ledger（`handoff-audit` / `stop-gate-runner` / `course-corrections`） | 13 | すべて session `4df3dc55`（10-24 05:31–06:15Z） |
| transcript | 37 | 同セッション 10 行＋記憶の索引行 21 行＋澤田さん DM 規約 6 行 |
| next-session.md / session-handoffs.md / auto-session の summary | 0 | — |
| **計** | **50** | **再発 0** |

人手分類（非再発の根拠）:

| 実物 | なぜ再発ではないか |
|---|---|
| `4df3dc55` の 23 行（ledger 13 + transcript 10） | 経理の木下さんへ **bot から実際に DM を送り、届いたことを確認**した報告と、社内連絡に金功勇を必ず入れるルール（PR #1062）の説明。`4df3dc55` は 2026-10-24T18:04:04Z の夜間監査でも `pass` |
| transcript の `アイミツ＋seisaku-team@ 返信案→kim DM承認→送信ループの前提` 21 行 | memory の**索引タイトル**。外部（顧客）返信ループの既存経路の記述で、内部スタッフ宛の手渡しではない |
| transcript の澤田さん 6 行 | 「倉庫の物理作業は Claude が澤田さんへ bot DM で依頼する」という**手渡し禁止**の規約。向きが逆 |

補助: `~/.claude/handoff-audit-nightly-ledger.jsonl` の 2026-10-24T18:03–18:06Z（9 行）は
`audit-unavailable`（`timeout-or-provider-unavailable`）7 行・`pass` 1 行・別 pattern の `block` 1 行で、
本 pattern の再検出は 0。**監査不能 7 行は「異常なし」の証拠にしない**（検出機会が無かっただけ）。

## 4. 経路の実測（このPC = hostname `作業用011` / 2026-10-25 04:50–05:00 JST）

| 確認 | 実行 | 実測 |
|---|---|---|
| トークン解決 | `resolveDiscordBotToken(homedir())`（`tools/notify-kim.mjs`） | **true / 72 文字**。`~/.claude/orgiast-discord-bot-token.txt`（73 bytes, 2026-10-09） |
| トークンの有効性 | `GET https://discord.com/api/v10/users/@me`（読み取りのみ） | **200** / bot `ClaudeInboxBridge`（id 1508433902518141008） |
| 宛先解決＋本文生成 | `node tools/discord-dm.mjs 宮地麻里 --body "dry-run 検証（送信しません）" --dry-run --no-copy-kim` | `{"dryRun":true,"recipient":{"id":"1288790954186375168","label":"宮地麻里（水木返信遅れます）"}...}` / exit 0。**送信していない**（`--dry-run` はトークン取得より前に return する） |
| 内部宛 Gmail を止める | `node tools/gmail-draft.mjs --to keiri.orgiast@gmail.com --subject テスト --body テスト本文 --dry-run` | `宛先：…／用件：…／本文：…` を表示して **exit 3**。下書きは作らない |
| 走査ツールの対照 | `node tools/handoff-audit-discord-dm-premise-scan.mjs --selftest` | 16/16 pass（拡張後） |

- **HP（別PC）では Bot トークンが無く `SEND_FAILED`** だった（`docs/handoff-audit-findings-discord-dm-premise-60e9dd3b.md`）。
  「Discord DM は使えない」を全PC共通の前提にしない。逆に、このPCで有効なことを他PCの証明にもしない。
- 実送信は既存の承認範囲と本セッションの規約（外部送信なし）に従い**未実行**。送信可否の最終確認は
  「トークン有効＋宛先解決」までで、実際の配送は未検証。

## 5. 恒久策（当ターンで実施）

1. `tools/handoff-audit-discord-dm-premise-scan.mjs` を拡張した。
   - `DM_DELIVERY` が DM と送信語の間に最大 16 字（句点まで）の修飾を許すようにし、
     「グループ DM に説明付きで送ります」（原文 rule 2）を検出。
   - `SELF_SEND_PROOF` を追加し、「持ち主／自分／自アカウント宛ての DM 送信」を
     送信可否の証拠にした行（原文 rule 3）を検出。
   - `INTERNAL` に社内メンバー名（白川・大平・澤山・澤田・百瀬）を追加。
   - 対照を P6（原文 rule 2）・P7（原文 rule 3）・N8・N9 に追加（12 → 16 件）。
2. `tools/handoff-audit-discord-dm-premise-scan.test.mjs` に原文 2 文の回帰テストを追加。
3. `tools/handoff-audit-knowledge.json` に pattern `内部スタッフ宛DMの送信` の entry を追加（30 → 31）。
   route は「Claude が `tools/discord-dm.mjs` で送る／トークンは PC ごとに有無が違う／無い PC はチャット表示／
   `--help`・起動確認・自アカウント宛は証拠にならない／再発走査コマンド」を実測付きで記録。

## 6. テスト

- `node tools/handoff-audit-discord-dm-premise-scan.mjs --selftest` = **16/16 pass**
- `node --test tools/handoff-audit-discord-dm-premise-scan.test.mjs` = **8 pass / 0 fail**
- `node --test tools/handoff-audit-nightly.test.mjs`（knowledge の route 一意性を含む）= **21 pass / 0 fail**

## 7. 残る穴（未確認を明記）

- **原文 rule 4（`discord-dm.mjs` の起動確認を送信可否の証拠にする）は本スキャナでは検出しない。**
  行に `tools/discord-dm` が含まれると経路説明として除外する設計のため。rule 4 側の監査
  （nightly の violations）が拾う前提で、本スキャナの対象外と割り切った。**同じ穴を塞ぐなら別判定が要る**。
- スキャナは **1 行単位**。`アイミツ…` の索引行のように「DM 承認」の語を含むだけの行が 21 件出る（偽陽性）。
  ヒット 0 を再発 0 と読み替えないために、毎回人手分類が要る。
- 窓内の transcript はこのPC（作業用011）の `~/.claude/projects` 等のみ。他PC・10-23 以前は走査していない。
- 夜間監査 9 行のうち 7 行は `audit-unavailable`。**再発機会が無かった区間が含まれる**。

## 8. 次に kim がすること

なし（読み取り・dry-run・テスト・記録のみ。送信・権限変更はしていない）。
