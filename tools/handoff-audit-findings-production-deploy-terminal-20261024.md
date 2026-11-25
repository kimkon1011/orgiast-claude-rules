# handoff-audit 検証記録: `ce2d358c446f2e49`「本番デプロイを user のターミナル操作に手渡す」の再発検証（2026-10-24）

対象 TODO: `[handoff-audit:ce2d358c446f2e49] 本番デプロイを user のターミナル操作に手渡す — この handoff が再発していないかを実物で検証し結果を記録する（再発防止の経路: Claude 側の認証済み Vercel CLI で完結する）`。

送信なし・権限変更なし・kim への DM なし。既存の承認範囲のみ。本番デプロイは実行していない（差し替える必要が無いため）。

## 結論

1. **前回検証（2026-10-01）以降の再発は 0 件。** transcript 185 ファイル・assistant 本文 1,564 件（2026-10-01T00:00Z 以降）を走査し、
   「本番デプロイ／本番反映」×「ターミナル・コマンド貼り付け・1クリック起爆」×「user への実行依頼」の同時該当は **0 件**。
   3 台帳（`handoff-audit-ledger` 870 行 / `stop-gate-runner-ledger` 417 行 / `handoff-audit-nightly-ledger` 62 行）も **0 件**。
   ※台帳は 2026-10-17 開始のため、10-01〜10-16 は transcript だけで判定した。
2. **Claude 側の経路は実物で生きていた（この PC = hostname `HP`）。** keiri-hub の `VERCEL_TOKEN` を使うと
   `vercel whoami` = `seisaku-team-5867`（exit 0）、`vercel env ls production` = 22 件（exit 0）。トークン無しは `Logged out`（exit 1）。
   **user にコマンドを打たせる理由は無い。**
3. **ゲートの穴を塞いだ。** `user-burden-gate` はコマンド手渡しを止める一方、**デスクトップの1クリック起爆ファイルは
   「手間監査」が揃えば通していた**（2026-09-28 の再発経路そのもの）。本番デプロイに限り、ターミナル手渡しも
   起爆ファイルも `PROD-DEPLOY-HANDOFF` で block するようにした。`node --test tools/user-burden-gate.test.mjs` = **19 件 pass**。

## 1. 原文（この型の履歴）

`docs/production-deploy-claude-side-route.md` の記録より:

- 初回: `handoff-audit:a50af9c008c0c626`（2026-09-25 に Claude 側経路を実測して是正）
- 2026-09-26 `eef7f47a`: チャット1行で user へ手渡した
- 2026-09-28 `a06eaef3`: デスクトップに1クリック起爆ファイルを置き「本番に出してよいならダブルクリック」
- 2026-09-30 `bbd0a4a2`: VSCode TERMINAL に貼るコマンド手順を提示
- 2026-10-01 `4b241a72023c7578`: 上記3件を実物で確認し、route を「同意はチャット1回、実行は Claude」に是正

本 TODO（`ce2d358c446f2e49`）は、この是正後の再発を継続監視する項目。

## 2. 再発走査（2026-10-01T00:00Z 〜 2026-10-24）

| 対象 | 件数 | 該当 |
|---|---|---|
| `~/.claude/projects` + `projects-archive` + `cheap-code-worker/projects` の assistant 本文（2026-10-01 以降） | 185 ファイル / 1,564 メッセージ | **0** |
| `handoff-audit-ledger.jsonl` | 870 行 | **0** |
| `stop-gate-runner-ledger.jsonl` | 417 行 | **0** |
| `handoff-audit-nightly-ledger.jsonl` | 62 行 | **0** |
| デスクトップのデプロイ用起爆ファイル | `*.cmd` / `*.ps1` 3 件（Codex ログイン・Node 更新・freee 再認証） | **0**（名前にデプロイ／本番を含むものなし） |

判定語:
- デプロイ: `本番(デプロイ|反映|公開|配備|に出す)` / `vercel deploy` / `deploy --prod`
- user 操作: `ターミナル|TERMINAL|コマンドプロンプト|PowerShell|コマンドを貼|打ち込|ダブルクリック|起爆`
- 依頼: `してください|お願いします|貼って|打って|実行して|ダブルクリック`

走査スクリプトは本監査では一時ファイル（`~/.claude/auto-session/runs/2026-10-24-2/scan-deploy-handoff.mjs`）で実行し、リポジトリには入れていない。
台帳の `verdict=pass` は再発 0 の根拠にしていない（原文 §「台帳はこの型を検知していない」）。transcript の本文走査を一次根拠にした。

## 3. 再発防止の経路の実測（hostname `HP`）

`C:\Users\test\Desktop\ClaudeCode\keiri-hub` で、`.env.local` の `VERCEL_TOKEN` を子プロセスの環境変数にだけ渡して実行（値は出力していない）:

| コマンド | 結果 |
|---|---|
| `npx --no-install vercel whoami`（トークン無し） | `Logged out`（exit 1） |
| `npx --no-install vercel whoami`（トークンあり） | `seisaku-team-5867`（exit 0） |
| `npx --no-install vercel env ls production`（トークンあり） | 22 件（値は Encrypted、exit 0） |

`.vercel/project.json` も存在し、keiri-hub に紐づいている。したがって本番反映は Claude 側で完結できる。
デプロイ自体は本監査では実行していない（本番を差し替える必要が無いため）。反映確認は
`vercel inspect <本番URL>` の id/created とエイリアス先で行う（CLI は BLOCKED でも exit 0 に見える）。

## 4. 恒久修正（ゲート）

`tools/user-burden-gate.mjs` に `PROD-DEPLOY-HANDOFF` を追加:

- 対象: 本番デプロイのコマンド（`vercel ... --prod` / `deploy --prod`）、本番デプロイを指す起爆ファイル、
  「本番反映を実行してください」のような直接依頼。
- 手順・手間監査が揃っていても block（手順の完全さは手渡しの正当化理由にならない）。
- 脱出は `[PROD-DEPLOY-HANDOFF-OK] <user の文言の引用>` のみ（user が自分で実行すると明示した場合）。
- 文面は「Claude 側で `npx vercel deploy --prod --yes` → `vercel inspect` で確認。同意はチャット1回、実行は Claude」。

テスト（`tools/user-burden-gate.test.mjs`）に 4 件追加:
ターミナル手渡し / 1クリック起爆ファイル / コマンド無しの直接依頼 / 実行済み報告と明示的希望の除外。
既存 15 件は削除・期待値変更なし。**19 件 pass**。

## 5. 残ったこと（人・次セッションの作業ではない）

- ゲートの配布は通常の converge / nightly で全 PC に反映される（この記録では手作業なし）。
- `stop-gate-runner.test.mjs` の「自動進行の起床手段」テストは origin/main の時点で 1 件 fail（本変更と無関係。baseline でも再現）。
- 実際のデプロイは、次に keiri-hub / event-shop の変更を出すときに Claude が `VERCEL_TOKEN` 経路で実行する。
