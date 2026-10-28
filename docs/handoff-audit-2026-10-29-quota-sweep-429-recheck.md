# 追記: handoff-audit 7c5815092275ce5c 再検証（2026-10-29）

対象: `docs/handoff-audit-2026-10-25-quota-sweep-deferred-429.md`（初回検証）および
`docs/handoff-audit-2026-10-26-quota-sweep-429-recheck.md`（修正後1件の訂正）のその後の再検証。
再発防止の経路: quota-sweep.jsonl の deferred 行を確認し、利用窓が読めない原因を特定して回帰テスト付きで修正し PR を作成する。

## 実測（2026-10-29）

- **修正は既に main にある**: PR #1133（`21a20fb`）が 2026-10-26T09:43Z にマージ済み。
  `claudeWindowReader` が oauth/usage の 429 で `Retry-After` を記録し、その間は API を叩かず残り秒数を返す。
  回帰テスト `tools/quota-sweep.test.mjs` の「429 の Retry-After の間は API を叩かず残り秒数を返す」も実在。
- **テストは緑**: `node --test tools/quota-sweep.test.mjs tools/lib/quota-windows.test.mjs` = 71 pass / 1 skip / 0 fail。
- **ledger 全履歴（44 行）で HTTP 429 deferred の同一 goal 連続は最大 2、3 連続は無い**:
  - 2026-10-24T14:18 / 14:34Z（delegation-health 目的）
  - 2026-10-25T03:17 / 03:34Z（本 handoff 目的）— 初回起票時の 3 連続はスイープ内部カウンタ
    （window-unreadable の deferred が 10-24T14:15 / 10-25T03:17 / 03:34Z と 2 窓にまたがって計 3）由来
  - 2026-10-27T05:27 / 05:43Z（倉庫アプリ目的、同一 5h 窓）— **#1133 マージ後唯一の発生**
- **#1133 後の 10-27 ペアは 2 件で止まり 3 件目が無い**（次エントリは 10-28T11:37Z codex exhausted）。
  レーン全滅の誤判定・枠の失効実害なし。前回記録の「設計どおりの限界」（429 が Retry-After 上限・
  キャッシュ有効期間を超えて続くと deferred になり、次 tick で再試行）の範囲内。

## 判断

- quota-sweep claude の deferred 3 連続は再発していない。原因特定・回帰テスト付き修正・PR（#1133）は
  完了済みで、コード変更は不要。
- 監視継続条件: 同一 goal で HTTP 429 deferred が 3 連続、または窓読み取り失敗で枠を失効させた実害が
  出た場合に再起票する。