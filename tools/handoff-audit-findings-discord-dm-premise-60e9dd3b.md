# handoff-audit 検証記録: `60e9dd3bf0e3453e`「Discord DM 送信を前提にした社内連絡」の再発検証（2026-10-25）

対象 TODO: `[handoff-audit:60e9dd3bf0e3453e] Discord DM 送信を前提にした社内連絡 — この handoff が再発していないかを実物で検証し結果を記録する（再発防止の経路: チャット表示）`。

id は `sha256(JSON.stringify([NFKC(pattern), NFKC(route)])).slice(0, 16)` で再計算し、`Discord DM 送信を前提にした社内連絡` × `チャット表示` = `60e9dd3bf0e3453e` に一致した（`tools/handoff-audit-nightly.mjs` の `key`/`hash` と同じ式）。

送信なし・権限変更なし・kim への DM なし。既存の承認範囲のみ。Discord DM の実送信はしていない（dry-run もトークン不在で失敗した）。

## 結論

1. **検出後の再発は 0 件。** 窓 = `2026-10-23T18:02:27Z`（原文検出）〜`2026-10-25T00:36Z`。
   8 台帳の窓内行は **6 行**（すべて同一夜間実行の `18:02:27`〜`18:02:54Z`。`handoff-audit-ledger` / `stop-gate-runner-ledger` / `course-corrections-ledger` / `auto-progress-ledger` は **0 行**）。
   transcript は **5 ファイル / 9 メッセージ**。走査ツールのヒットは **0 件**（§2）。
2. **ただし「測った 0」であり、再発機会が乏しい区間だった。** `18:02:54Z` 以降、台帳への新しい書き込みは無い。窓内の transcript は 5 ファイルすべてヘッドレス自動セッションで、内容は `18:10Z` の `/shoyo` 賞与フロー確認（アプリ機能の説明）だった（§3）。
3. **原文は 1 件だけ。** `handoff-audit-nightly-ledger.jsonl` の `2026-10-23T18:02:27.139Z`（session `b822034d` / rule 7）「古川さんにも本人宛に PDF を DM で送ります。」。
   `learned` が `{pattern:"Discord DM 送信を前提にした社内連絡", route:"チャット表示", confidence:"high"}`。`handoff-audit-promotions.jsonl` 9 行目に同内容が残る。
4. **再発防止の経路「チャット表示」は実物で動いた。** 内部宛の Gmail 下書きは
   `tools/gmail-draft.mjs` が**通信前に**チャット形式（宛先／用件／本文）を出して `exit 3`。Discord DM は Bot トークン不在で `SEND_FAILED`（§4）。
5. **恒久策を2つ入れた。** ① `handoff-audit-knowledge.json` に pattern の route を記録（nightly の自動学習は毎晩 `reset --hard` で消えるため、main に置く）。② 再発を同じ判定で数える `tools/handoff-audit-discord-dm-premise-scan.mjs`（＋ test、§5）。

## 1. 原文の同定（一次証拠）

`~/.claude/handoff-audit-nightly-ledger.jsonl` 2026-10-23T18:02:27.139Z 行（verdict=block）:

```
rule 7: 「古川さんにも本人宛に PDF を DM で送ります。」
fix:    本人宛 DM は内部連絡。Discord 経路は tools/discord-dm.mjs が現状 SEND_FAILED（トークン不在）なので、
        チャット本文に宛先/用件/本文を完成形で表示する形にし、Gmail 下書きにしない。
learned: {"pattern":"Discord DM 送信を前提にした社内連絡","route":"チャット表示","confidence":"high"}
```

同夜間実行の `18:02:36Z` 行にも同型がある（rule 7「#経理チームへ…を送ります」。fix は「内部宛連絡は Discord DM で Claude が送る。送れない場合はチャット本文に宛先／用件／本文をコピペ可能な完成形で表示」）。
この行の `learned` は `社内スタッフ(#経理チーム 等)宛の通知送信を許可取りのまま止める` × `チャット表示` で **medium** のため TODO 化されず、`~/.claude/handoff-audit-candidates.jsonl` 3 行目に候補として残っている（再発したら high へ昇格する設計）。

## 2. 再発走査（実物・読み取りのみ）

窓: `2026-10-23T18:02:27Z` 〜 `2026-10-25T00:36Z`。

| 台帳 | 全行 | 窓内行 | うち原文と別ターン |
|---|---:|---:|---:|
| `handoff-audit-ledger.jsonl` | 887 | 0 | 0 |
| `stop-gate-runner-ledger.jsonl` | 418 | 0 | 0 |
| `course-corrections-ledger.jsonl` | 931 | 0 | 0 |
| `auto-progress-ledger.jsonl` | 261 | 0 | 0 |
| `handoff-audit-nightly-ledger.jsonl` | 71 | 4 | 0（同一夜間実行） |
| `handoff-audit-deferral-ledger.jsonl` | 16 | 1 | 0（同一夜間実行） |
| `handoff-audit-promotions.jsonl` | 9 | 1 | 0（昇格記録そのもの） |
| `handoff-audit-candidates.jsonl` | 3 | 0 | 0 |

- transcript: `~/.claude/projects`・`projects-archive`・`cheap-code-worker/projects` のうち mtime が窓以降の **5 ファイル / 9 メッセージ**。
- `next-session.md` / `session-handoffs.md` / `auto-session/runs/*.summary.md` も走査（ヒット 0）。

走査結果は `node tools/handoff-audit-discord-dm-premise-scan.mjs --since 2026-10-23T18:02:27Z` = **0 件**（`ledger:0 / next-session.md:0 / session-handoffs.md:0 / summary:0 / transcript:0`）。

### 人手分類した非再発ヒット（4 件）

| 実物 | なぜ再発ではないか |
|---|---|
| `handoff-audit-nightly-ledger` 18:02:36Z 行 | 同一セッション・同一ターンの夜間監査行。fix 文がチャット表示を**説明**している |
| `handoff-audit-promotions` 18:02:27Z 行 | この TODO を生成した昇格記録そのもの |
| `next-session.md` 22 行目 | 古い「通知の原因調査・修復」TODOが、検出前の「DM で送ってよければ『送って』」を引用しているだけ。新しいターンではない |
| transcript 18:10Z の 2 行 | keiri-hub `/shoyo` の**アプリ内蔵機能**「社員へ PDF を DM で送付」の説明・確認報告。手渡しではない |

## 3. 窓の性質（0 件を過大評価しない）

- 台帳の最終書き込みは `2026-10-23T18:02:54Z`。以降 `2026-10-25T00:36Z` まで新しい行が無い。
- 窓内 transcript 5 ファイルはすべて `cheap-code-worker`（ヘッドレス自動セッション）。`~/.claude/projects` の最終更新は 2026-10-24 00:49 JST（= 検出前）。
- したがって「会話セッションで同型を出さなかった」ことの証拠は、この区間については **ヘッドレス 4 メッセージ分**に限られる。次に通常セッションが動いた時に再走査する。

## 4. 経路「チャット表示」の実測（このPC = hostname `HP` / 2026-10-25）

| 確認 | 実行 | 実測 |
|---|---|---|
| 内部宛 Gmail を止めてチャット表示に落とす | `node tools/gmail-draft.mjs --to keiri.orgiast@gmail.com --subject テスト --body テスト本文 --dry-run` | `宛先：keiri.orgiast@gmail.com / 用件：テスト / 本文：テスト本文` を表示し **exit 3**。下書きは作らない（通信前に guard が止める） |
| Discord DM の実送信可否 | `node tools/discord-dm.mjs 宮地麻里 --body "…dry-run…" --dry-run --no-copy-kim` | `Discord Bot トークンが見つかりません` / `{"ok":false,"error":"SEND_FAILED"}` / exit 1 |
| Bot トークンの有無 | `resolveDiscordBotToken(os.homedir())` | `false`（env も `~/.claude/orgiast-discord-bot-token.txt` も無い） |
| guard の回帰 | `node --test tools/internal-recipient-gmail-guard.test.mjs tools/gmail-draft.test.mjs` | **52 pass / 0 fail** |

→ 内部連絡の既定経路は「宛先／用件／本文をチャット本文に完成形で表示」。Gmail 下書きは外部宛のみ。Discord DM はトークン設置まで使えない。

## 5. 恒久策（当ターンで実施）

1. `tools/handoff-audit-knowledge.json` に entry を追加（27 → 28）。
   pattern `Discord DM 送信を前提にした社内連絡` / route に上記の実測（DM 不可・チャット表示・Gmail guard・再発走査ツール）を記録。
   `mergeKnowledge` は **pattern 一致で再学習をスキップ**するため、以後同じ pattern が learned されても TODO が増えない。
   nightly の自動書き込みは `nightly-bootstrap` の `reset --hard` で消える（`docs/permanent-fix-design-only-handoff-route.md` §9.3）。main に置くことで翌晩以降も残る。
2. `tools/handoff-audit-discord-dm-premise-scan.mjs`（読み取り専用・ネットワークなし）
   - 判定は 1 行単位で「DM への言及」「DM を送付経路にする語」「内部宛の文脈」の同時該当から、
     完了・経路説明・実測・規約・監査 TODO 自身・アプリ機能の説明を除外。
   - `--selftest` に陽性 5・陰性 7 の対照を固定。CLI は `--since` / `--json`。
   - テスト `tools/handoff-audit-discord-dm-premise-scan.test.mjs` = **7 pass / 0 fail**。
   - `tools/handoff-audit-nightly.test.mjs`（route 一意性を含む）= **19 pass / 0 fail**。

## 6. 限界・未確認（断定しない）

- **Discord DM の実送信は未検証。** Bot トークンが無いため、トークン設置後に `tools/discord-dm.mjs` で試す必要がある（今回は dry-run が `SEND_FAILED`）。
- 走査ツールは **1 行単位**。`next-session.md` 22 行目のように複数の通知を「・」で連結した長い行は、行内にアプリ機能語（`keiri-hub` 等）があると行全体が除外され、**取りこぼす**。今回その行は検出前の引用なので再発判定には影響しないが、次回以降は人手で確認する。
- 窓内に通常の会話セッションがほぼ無い（§3）。「0 件」は測った範囲の事実であって、同型が今後出ないことの証明ではない。
- `handoff-audit-candidates.jsonl` に同型の **medium** 候補が 1 件残る（`外部送信を伴うテスト実行の可否を user に確認依頼` × `チャット表示`）。high ではないので TODO 化していない。

## 7. 次に kim がすること

なし（読み取り・テスト・記録のみ。送信・権限変更はしていない）。
