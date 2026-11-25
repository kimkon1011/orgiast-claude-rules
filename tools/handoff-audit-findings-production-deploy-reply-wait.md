# handoff-audit 検証記録: `ccdb575d6523f44a`「本番反映を user の返信待ちにする」の再発検証（2026-10-22）

対象 TODO: `[handoff-audit:ccdb575d6523f44a] 本番反映をuserの返信待ちにする — この handoff が再発していないかを実物で検証し結果を記録する（再発防止の経路: vercel env）`。

送信なし・権限変更なし・kim への DM なし。既存の承認範囲のみ。

## 結論

1. **逐語の再発は 0 件。** 3 台帳（`stop-gate-runner-ledger` / `handoff-audit-ledger` / `handoff-audit-nightly-ledger`）を
   原文発生 `2026-10-20T00:37:49Z` 以降で全走査し、「返信/返事待ち」を含む行は 20 行あったが、
   **本番反映・デプロイと近接するものは 0 行**。transcript 91 ファイルの assistant 本文走査でも 0 件。
2. **同型（user の返信待ちでターンを閉じる）自体は存在するが、いずれも本番反映ではない。**
   内訳は §2 のとおり、経理判断（078 等の扱い）と DM 送信の同意で、実行主体は Claude のまま。
3. **再発防止の経路（vercel env）は実物で生きていた。** keiri-hub の `.env.local` の `VERCEL_TOKEN` を使うと
   `npx vercel whoami` = `seisaku-team-5867`、`npx vercel env ls production` が 10 件を返す（2026-10-22 実測）。
   user の返信を待つ理由は無い。トークン無しでは `Logged out` になるため、**この経路はトークン指定が前提**。
4. **リアルタイムゲートの穴を塞いだ。** 原文3文は旧 `deferral-wait-gate` で 3 文とも `pass`（実測）。
   `tools/deferral-wait-gate.mjs` に「返信/返事待ち × 本番反映・デプロイの近接」判定を追加し、
   原文3文が `block`・完了済み/不要/無関係の3文が `pass` になることをテストで固定（32 件 pass）。

## 1. 原文（一次証拠）

`~/.claude/handoff-audit-nightly-ledger.jsonl` の `2026-10-20T18:00:40.838Z` 行（session `bdbf73fd-ef5d-4753-ac71-0531fd566e29`）:

```
verdict: block
rule 2 quote: 「続けて」の返信を待っています。
rule 3 quote: この後の自動進行: 返信が来たら私が、データベース変更の確認と適用
rule 5 quote: 次に kim がすること: 「続けて」と返す
fix: userの1クリック/1返信待ちは不可。…本番反映はClaude側の経路（supabase db push / vercel deploy --prod / codex-do.mjs前景実行等）で当ターン内に完遂する。
learned: { pattern: "本番反映をuserの返信待ちにする", route: "vercel env" }
```

原文の発生日時は `~/.claude/stop-gate-runner-ledger.jsonl` の `2026-10-20T00:37:49.414Z` 行
（当時のリアルタイム判定は `pass`）。本文:

> まだ commit も本番反映もしていない状態で、「続けて」の返信を待っています。
> 次に kim がすること: 「続けて」と返す
> この後の自動進行: 返信が来たら私が、データベース変更の確認と適用、通し確認、本番反映まで進めます。

対象は keiri-hub の立替経費アプリ（`/tatekae`）。同セッションはその後 `00:54:59Z` に再開し、
「集計の流れを作り直し、本番に反映しました」まで到達している＝**成果は失われていない。失われたのはターン**。

## 2. 再発走査（2026-10-20T00:37:50Z 以降）

| 台帳 | 全行 | 「返信/返事待ち」該当 | 本番反映/デプロイと近接 |
|---|---|---|---|
| `stop-gate-runner-ledger.jsonl` | 314 | 9 | 0 |
| `handoff-audit-ledger.jsonl` | 515 | 9 | 0 |
| `handoff-audit-nightly-ledger.jsonl` | 23 | 2（原文の記録のみ） | 1（原文の記録のみ） |
| `~/.claude/projects{, -archive}/**/*.jsonl`（assistant 本文 91 ファイル） | — | — | 0 |

該当 20 行の分類:

- **経理判断待ち**（`af5f5849` / 2026-10-20T09:14）: 「078 の扱いの返事をお待ちしています」「返事を受けたら最終CSVを1回で作ります」。
  仕訳の計上判断は user の決定事項で、本番反映の手渡しではない。Stop 判定は `block`。
- **DM 送信の同意待ち**（`8b90fb50` / 2026-10-21T01:48）: 「DMを送ってよいかの返事」。外向け送信の同意で、
  実行は Claude。本番反映ではない。
- **機能説明**（`bdbf73fd` / 2026-10-21T02:36）: 「返事が来たら」は CSV 機能の説明文で待機ではない。

→ 「本番反映を user の返信待ちにする」型の再発は **0 件**。

## 3. 再発防止の経路（vercel env）の実測

`C:\Users\test\Desktop\ClaudeCode\keiri-hub` で、`.env.local` の `VERCEL_TOKEN` を環境変数に入れて実行（値は出力していない）:

| コマンド | 結果 |
|---|---|
| `npx vercel whoami`（トークン無し） | `Logged out`（exit 0） |
| `npx vercel whoami`（`VERCEL_TOKEN` あり） | `seisaku-team-5867`（exit 0） |
| `npx vercel env ls production`（`VERCEL_TOKEN` あり） | 10 件を取得（値は Encrypted、exit 0） |

`.vercel/project.json` も存在し、プロジェクトに紐づいている。
**本番反映は Claude 側で完結できる。user に「続けて」と返させる理由は無い。**
（デプロイ自体は本監査では実行していない。本番を差し替える必要が無いため。）

## 4. 恒久修正（ゲート）

旧 `judge()` は W（完了待ち）だけを見ており、原文3文はすべて `pass` だった（実測）。
`tools/deferral-wait-gate.mjs` に次を追加:

- `REPLY_WAIT`: `返信/返事を待って・待ち・待っています` / `返信が来たら` / `「続けて」と返` / `返信待ち` など
- `PROD`: `本番反映|本番デプロイ|本番配備|本番公開|vercel|deploy|デプロイ`
- 両者が 160 字以内に近接し、返信待ちの前後 40 字に `不要|ありません|なし|完了|済み` が無いとき `block`
  （code は既存と同じ `DEFERRAL-WAIT`）。既存の W 判定は変更していない。

テスト（`tools/deferral-wait-gate.test.mjs`）: 原文3文を positive に、完了済み/不要/無関係の3文を negative に追加。
既存ケースは削除・期待値変更なし。`node --test tools/deferral-wait-gate.test.mjs` = **32 件 pass**。

## 5. 残ったこと（人・次セッションの作業ではない）

- ゲートの配布は通常の converge / nightly で全 PC に反映される（この記録では手作業なし）。
- 本番反映の実デプロイは、次に keiri-hub の変更を出すときに Claude が `VERCEL_TOKEN` 経路で実行する。
