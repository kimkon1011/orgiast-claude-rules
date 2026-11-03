# handoff-audit 検証記録: Vercel 環境変数の登録 × route「vercel env」（2026-10-23）

対象 TODO: `[handoff-audit:d8f654e5431abcab] Vercel 環境変数の登録 — この handoff が再発していないかを実物で検証し結果を記録する（再発防止の経路: vercel env）`

id は `sha256(JSON.stringify([NFKC(pattern), NFKC(route)])).slice(0, 16)` で再計算し一致を確認した
（`tools/handoff-audit-nightly.mjs` の `key`/`hash` と同一式・実測 `Vercel 環境変数の登録` × `vercel env` = `d8f654e5431abcab`）。

## 結論（3点）

1. **再発 0。** 原文検出（2026-10-21T18:02:03.431Z / `4d7e4383`）以降の 6 台帳 584 行に、
   「Vercel の環境変数登録を kim / user の設定に手渡す」記述は無い（§2）。`Vercel` を含む 46 行はすべて
   ①Claude 自身が設定する宣言 ②既存 Vercel Cron の説明 ③Claude 側のデプロイ確認で、手渡しではない。
2. **経路「vercel env」はこのPC（HP）で実行できる**（§3）。`vercel` は PATH に無く未ログインだが、
   keiri-hub の `.env.local` の `VERCEL_TOKEN` を渡せば `whoami` = `seisaku-team-5867`、
   `env ls --environment production` = 22 件が読める（いずれも exit 0・読み取りのみ・値は非出力）。
3. ただし knowledge の route は `vercel env` の5語だけで**再現手順が無かった**。次のセッションが同じ調査を
   繰り返さないよう、実測コマンド付きの entry を追加した（§4）。書き込み（`env add`）は設定変更にあたるため
   当セッションでは実行していない（既存の承認範囲を守る）。

## 1. 原文の同定（一次証拠）

`~/.claude/handoff-audit-ledger.jsonl` の 2026-10-21T18:02:03.431Z 行（session `4d7e4383-0676-451a-9c40-1dcc90a7c40c` / verdict=block）:

```
rule 3: 「どちらも、所有者の kim さんの設定が必要です。」
  fix: DWD(kim impersonate) で drive permissions.create（SA を reader 追加）と Vercel API の env 登録を直接試し、結果を書く。試行記録が無いまま『必要』と断定しない
rule 12: 「DM の実送信です。どちらも、所有者の kim さんの設定が必要です。」
learned: {"pattern":"Vercel 環境変数の登録","route":"vercel env","confidence":"high"}
```

同 route の昇格は `~/.claude/handoff-audit-promotions.jsonl` 5 行目（observation `a3ba93d3…`）。
同じ block で learned された「社内スタッフ宛の連絡」（`d149c64e419fb482`）は PR #1004 で検証済み。
なお同 route `vercel env` は別 pattern「本番反映をuserの返信待ちにする」にも付いており（knowledge #24）、
route の一意性テストはこの重複と今回の entry を **別文字列** にして通している（§4）。

## 2. 再発走査（実物・読み取りのみ）

窓 = `2026-10-21T18:02:22.929Z`（当該監査の最終行＝`handoff-audit-nightly-ledger.jsonl` の最終行）より後〜2026-10-23 02:20 JST。
焦点の正規表現 = `Vercel の環境変数|Vercel 環境変数|vercel env|Vercel 側で(設定|登録)|Vercel に(登録|設定)` と
`必要|お願い|してください|できません|未設定|kim` の共起。

| 台帳 | 窓内行数 | 焦点一致 |
|---|---:|---:|
| `handoff-audit-ledger.jsonl` | 217 | 0 |
| `stop-gate-runner-ledger.jsonl` | 74 | 0 |
| `course-corrections-ledger.jsonl` | 226 | 0 |
| `auto-progress-ledger.jsonl` | 66 | 0 |
| `handoff-audit-nightly-ledger.jsonl` | 0（最終行が窓の開始点） | 0 |
| `handoff-audit-deferral-ledger.jsonl` | 1 | 0 |
| **計** | **584** | **0** |

広い語 `Vercel` では 46 行が一致した。全件を分類すると次の3種だけである。

| 分類 | 代表（UTC） | 手渡しか |
|---|---|---|
| Claude 自身が Vercel に設定する宣言 | `b822034d` 2026-10-22 00:29–01:33Z「トークンを受け取ったら、Vercel への Bot トークン設定は私が行い」 | いいえ（Claude 実行） |
| 既存 Vercel Cron の説明 | `41a63819` 2026-10-22 04:34–06:50Z `/api/shikin/remind` の毎日実行 | いいえ |
| Claude 側のデプロイ確認 | `41a63819`「Vercel API で READY（2026-10-22T07:41:44Z, target=production）」 | いいえ |

補助として `~/.claude/next-session.md` / `session-handoffs.md` / `auto-session/runs/*.summary.md` を同じ語で
grep したが、当該 TODO 行と 2026-10-22-6 の「vercel env 経路の実測」以外に一致は無い。
transcript（mtime が窓以降の 15 ファイル・16,186 行）も 15 ヒットすべてが memory / 設計文書の引用か
Claude 側操作（例: `41a63819` の「keiri-hub の Vercel 環境変数17件をAPIで一覧」）で、新規の手渡しは無い。

## 3. 経路「vercel env」の実物検証（このPC = HP / 2026-10-23 02:15–02:25 JST）

| 確認 | 方法 | 実測 |
|---|---|---|
| CLI の所在 | `command -v vercel` | **見つからない**（PATH に無い） |
| キャッシュ | `%LOCALAPPDATA%\npm-cache\_npx\69f9afb961c37556\node_modules\vercel\package.json` | 65.0.0 |
| ログイン状態 | `<cache>/vercel/dist/index.js whoami` | `> Logged out.`（**exit 0**。終了コードでは未ログインを判定できない） |
| 認証 | keiri-hub `/.env.local` の `VERCEL_TOKEN` を env に渡す | `whoami` → `seisaku-team-5867`（exit 0） |
| 変数一覧（読み取り） | `env ls --environment production` | **22 件**・exit 0。`DISCORD_BOT_TOKEN` は含まれない |
| 対象プロジェクト | `keiri-hub/.vercel/project.json` | `projectId=prj_vEaA…` / `orgId=team_0aYx…` / `projectName=keiri-hub` |

- トークンは `~/.vercel` や global login ではなく **プロジェクトの `.env.local`** にある。別プロジェクトでは
  そのリポジトリの `.env.local` を使う。値は一切出力していない。
- 2026-10-22-6 の記録でも同じ経路の成功（`whoami` = seisaku-team-5867 / `env ls production` = 10 件）が
  残っている。件数が 10 → 22 に変わっているのは計数方法または追加分の差で、**未確認**（読み取り成功自体は両日実測）。
- `vercel` を PATH に通す・`vercel login` する操作はしていない（設定変更を避けるため）。

## 4. 恒久策（当ターンで実施）

- `tools/handoff-audit-knowledge.json` に `pattern: Vercel 環境変数の登録` の entry を追加し（25 → 26）、
  route を上記の実測コマンド（キャッシュ path・`VERCEL_TOKEN` の渡し方・`env ls`・`env add` の形・
  「Logged out. は exit 0」）に置き換えた。`mergeKnowledge` は同一 pattern の学習をスキップするため、
  以後同じ pattern が learned されても「vercel env」だけの再現不能な TODO は積まれない。
- 既存 #24「本番反映をuserの返信待ちにする」の route `vercel env` は別 pattern のものなので変更しない
  （route 一意性テストがあるため、今回の route は重複しない文字列にした）。
- 設定変更（`env add` / `env remove`）は既存の承認範囲外なので**実施していない**。

## 5. テスト

`node --test tools/handoff-audit-nightly.test.mjs` = **18 pass / 0 fail**（route 一意性テストを含む）。
knowledge は 25 → 26 entry。

## 6. 残る穴（未確認を明記）

- **書き込み（`vercel env add`）は未実行**。読み取りと書き込みは別判定で、トークンの env 書き込み権限は未確認。
- CLI の実体は npx キャッシュ（ハッシュ付きディレクトリ）なので、キャッシュが消えると path が変わる。
  その場合は `npx vercel@65` で再取得する。
- 他プロジェクト（event-shop 等）には `VERCEL_TOKEN` が無い可能性があり、未確認。

## 7. B軸（人手・コスト）

- この検証で kim の手作業は 0（読み取りと dry-run のみ）。次セッションが「vercel が PATH に無い／未ログイン」を
  知らずに `vercel login` を依頼するコストを 1 回分消した。
- 今後 Vercel の環境変数登録が必要になっても、Claude 側で `env add` まで到達できる設計（書き込みは未実測）。
