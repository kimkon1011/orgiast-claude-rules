# handoff-audit 検証記録: `0891a2009355a8af`（P3 / 297b6517）の再発検証（2026-10-23）

対象 TODO: `[handoff-audit:0891a2009355a8af] 恒久修正の先送り文を検出（2026-10-21T12:30:49.713Z / 297b6517 / P3）`
（`~/.claude/next-session.md`）。検出器は `tools/permanent-fix-deferral-scan.mjs`（夜間 `handoff-audit-nightly` が実行）。

送信なし・権限変更なし・kim への DM なし。既存の承認範囲のみ。

## 結論（3点）

1. **原文の再発は無い。** 3 台帳（stop-gate-runner 1070 行 / handoff-audit 1392 行 / nightly 68 行）を
   全期間走査して、この文を含むのは**当該セッション `297b6517` の 12:30:36〜12:30:49Z の 3 ターンだけ**。
   同時に起票された兄弟 TODO（`d85cdd0d301b1fe2` / `b0b68f419a6e567d`）も同じ 3 ターンの部分一致で、
   独立した再発ではない。
2. **先送りは当該セッション内で 12 分後に回収済み。** 12:44:27Z に「修正案1・2 を実装し `f2c8150` として
   main に push」と報告しており、本日 `origin/main`（`7ba1879`）上に `f2c8150` が祖先として存在することを
   実物で確認した（§2）。
3. **恒久策の再発は 0 件。** 修正後の窓（2026-10-21T12:30:50Z 以降）で P3 ヒットは nightly 台帳の 1 件のみで、
   これは**同一セッション・同一原文の LLM 監査による再録**（18:01:31Z）。2026-10-22 以降は 3 台帳すべて 0 件（§3）。

## 1. 原文の再現（一次証拠）

`~/.claude/stop-gate-runner-ledger.jsonl` の 12:30:49.713Z 行（`verdict=pass`）:

```
次に kim がすること: 修正案（推奨は 1+2）を実施してよいか返事をください。通知された学会名を数件添えてもらえると照合できます。
この後の自動進行: 返事をもらい次第、実装、テスト、デプロイ、本番での確認までこちらで進めます。
```

P3 の一致語は `修正`（`HANDOFF_LINE` の直後）。対象は `aujust-gakkai-automation` の
`src/lib/moshikomi-followup.ts`（申込作業の未着手フォロー通知）。

`handoff-audit-nightly-ledger.jsonl` の 18:01:31.169Z 行（LLM 監査）も同じ引用を block 判定しており、
指摘内容（`次に kim がすること: 修正案（推奨は 1+2）を実施してよいか返事をください。` を rule 2/3 違反とする）は妥当。

## 2. 先送りされた作業の末路（同一セッションが 12 分後に完了）

| 時刻 | 実物 | 内容 |
|---|---|---|
| 12:30:29Z | stop-gate 台帳 | 通知条件の調査報告（`NEXT-ACTION-FOOTER` で block） |
| 12:30:49Z | stop-gate 台帳 | **本件**（承認を求めてターンを閉じた） |
| 12:44:27.689Z | stop-gate 台帳 | 「修正案1・2 を実装し、`f2c8150` として main に push しました」（`NEXT-ACTION-MULTIPLE` で block） |
| 2026-10-21 21:42:15 +0900 | `aujust-gakkai-automation` | commit `f2c8150c1b5f02f7c637d5ed211417696e20ea7b`「fix(research): 申込作業の未着手通知から担当未設定と趣意書未入手の学会を除外」 |

差分（`src/lib/moshikomi-followup.ts`）は、原文が約束した「担当未設定と趣意書待ちを追跡対象から外す実装」そのもの:

```diff
+export interface FollowupConf { ...; shuishoFolderUrl: string }
+    if (!conf.moshikomiTanto.trim()) continue;                       // 担当(DS)未設定は追跡しない
+    if (!/^https?:\/\//i.test(conf.shuishoFolderUrl.trim())) continue; // 趣意書がURL未入手なら追跡しない
-      tanto: conf.moshikomiTanto.trim() || n.tanto.trim(),
+      tanto: conf.moshikomiTanto.trim(),
```

`git merge-base --is-ancestor f2c8150 origin/main` = **YES**（origin/main = `7ba1879`）。
本日時点で `origin/main:src/lib/moshikomi-followup.ts` にも上記 2 行がそのまま存在する（revert なし）。

## 3. 再発の有無（台帳の全走査）

`node tools/permanent-fix-deferral-scan.mjs --since <窓>`:

| 窓 | stop-gate-runner | handoff-audit | nightly |
|---|---|---|---|
| 2026-10-21T00:00Z〜 | 3（すべて `297b6517`・12:30:36/43/49） | 0 / 1392 | 1（同一セッション・同一原文の再録） |
| **2026-10-21T12:30:50Z〜** | **0 / 1070** | **0 / 1392** | 1 / 68（上記再録のみ） |
| **2026-10-22T00:00Z〜** | **0** | **0** | **0** |

→ 本件の手渡し文が**別セッションで再発した事実は無い**。修正案を承認待ちで止めたのは当該 1 セッションのみで、
そのセッション自身が同日中に実装・push まで到達している。

### 追補（2026-10-23 auto-session #4）: 兄弟監査ID `b0b68f419a6e567d` の単独再検証

`b0b68f419a6e567d` は `297b6517` の **1ターン目 12:30:36.063Z** に対応する（ID は本文ハッシュ由来で
台帳に文字列としては現れないため、時刻と原文の逐語一致で同定した）。独立に再実測した結果:

- `node tools/permanent-fix-deferral-scan.mjs --since 2026-10-21T12:30:36Z` → P3 は stop-gate-runner の
  3件（すべて `297b6517`・12:30:36/43/49）と nightly の再録 1件（18:01:31Z・同一原文）のみ。
  handoff-audit 台帳は 0 / 1392。
- `--since 2026-10-22T00:00:00Z` → 3 台帳すべて **P1〜W = 0**（10-22 / 10-23 の再発なし）。
- `D:/repos/aujust-gakkai-automation` で `git merge-base --is-ancestor f2c8150 origin/main` = **YES**
  （origin/main = `7ba1879`）。`origin/main:src/lib/moshikomi-followup.ts` の L50/L52 に
  「担当(DS)未設定なら追跡しない」「趣意書が URL 未入手なら追跡しない」が現存＝revert なし。

→ 本 ID も**再発 0・先送りは同一セッション内（12:44:27Z）で回収済み**。重複 PR は作らず本 PR で記録する。

## 4. 本番への反映状況（参考）

- Vercel `aujust-gakkai-automation` の Production デプロイは **2026-10-22 01:16:29 JST に Ready**
  （`dpl_4ahyuKH8axJ9NYwsySjFpPhg1kCp`、alias `aujust-gakkai-automation.vercel.app`）。
  `f2c8150`（2026-10-21 21:42 JST）より後のビルドのため、修正コードは本番ビルドに含まれる。
- ただし**本番 cron が実際に「担当未設定／趣意書未入手」の学会を通知から除外したか**は、
  12:44:27Z の報告でも明示的に未検証のままで、本セッションでも通知の実発火を観測していない（§5）。

## 5. 残ったこと

- 本番 cron の通知内容で「担当未設定・趣意書未入手」が消えたことの観測（次回 cron 実行後のログ／通知実物）。
  これは恒久修正の効果測定であり、先送りの再発ではない。
