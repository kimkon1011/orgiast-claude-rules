# handoff-audit 検証記録: Vercel 本番環境変数の未登録 × route「vercel env」（2026-10-25 再検証）

対象 TODO: `[handoff-audit:2e213995389b814a] Vercel 本番環境変数の未登録を kim の返信待ちにする`
前回監査: `docs/handoff-audit-2026-10-23-vercel-env.md`（`handoff-audit:d8f654e5431abcab`。同じ route・別 pattern）

id は `sha256(JSON.stringify([NFKC(pattern), NFKC(route)])).slice(0, 16)` で再計算し一致を確認した
（pattern `Vercel 本番環境変数の未登録を kim の返信待ちにする` × route `vercel env` = `2e213995389b814a`）。

## 1. 結論

1. **再発 0。** 原文検出（2026-10-23T18:02:27.139Z / session `b822034d`）より後の台帳 66 行・transcript 954 行に、
   「Vercel の環境変数登録を kim / user の設定に手渡す」記述は無い（§2）。
2. **経路「vercel env」はこのPC（HP）で実行できる**（§3）。`vercel` は PATH に無いが npx キャッシュの 65.2.0 に
   `VERCEL_TOKEN`（keiri-hub の `.env.local`）を渡すと `whoami` = `seisaku-team-5867`、`env ls --environment production`
   = 22 件（いずれも exit 0・読み取りのみ・値は非出力）。
3. **本番変数は依然として未登録**（`DISCORD_BOT_TOKEN` / `SHOYO_DM_TEST_USER_ID`）。ただし登録コマンドは
   Claude 側にあり、未登録であること自体は再発ではない。**登録（`env add`）は設定変更なので今回も実行していない**。
4. knowledge に本 pattern の entry を追加した（§4）。前回 entry #21 は同じ route の別 pattern で、
   本 pattern は未記録だったため、nightly の学習が同じ調査を繰り返さないよう実測コマンド付きで残した。

## 2. 再発走査（実物・読み取りのみ）

窓 = `2026-10-23T18:02:54.775Z`（`handoff-audit-nightly-ledger.jsonl` の最終行＝原文検出を出した夜間監査の終端）より後
〜2026-10-25T00:52Z。焦点の正規表現 = `Vercel の?環境変数 | vercel env | Vercel 側で(設定|登録) | Vercel に(登録|設定)` と
`必要|お願い|してください|できません|未設定|未登録|kim|返信待ち` の共起。

| 台帳 | 窓内行数 | 焦点一致 | 広い語 `Vercel` |
|---|---:|---:|---:|
| `handoff-audit-ledger.jsonl` | 32 | 0 | 0 |
| `stop-gate-runner-ledger.jsonl` | 0 | 0 | 0 |
| `course-corrections-ledger.jsonl` | 32 | 0 | 0 |
| `auto-progress-ledger.jsonl` | 0 | 0 | 0 |
| `handoff-audit-nightly-ledger.jsonl` | 1 | 0 | 0 |
| `handoff-audit-deferral-ledger.jsonl` | 1 | 0 | 0 |
| **計** | **66** | **0** | **0** |

transcript（mtime が窓以降の 6 ファイル・954 行）は焦点一致 35 行あったが、内訳は次の3種だけ。

| ファイル（session） | 時刻（UTC） | 内容 | 手渡しか |
|---|---|---|---|
| `532ab831` | 2026-10-23 18:10–18:15 | 原文セッションの継続。`whoami`・API で Vercel 変数を実測し、**残る停止点は Bot トークン「値」の受け渡し（secret / rule 3）**、登録と再デプロイは `scripts/set-shoyo-discord-token.mjs` で Claude が実行できると結論 | いいえ |
| `120001a1` | 2026-10-24 15:49 | 本日先行セッションが next-session と既存 docs を読んだ履歴 | いいえ |
| `a1bf3680` | 2026-10-24 15:49– | 本監査セッション自身の走査ログ | いいえ |

`436bd0cb`（一時 e2e）はプロンプト中の TODO 文字列のみ、`186f70e4` / `6cbfa367` は一致 0。
補助として `next-session.md`（1 件＝本 TODO 行、1 件＝通知本文が「Vercel Cron」と「kim」を含むだけ）／
`session-handoffs.md`（0）／窓以降の `auto-session/runs/*.summary.md`（2 ファイル 32 行・0）を確認した。
repo 内の既存 route 文書（`docs/production-deploy-claude-side-route.md` 等）は規約・実測の記録で、新しい手渡しではない。

## 3. 経路「vercel env」の実物検証（HP / 2026-10-25 00:45–00:52 JST）

| 確認 | 方法 | 実測 |
|---|---|---|
| CLI の所在 | `command -v vercel` | **見つからない**（PATH に無い） |
| キャッシュ | `%LOCALAPPDATA%\npm-cache\_npx\69f9afb961c37556\node_modules\vercel\package.json` | 65.2.0 |
| ログイン | `vercel whoami`（トークンなし） | 過去実測 `Logged out.`（**exit 0**。終了コードで判定しない） |
| 認証 | keiri-hub `/.env.local` の `VERCEL_TOKEN` を env に渡す | `seisaku-team-5867`（exit 0） |
| 変数一覧（読み取り） | `env ls --environment production` | **22 件**・exit 0。`DISCORD_BOT_TOKEN` / `SHOYO_DM_TEST_USER_ID` は**含まれない** |
| 登録コマンドの存在 | `env add --help` | `vercel env add name [options]`（exit 0）。**実行はしていない** |
| 対象プロジェクト | `keiri-hub/.vercel/project.json` | `projectId=prj_vEaA…` / `orgId=team_0aYx…` / `projectName=keiri-hub` |
| 登録状態の照会 | `node scripts/set-shoyo-discord-token.mjs --check` | 「どちらも未登録」・GitHub 連携あり・exit 0（スクリプトは `--check` で書き込み前に exit） |

- トークンは global login ではなく **プロジェクトの `.env.local`** にある。値は一切出力していない。
- 22 件は 2026-10-23 の前回監査と同数。増減なし（10-22 の記録が 10 件なのは計数方法または追加分の差で**未確認**）。
- `env add` / `env remove` は設定変更にあたるため、既存の承認範囲を守り**未実行**。

## 4. 恒久策（当ターンで実施）

- `tools/handoff-audit-knowledge.json` に pattern `Vercel 本番環境変数の未登録を kim の返信待ちにする` の entry を追加し、
  route を本節の実測コマンド（キャッシュ path・`VERCEL_TOKEN` の渡し方・`env ls`・`env add` の形・
  「Logged out. は exit 0」・登録は Claude 側で実行し kim に依頼しない）に置き換えた。
  前回 entry #21（pattern `Vercel 環境変数の登録`）は同じ route の別 pattern なので変更しない。
- `mergeKnowledge` は同一 pattern の学習をスキップするため、以後同じ pattern が learned されても
  knowledge には重複 entry を作らない。

## 5. テスト

- `node --test tools/handoff-audit-nightly.test.mjs`（route 一意性テストを含む）で確認する（§実行ログは PR 本文）。

## 6. 残る穴（未確認を明記）

- **書き込み（`vercel env add`）は未実行**。読み取りと書き込みは別判定で、トークンの書き込み権限は未確認。
- **トークン「値」の入手経路は未解決**。event-shop の `DISCORD_BOT_TOKEN` は `type=sensitive` で API から値を
  取り出せない（2026-10-23 実測）。値の提供は rule 3 の正当な手渡し理由（secret）に該当し、
  「登録作業を kim に渡す」こととは別物。
- `enqueueTodos` は `next-session.md` 内の id / route 行だけを見て重複を落とし、knowledge の pattern は見ない
  （`tools/handoff-audit-nightly.mjs:72-89`）。完了行がローテーションで退避されると、同じ pattern 文が再検出された
  ときに同じ TODO が再起票され得る（**コード読解による。実測は未実施**）。knowledge entry は
  `mergeKnowledge` の重複防止と監査プロンプトへの経路提示には効くが、再起票自体は止めない。
- transcript の走査対象はこのPC（HP）の `~/.claude/projects` と cheap-code-worker のみ。他PC・2026-10-23 以前の窓外は
  走査していない。夜間監査も 2026-10-23T18:02Z 以降は未実行のため、以後の台帳行は存在しない。

## 7. B軸（人手・コスト）

- この検証で kim の手作業は 0（読み取りと `--help` のみ）。
- 次セッションが「vercel が PATH に無い／未ログイン」を理由に `vercel login` や登録を依頼するコストを 1 回分消した。
- 登録が必要になった時点で、Claude は `.env.local` のトークンと `env add` で完結できる（書き込みは未実測）。
