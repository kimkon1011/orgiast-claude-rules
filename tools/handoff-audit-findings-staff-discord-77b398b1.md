# handoff-audit 検証記録: `77b398b1191410e1`（社内スタッフへの確認依頼を Discord で送る）の再発検証（2026-10-21）

対象 TODO: `[handoff-audit:77b398b1191410e1] 社内スタッフ（澤山さん等）への確認依頼を Discord で送る — この handoff が再発していないかを実物で検証し結果を記録する（再発防止の経路: チャットに本文）`（`~/.claude/next-session.md`）。

ID は `handoff-audit-nightly.enqueueTodos` の `sha256([pattern, route]).slice(0,16)`。`pattern=社内スタッフ（澤山さん等）への確認依頼を Discord で送る` / `route=チャットに本文` で再計算し **`77b398b1191410e1` と一致**することを確認（衝突・別項目ではない）。

送信なし・権限変更なし・kim への DM なし。既存の承認範囲のみ。

## 結論

1. **昇格後の再発は無い。** 昇格時刻 `2026-10-20T18:02:02.048Z` 以降、5 台帳を全走査して該当パターンの違反・引用は **0 件**
   （`handoff-audit-nightly-ledger.jsonl` の 1 件は昇格元の行そのもの）。transcript 側の 54 ヒットは全て
   プロンプト注入（`queue-operation` / `api-request-blob` に next-session の TODO 行が入ったもの）で、**assistant の発話ではない**。
2. **経路は「チャットに本文」より強い形（Claude が Discord DM を送る）に置き換わっており、実送信が動いている。**
   `C:\Users\kimko\.claude\CLAUDE.md` §1.1 に「社内メンバーへの連絡は Discord DM で送る（tools/discord-dm.mjs）」が明記され、
   実測で `node tools/discord-dm.mjs "澤山 佳史" --body-file …` が 2026-10-19T12:40Z と 2026-10-20T07:23Z に実行され、
   昇格後も 2026-10-20T22:15:50Z に `金功勇` 宛の DM 送信が実行されている（＝「kim に送らせる」形に戻っていない）。
3. **検出器側の欠陥を 1 件発見（今回は未修正）。** 昇格は `~/.claude/handoff-audit-promotions.jsonl` に残っているが、
   正本 `tools/handoff-audit-knowledge.json` に該当エントリが無い。原因は `handoff-audit-nightly.mjs:139` が
   **nightly-repo の作業ツリーの knowledge.json へ書き戻す**一方、`nightly-bootstrap.ps1` が `git reset --hard origin/main` で
   毎回捨てるため（同ファイルは 2026-10-21 時点で 23 件・`社内スタッフ（澤山` 0 件）。以後の夜間監査は同じ違反を「初出」として
   再学習する。恒久策は knowledge の保存先を `~/.claude/` 配下へ変える（または昇格時に repo へ PR を出す）こと。

## 1. 出典（一次証拠）

`~/.claude/handoff-audit-nightly-ledger.jsonl`:

```
ts: 2026-10-20T18:02:02.048Z
sessionId: a959e661-fd32-4e90-a3a0-df82b182be8f
verdict: block
violations: 「澤山さんにDiscordで確認を依頼済みです」(rule 2) /
            「…見積のPDF化と送付をDiscordで依頼済みです。」(rule 2) /
            「手順: 1. 澤山さんとのDiscordグループDMに「値引きOK」か…」(rule 5)
learned:   社内スタッフ（澤山さん等）への確認依頼を Discord で送る / チャットに本文 / confidence high
```

## 2. 再発の有無（実物の台帳を全走査）

`2026-10-20T18:02:02.048Z` 以降の行を対象に、`澤山|社内スタッフ|社内メンバー|Discord.*(依頼|送)|依頼済み` で走査（2026-10-21 JST）:

| 台帳 | hits / total |
|---|---|
| `handoff-audit-ledger.jsonl` | 0 / 1395 |
| `stop-gate-runner-ledger.jsonl` | 0 / 950 |
| `handoff-audit-nightly-ledger.jsonl` | 1 / 26（昇格元の同一行のみ） |
| `course-corrections-ledger.jsonl` | 0 / 1428 |
| `auto-progress-ledger.jsonl` | 0 / 281 |

transcript（`projects` / `projects-archive` / `cheap-code-worker/projects` / `auto-progress-inbox`、mtime が昇格後の 484 ファイル）:
`依頼済み|送ってください|送ってもら|手動で送|送信してください` を含む行は 54 件だが、内訳は
1 セッション 12 件（本検証セッションのプロンプト）＋ 14 セッション × 3 件（`queue-operation` / `api-request-blob` の
プロンプト注入）。**assistant が「kim が送る」と書いた行は 0 件。**

## 3. 経路の実測（置き換わった形が動いている）

| 日時 (Z) | 実測 |
|---|---|
| 2026-10-19T12:40:04Z | `node tools/discord-dm.mjs "澤山 佳史" --body-file …` |
| 2026-10-20T07:23:34Z | 同上（`澤山　佳史` 表記ゆれ）→ 名簿解決 OK |
| 2026-10-20T22:15:50Z | `node tools/discord-dm.mjs 金功勇 --body "【W2 看板宝屋…】"`（昇格後） |

`tools/discord-dm.mjs` は nightly-repo / orgiast-claude-rules の両配布先に存在（4,251 bytes・2026-10-17 同期）。

## 4. 未実施・範囲外

- knowledge.json の保存先修正（§結論3）は本項目が「検証のみ」のため未着手。次に触る人が 1 行で直せるよう
  `handoff-audit-nightly.mjs:117` の `knowledgeFile` 既定を `path.join(home, '.claude', 'handoff-audit-knowledge.json')`
  にし、無ければ repo コピーから seed する形を推奨。
- 2026-10-20T18:02Z の違反セッション（`a959e661`）が実際に澤山さんへ送ったかは、この検証の対象外（会話は久野商事/坂口の件で、
  別 TODO 側で扱う）。
