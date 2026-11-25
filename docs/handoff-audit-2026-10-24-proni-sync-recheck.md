# PRONI 同期 handoff 再検証（2026-10-24 実測 / handoff-audit:d40b0dbb3bd054ff）

対象 handoff: 「PRONI再スクレイピングの同期不具合調査・修正方針の提示（同期失敗をコード側の問題と決めつけ、判断を user に選ばせる）」
前回監査: `docs/proni-sync-troubleshoot-route.md`（2026-09-22 / handoff-audit:15a5d2433a7f91bc）

## 1. 結論

- **同型 handoff（(a)(b) の選択を user に投げる）の再発は、照会できた範囲では 0 件。**
- ただし **PRONI の日次同期は現在も失敗している**。原因は 2026-09-22 の残存真因（migration 未適用）ではなく、**別のスキーマ不一致**。
- 2026-09-22 に残っていた「`SUPABASE_DB_URL` secret 不在で DB Migrate が赤」は **2026-10-04 に解消済み**（secret 追加＋以降 DB Migrate は緑）。
- 今回の失敗は Claude 側の一次情報だけで真因まで特定できた。**user に選択を求める必要は無かった**（下記 §4 のとおり Claude が修正方針を決定）。

## 2. 再発走査（照会できた範囲）

| 対象 | 実測 | 同型の再発 |
|---|---|---|
| `~/.claude/handoff-audit-ledger.jsonl` | 870 行 | 0 件 |
| `~/.claude/handoff-audit-nightly-ledger.jsonl` | 62 行 | 0 件（2026-10-22 の 1 行は「学習 route」として同 pattern 名を含むだけで、user への選択依頼ではない） |
| `~/.claude/projects/**` の transcript | 5 プロジェクト。PRONI を含むファイルは 2 本（`10f1888c…` = next-session.md の添付、`3694d684…` の subagent = 会計 CSV の社名）。user 向けの選択依頼は 0 件 | 0 件 |

**限界（未確認）**: HP に残る transcript は 2026-10-14 以降のみ。それ以前のセッション本文はこの PC に無いため、**2026-09-22〜2026-10-13 の transcript 走査は未確認**（台帳 870+62 行の範囲が唯一の証拠）。「確率付き否定」はしない。

## 3. 実物の状態（GitHub Actions 一次情報）

### 3-1. 症状: PRONI leads sync が 10-15 以降ほぼ毎日失敗

`gh run list -R kimkon1011/aujust-sales-automation --workflow="proni-sync.yml" --limit 10`:

| createdAt | run | 結果 | 確認した失敗理由 |
|---|---|---|---|
| 2026-10-23T00:02Z | 39875685307 | failure | `deals_next_contact_basis_check` 違反 |
| 2026-10-22T00:04Z | 39697412415 | failure | 未確認（個別ログ未取得） |
| 2026-10-20T23:59Z | 39518496154 | failure | `deals_next_contact_basis_check` 違反 |
| 2026-10-20T00:29Z | 39347897214 | failure | 未確認 |
| 2026-10-18T23:26Z | 39176494871 | failure | 未確認 |
| 2026-10-17T23:16Z | 39078360160 | failure | 別原因: 全タブが `high-priority-matchings` へリダイレクト |
| 2026-10-16T23:44Z | 38982967180 | failure | 未確認 |
| 2026-10-15T23:43Z | 38825310703 | failure | `deals_next_contact_basis_check` 違反 |
| 2026-10-14T23:59Z | 38657378990 | cancelled | — |
| 2026-10-14T00:25Z | 38490125011 | failure | 別原因: 全タブが `high-priority-matchings` へリダイレクト |

10-23 のログ本文:

```
scraped: 189 leads
Error: deal 作成失敗: new row for relation "deals" violates check constraint "deals_next_contact_basis_check"
    at promoteProniLeadCore (.../src/lib/proni-promote.ts:293:31)
    at async prepareProniWonLead (.../src/lib/proni-promote.ts:307:3)
```

スクレイピング自体は成功（189 leads）。**失敗するのは「当選 → deal 昇格」の INSERT だけ**。

### 3-2. 真因: DB の check 制約がコードの新しい値を許可していない

| 側 | 実物 | 値 |
|---|---|---|
| DB | `supabase/migrations/0001_init_schema.sql:102` | `手動 / 相手指定 / 自動推定 / デフォルト+1週` |
| コード | `src/lib/proni-lifecycle.ts:12`（当選） | `自動(当選)` |
| コード | `src/lib/contact-schedule.ts:13`（返信） | `自動(返信)` |
| コード | `src/lib/supabase/types.ts:120`, `src/app/actions/deals.ts:59`（zod enum） | 上記 + `自動(議事録)` |

`supabase/migrations/` 全件を grep しても、`next_contact_basis` の制約を広げる migration は **0001 以外に存在しない**（main の実物を clone して確認）。

### 3-3. 2026-09-22 の残存真因は解消済み

- `gh secret list` に `SUPABASE_DB_URL` が存在（作成 2026-10-04T12:04:41Z）。前回監査時は不在。
- `DB Migrate` は 2026-10-04T12:08Z 以降 **7 回連続 success**（最終 2026-10-17T03:46Z, run 39000085253）。10-04 の failure 3 件（01:13 / 05:09 / 12:05）は secret 追加前。
- したがって「コードは緑・DB は赤」ではない。**DB Migrate は緑だが、必要な migration 自体が存在しない**という第3の状態。

## 4. 修正方針（Claude が決定。user に選択を求めない）

**(A) migration で制約を広げる**を採用する。理由:
1. コード側は 3 ファイル + テスト 2 本が新値を前提に揃っており、UI の選択肢も 7 値。
2. コードを旧 4 値へ戻すと「当選/返信/議事録」の由来が失われ、追いかけの根拠表示が壊れる。
3. 制約の拡張は追加的で、既存行の書き換えを伴わない（可逆）。

追加する migration（`0079_deal_next_contact_basis_values.sql`）:

```sql
do $$
begin
  alter table public.deals drop constraint if exists deals_next_contact_basis_check;
  alter table public.deals add constraint deals_next_contact_basis_check
    check (next_contact_basis is null or next_contact_basis in (
      '手動','相手指定','自動推定','デフォルト+1週','自動(返信)','自動(当選)','自動(議事録)'
    ));
end;
$$;
```

本セッションでは **aujust-sales-automation に draft PR として用意**し、本番 DB への適用（merge → DB Migrate）は既存の承認範囲外なので **merge の1回だけを人の承認に残す**。

## 5. route の是正（今回の実測で足りなかった点）

前回 route の ③「DB 側の適用状況は DB Migrate と secret で確認」だけでは今回の真因に届かない。**「DB Migrate が緑」＝「スキーマがコードと一致」ではない**。追加する:

> ④' INSERT/UPDATE が `violates check constraint "<table>_<column>_check"` で落ちた場合、
> ①その制約の定義を `supabase/migrations/` から特定し、②コード側の enum / zod / types と値を突き合わせ、
> ③制約を広げる migration が存在するかを grep する。無ければ「migration 未作成」が真因。
> `DB Migrate` の緑は「既存 migration が適用済み」の証拠であって「必要な migration がある」証拠ではない。

## 6. 残ったこと

- aujust-sales-automation の draft PR（migration 0079）の merge → DB Migrate success → `proni-sync.yml` の success を次回セッションで `gh run list` 1 回で確認する（ポーリングしない）。
- 10-17 / 10-14 の `high-priority-matchings` リダイレクト失敗は本件と別原因。今回の制約修正では直らない（別途、#114 のリダイレクト隔離の挙動確認が必要）。
