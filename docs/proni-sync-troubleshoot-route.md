# 「PRONI再スクレイピングの同期不具合調査・修正方針の提示」handoff の監査（2026-09-22 実測）

対象 TODO: `[handoff-audit:15a5d2433a7f91bc]` PRONI再スクレイピングの同期不具合調査・修正方針の提示（経路として `codex-do.mjs` が記録されていた）
結論: **調査は Claude 側で完結する（`gh` の一次情報 + リポジトリ読解）。手渡すべき理由は無く、`codex-do.mjs` は「実装」の経路であってこの pattern の経路ではない。**
実測で残存していた真因は「スクレイパーのコード」ではなく **本番DBマイグレーションが secret 不在で一度も適用されていないこと**だった。

---

## 1. この pattern の出所（実測）

`~/.claude/handoff-audit-nightly-ledger.jsonl` の該当行:

| ts | sessionId | verdict | learned |
|---|---|---|---|
| 2026-09-18T18:09:15Z | 4a5686be-f872-47c3-b60f-7e8dde943c39 | pass | `{pattern:"PRONI再スクレイピングの同期不具合調査・修正方針の提示", route:"codex-do.mjs", confidence:"high"}` |

同じ session の元発言（`~/.claude/handoff-audit-ledger.jsonl` 2026-09-18T09:38:46Z / 10:22:00Z）:

> 「`needs_reply` は **PRONI の案件ページを再スクレイピングした時にしか更新されない**フラグ…同期ワークフローは**直近13回中6回失敗**…修正方針は2つあり、どちらを採るかで作業量が変わります。(a) 同期の安定化＋全件の定期再評価、(b) 表示側に期間フィルタ」
> 「次に kim がすること: **(a)(b) どちらで直すかご指示ください**」

同じ session の**2回目（10:22Z）には Claude 自身が (a)+(b)+(c)+(d) を決めて Codex に実装させている**（「①…②…③…の柱で指示しました」）。
つまり **一度手渡した判断を、同じセッション内で後から自分で処理している**＝監査基準 rule 3 の「手渡しの正当化理由は OAuth初回同意/支払い/アカウント作成・ログイン/物理操作の4種のみ」に**該当しない**。
`route:"codex-do.mjs"` は `tools/automation-routes.json` の `CLI` グループから**そのまま引用された道具名**で、再発防止の手順ではない（`handoff-audit-gate.mjs:61` が route をそのまま引用させる）。

## 2. 実測した障害（コード側＝修正済み / DB側＝未適用）

### 2-1. 症状（GitHub Actions の一次情報）

`PRONI (アイミツ) leads sync` run `35475699428`（2026-09-19T23:17Z・headSha `3895b75`）:

```
⚠️ scrape 失敗タブ: 当選 (redirected to https://imitsu.jp/mypage/supplier/high-priority-matchings)
⚠️ scrape 失敗タブ: 商談中 (redirected to …)
⚠️ scrape 失敗タブ: 受注 (redirected to …)
⚠️ scrape 失敗タブ: 失注 (redirected to …)
✅ upserted 0/0 leads to proni_leads
##[error]Process completed with exit code 1.
```

タブ URL が `high-priority-matchings` へリダイレクトされ、**全タブが scrape 失敗 → 0件 upsert → exit 1**。09-18・09-19 の2回がこの形。

### 2-2. コード側は既に修復されている

| PR | merge commit | mergedAt | 内容 |
|---|---|---|---|
| #114 | `a113d05` | 2026-09-20T04:07:05Z | fix: PRONI要返信を継続的に自己修復（(a) 最終試行の古い順に再巡回・失敗の隔離・指数バックオフ (b) 90日表示 (c) 実行間隔を正確性の前提にしない (d) 6時間超停止で Discord 通知）。ユニットテスト 91/91 |

`PRONI (アイミツ) leads sync` は 09-20T23:20Z の run `35544336951`（`a113d05`）で **`✅ upserted 236/236 leads to proni_leads`** ＝リードは復旧済み。

### 2-3. 残存真因＝migration が本番に当たっていない

`DB Migrate` run `35488324718`（`a113d05` の push 直後 2026-09-20T04:07:08Z）:

```
##[error]SUPABASE_DB_URL secret が未設定です
##[error]Process completed with exit code 1.
```

`gh secret list -R kimkon1011/aujust-sales-automation` 実測（14件）:
`ANTHROPIC_API_KEY / APP_URL / CRON_SECRET / DISCORD_BOT_TOKEN / EXISTING_DEAL_INFO_SHEET_ID / EXISTING_PROGRESS_SHEET_ID / GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON / NEXT_PUBLIC_SUPABASE_URL / PRONI_EMAIL / PRONI_LOGIN_URL / PRONI_PASSWORD / SUBLINE_* / SUPABASE_SERVICE_ROLE_KEY`
→ **`SUPABASE_DB_URL` が存在しない**（`SUPABASE_SERVICE_ROLE_KEY` と `NEXT_PUBLIC_SUPABASE_URL` はある）。

#114 の本文が自ら明記しているとおり、`0067_proni_messages.sql` / `0070_proni_self_healing.sql` が未適用だと
「**新列/監視table不足により同期・pending・healthが失敗し、古い偽陽性は収束しません**」。
実測でも `.github/workflows/proni-messages.yml` は 2026-09-20 に **8/8 失敗**（07:55〜09:07Z、commits `3556ad4`〜`29c0f08`）。

なお `DB Migrate` は 09-11・08-27 の run も failure＝**この secret 欠落は 09-20 に始まった問題ではない**。

## 3. 正しい経路（推奨）

1. **症状は GitHub Actions の一次情報で取る**（Claude 側・user 作業ゼロ）:
   - `gh run list -R kimkon1011/aujust-sales-automation --limit 15 --json workflowName,conclusion,createdAt,databaseId,headSha`
   - 失敗の本文: `gh run view <databaseId> --log-failed`
   - **落とし穴**: `name:` を持たない workflow は**ファイル名で引く**。`--workflow="PRONI Messages"` は
     `could not find any workflows named PRONI Messages` で失敗し、`--workflow="proni-messages.yml"` で引ける。
2. **コード側の修復状況**は API で確定させる: `gh api "repos/.../commits?since=…&until=…"` と
   `gh pr view <N> --json title,state,mergedAt,body,files`。#114 本文には**未適用migrationと検証残**が明記されており、ここを読むだけで残リスクが分かる。
3. **DB 側の適用状況**は別系統で確認する: `gh run list --workflow="DB Migrate"` と `gh secret list`。
   「コードは緑・DBは赤」の分離はこの2コマンドで判別できる。
4. **修正の実装**だけを `codex-do.mjs`（前景・単発）へ渡す。検証は `gh run` の緑で行う。
5. 照会できない項目は**「未確認」と書く**（監査基準 rule 4）。確率表現の否定も断定と同じ扱い。

## 4. 修正方針（提示・本セッションでは未実施）

- **(A) 即時**: repo secret `SUPABASE_DB_URL`（Supabase の接続文字列）を投入 → `DB Migrate` を再実行 → `proni-messages.yml` を再実行して緑を確認。
  値は Vercel/Supabase 側から復元でき、**kim の手作業は 0**。
  ただし **本番DBへの migration 適用は不可逆**なので、既存承認範囲の外。PR #114 も「本番DBへの書き込み・migration適用は実施していません」と明示して止めている。
- **(B) 再発防止**: migration 未適用を沈黙させない。`DB Migrate` 失敗時に Discord 通知するか、`proni-messages` の先頭で必須列の存在を検査し
  **「スキーマ未適用」と理由を明示して落とす**（現状は汎用エラーで真因が見えにくい）。
- **(C) スクレイパー側（要確認）**: タブの `high-priority-matchings` リダイレクトは**セッション無効/レート制限のシグナル**であり、
  リトライ＋再ログインで扱うべき。#114 で部分失敗の隔離と指数バックオフは入ったが、
  **タブ redirect が隔離対象として明示されているかは未確認**（DB未適用のため #114 後の挙動を本番で観測できていない）。

## 5. 監査としての結論

- この handoff は **Claude 側で完結できる**（経路は §3）。`codex-do.mjs` は実装の受け皿に過ぎず、調査の経路ではない。
- 手渡しの実体は「(a) か (b) か kim に選ばせる」設計判断で、**rule 3 の4理由のいずれにも該当しない**。
  同セッション内で Claude 自身が決めて実装に進んでいる以上、**後から自分でできた作業の手渡し**にあたる。
