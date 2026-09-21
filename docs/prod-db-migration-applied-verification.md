# 「本番DBのmigration適用確認」handoff の監査（2026-09-22 実測）

対象 TODO: `[handoff-audit:d31ae1b6e59f49ce]` 本番DBのmigration適用確認（経路として `codex-do.mjs` が記録されていた）
対象リポ: `kimkon1011/aujust-sales-automation`（aujust 営業アプリ）/ 本番 Supabase ref `nspxlrptbrhapvasejuf`
結論: **適用状況は Claude 側の読み取り専用 probe で確定できる。`codex-do.mjs` は実装の受け皿であって調査の経路ではない。**
実測の結果、**未適用は 0065 / 0066 / 0068 / 0070 の4本**、**0067 は適用済み**、そして
**自動適用の仕組み（`db-migrate.yml` + `scripts/apply-migrations.ts`）は一度も成功していない**ことが確定した。

> 本記録は読み取り専用の検証のみ。**DDL/DML は一切発行していない**（本番DBへの書き込み・migration適用は既存承認範囲の外）。

---

## 1. この pattern の出所

`~/.claude/next-session.md` の該当行:

```
34. [handoff-audit:d31ae1b6e59f49ce] 本番DBのmigration適用確認: codex-do.mjs を既存権限で調査・検証し結果を記録する。
35. [handoff-audit:34f15f1d2612d566] migration適用の委譲: codex-do.mjs を既存権限で調査・検証し結果を記録する。
```

同 route（`codex-do.mjs`）は `tools/automation-routes.json` の `CLI` グループから
`handoff-audit-gate.mjs` がそのまま引用した**道具名**であり、再発防止の手順ではない。
実際に必要な作業は「本番DBに照会して適用済み/未適用を確定し、記録する」であり、
**照会は Claude 側の HTTP probe で完結する**（§2）。`codex-do.mjs` を起動する理由が無い。

## 2. 実測1: 本番DBのスキーマ直接 probe（読み取り専用）

`aujust-sales-automation/.env.local` の `NEXT_PUBLIC_SUPABASE_URL` +
`SUPABASE_SERVICE_ROLE_KEY`（role=`service_role`）で PostgREST に GET のみ発行。
`select=<列>` が **200=列が存在（適用済み）** / **400 かつ `42703`=列が無い（未適用）**、
`<table>?select=*` が **200=テーブル存在** / **404 PGRST205=テーブル無し** で判定した。

| migration | 検証対象 | 結果 |
|---|---|---|
| 0065 | table `estimate_sheet_tab_cache` | **404 = 未適用** |
| 0066 | table `applied_sql_migrations` | **404 = 未適用** |
| 0067 | table `proni_message_drafts` | **200 = 適用済み** |
| 0067 | `proni_leads` の 9 列（`competition_id` / `detail_scraped_at` / `last_message_at` / `last_inbound_at` / `needs_reply` / `customer_email` / `customer_phone` / `customer_contact_name` / `customer_contact_kana`） | **9/9 が 200 = 適用済み** |
| 0068 | `proni_leads.detail_scan_error` / `detail_scan_failed_at` | **400 42703 = 未適用** |
| 0070 | table `integration_sync_state` | **404 = 未適用** |
| 0070 | `proni_leads` の 5 列（`last_scanned_at` / `scan_failure_count` / `scan_closed_at` / `scan_close_reason` / `scan_missing_count`） | **5/5 が 400 42703 = 未適用** |

補強（0067 適用の独立証拠）: `proni_leads?select=*&limit=1` の返却キー実測に
`customer_company` / `customer_address` / `meeting_wish_dates` / `scan_requested_at` が含まれる
（この4列はすべて 0067 が追加する列）。`proni_message_drafts` には実データが1行以上存在した。

**baseline の落とし穴（実測で踏んだ）**: `proni_leads` の主キーは `id` ではなく **`case_no`**。
`proni_leads?id` を baseline に使うと `42703` が返り「テーブルが無い」と誤読する。列の実在は
`select=*` の返却キーで確かめるのが安全。

## 3. 実測2: 自動適用の仕組みが一度も成功していない

`.github/workflows/db-migrate.yml`（origin/main）は
`on: push(main, paths: supabase/migrations/**)` と `workflow_dispatch` のみで、
中身は `pnpm exec tsx scripts/apply-migrations.ts` を `SUPABASE_DB_URL` secret 付きで実行するだけ。

`gh run list --workflow="db-migrate.yml"` 実測（**全3件・全 failure**）:

| createdAt | headSha の内容 | conclusion |
|---|---|---|
| 2026-08-27T05:10:16Z | #85「migration を main マージで自動適用する仕組みを入れる」 | failure |
| 2026-09-11T06:51:42Z | #104 merge | failure |
| 2026-09-20T04:07:08Z | #114 merge | failure |

`apply-migrations.ts` の適用追跡テーブルは `public.applied_sql_migrations`
（`select to_regclass('public.applied_sql_migrations')` で有無を判定し、無ければ自分で作る）。
このテーブルは実測で **404**。つまり **bootstrap（0064 までの追跡記録の作成）にも到達していない**
＝この経路は **1本も migration を適用したことがない**。
`scripts/apply-migrations.ts:main()` は `SUPABASE_DB_URL` が空なら
`::error::SUPABASE_DB_URL secret が未設定です` を出して exit 1 する（#114 の run ログと同じ）。

`gh secret list -R kimkon1011/aujust-sales-automation` 実測（15件）に **`SUPABASE_DB_URL` は無い**
（`NEXT_PUBLIC_SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` はある）。
ただし **`aujust-sales-automation/.env.local` には `SUPABASE_DB_URL` が存在する**（同ファイルに `SUPABASE_ACCESS_TOKEN` も）。
`apply-migrations.ts` は `dotenv.config({ path: ".env.local" })` を読むので、**ローカル実行なら secret 無しで同じ経路を再現できる**。

## 4. 実測3: 前記録（PR #506）の記述の訂正

`docs/proni-sync-troubleshoot-route.md`（PR #506）は
「実測でも `.github/workflows/proni-messages.yml` は 2026-09-20 に **8/8 失敗**」と書いているが、
`gh run list --workflow="proni-messages.yml"` を branch 込みで取ると、**09-20 の 8 件はすべて
branch `fix/proni-ci-diagnostics` の push 実行**（09-20T07:45〜09:07Z・duration 0s）である。

**main の実行履歴（実測・全件）**:

| createdAt | event | conclusion |
|---|---|---|
| 2026-09-18T23:46:15Z | schedule | **success** |
| 2026-09-20T04:07:07Z | push（#114） | failure（ログ取得不可: `log not found`） |
| 2026-09-10T23:34:39Z / 09-15T00:05:45Z / 09-16T23:58:55Z | schedule | success |
| 2026-09-11T23:43:05Z / 09-13T23:48:18Z / 09-15T23:51:11Z / 09-17T23:48:43Z | schedule | failure |

cron は `0 22 * * 0-5`（= 07:00 JST 月〜土）。実測時刻は 2026-09-21T18:40Z なので、
**09-20(Sun) 22:00Z の回が1回だけ gh run list に現れない**（原因未確認）。
それ以外の欠落は無い（09-19 は土曜で cron 対象外）。

→ **「#114 マージ後の main での挙動」は本番では未観測**。前記録の「8/8 失敗」を #114 後の
main の失敗根拠として引用するのは誤り。branch の失敗（0s duration）は CI 設定不備であり、
本番DBの適用状態とは別事象。

## 5. 結論（適用状況の確定）

| 範囲 | 状態 | 根拠 |
|---|---|---|
| 〜0064 | 適用済み（bootstrap 範囲。追跡記録なし） | `apply-migrations.ts` の `BOOTSTRAP_APPLIED_THROUGH = 64` と実スキーマの一致 |
| **0065** `estimate_sheet_tab_cache` | **未適用** | PostgREST 404 |
| **0066** `applied_sql_migrations` | **未適用** | PostgREST 404 |
| **0067** `proni_messages`（proni_leads 列 + `proni_message_drafts`） | **適用済み** | 9列 200 + テーブル 200 |
| **0068** `proni_leads.detail_scan_error` 系 | **未適用** | PostgREST 400 42703 |
| **0069** | **ファイル自体が存在しない**（origin/main の連番が 0068 → 0070） | `git ls-tree origin/main supabase/migrations/` |
| **0070** `proni_self_healing`（`proni_leads` 5列 + `integration_sync_state`） | **未適用** | PostgREST 400 42703 / 404 |

未適用の4本に依存するコード（origin/main で実在を確認）:
`src/lib/integration-sync-health.ts` / `src/app/api/cron/proni-pending/route.ts` /
`src/app/(dashboard)/proni-leads/page.tsx` / `src/app/(dashboard)/dashboard/page.tsx` /
`src/lib/proni-draft.ts` / `src/lib/proni-sync-policy.ts` / `src/lib/supabase/types.ts` /
`scripts/proni-messages-sync.ts` / `scripts/sync-estimate-amounts.ts` / `scripts/apply-migrations.ts`。
→ **#114 が明記していた「新列/監視table不足で同期・pending・health が失敗する」状態は今も残っている**
（`needs_reply` 列だけは 0067 適用済みなので生存。`scan_*` と `integration_sync_state` が欠落）。

## 6. やらないこと（既存承認範囲の外・明示）

- **本番DBへの migration 適用（`pnpm exec tsx scripts/apply-migrations.ts` / `supabase db push`）は実施しない。**
  本番スキーマ変更は不可逆であり、既存承認範囲の外（PR #114 も同じ理由で止めている）。
- `SUPABASE_DB_URL` の **GitHub secret 登録も実施しない**（権限・設定変更にあたる）。
  ただし値は `.env.local` に存在するため、**kim の手作業ゼロで Claude 側から投入可能**な状態にある。
- 本番DBへの INSERT/UPDATE/DELETE も発行していない（probe は GET のみ）。

## 7. 次にやること（提案・未実施）

1. **承認を得たうえで 0065/0066/0068/0070 を適用**する。順序は 0066（追跡テーブル作成）→ 0065 → 0068 → 0070。
   0066 は `apply-migrations.ts` 自身が bootstrap で作るため、**スクリプト経由が最も安全**（read-back 検証 `verifyCreatedObjects` 付き）。
   - ローカル経路: `SUPABASE_DB_URL` が `.env.local` にあるので `pnpm exec tsx scripts/apply-migrations.ts --dry-run` で対象確定 → 本適用。
   - CI 経路: `gh secret set SUPABASE_DB_URL` して `db-migrate.yml` を `workflow_dispatch`。
2. **再発防止（B）**: `db-migrate.yml` の失敗を Discord 通知する、または `proni-messages.yml` の先頭で
   必須列/テーブルの存在を検査し「スキーマ未適用」と理由を明示して落とす。
   現状は未適用でも汎用エラーになり真因が見えない（前記録 (B) と同じ提案・未着手）。
3. **未確認として残るもの**:
   - 2026-09-20T04:07:07Z の main push run（proni-messages）の失敗理由は `log not found` で取得できず**未確認**。
   - 09-20(Sun) 22:00Z の schedule 回が1回欠落している原因は**未確認**（GitHub 側の schedule 遅延/スキップの可能性）。
   - `fix/proni-ci-diagnostics`（09-20 の失敗8件の branch）が main に取り込まれる予定があるかは**未確認**。
