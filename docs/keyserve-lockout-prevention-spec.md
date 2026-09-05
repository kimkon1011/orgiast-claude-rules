# keyserve 締め出し防止 (Phase D) — 実装仕様

## 背景（実測）
- 2026-09-01: nishi PC (DESKTOP-04U31RG) が keyserve 401 で `keyserve.env` / `fleet-sheet.env` /
  `orgiast-discord-bot-token.txt` を受け取れていなかった。原因は「8/25 に primary をローテした際、
  nishi が起動しておらず legacy 秘密のまま取り残された」こと。
- 現行 primary は 64 文字の専用ランダム値（Discord webhook 兼用という旧根本原因は解消済み）。
- **残る欠陥: どの PC が primary へ移行済みかを誰も観測していない。** legacy 削除の判断が勘になる。

## ゴール
1. 各 PC の keyserve 認証経路（primary / legacy / enroll / 失敗）が毎晩台帳に載る。
2. 「全 PC が primary で認証済み」を満たすまで legacy 秘密の削除を**スクリプトが拒否**する。
3. 鍵が 48h 以上降りていない PC は、自分が持つ webhook で自己通報する。

## 実装

### D-1. authVia の台帳報告
- `tools/keyserve-status.mjs` に `--json` の出力へ `hostname` と `checkedAt` を追加（既存 `auth` /
  `success` / `status` / `files` は互換維持。既存テストを壊さないこと）。
- `tools/fleet-sheet-report.mjs` の**既存の PC status upsert に keyserve 項目を相乗り**させる
  （`keyserveAuth` = primary|legacy|enroll|failed|unset, `keyserveStatus` = HTTP, `keyserveCheckedAt`）。
  - **着手前に `gas/` 配下の受け口を読み、未知フィールドを GAS が捨てる実装なら**
    `kind:'keyserve'` + 専用タブ方式に切り替える。どちらを選んだか PR 本文に書く。
- `tools/nightly-batch.ps1`: `webhook-health --post-sheet` の隣で `keyserve-status --json` を実行し
  上記へ渡す。**失敗は握り潰す**（夜間バッチ本体を絶対に止めない）。

### D-2. ローテーション可否ゲート
- 新規 `tools/keyserve-rotation-gate.mjs`
  - 台帳の全 PC 行を読み、`keyserveAuth !== 'primary'` の PC を列挙。
  - 1 台でも残れば `exit 1` + 「この PC がまだ primary ではないので legacy を消すな」を PC 名（hostname と
    人が読める PC 名の**両方**）付きで出力。
  - `--json` 対応。`ORGIAST_ROTATION_GATE_STALE_HOURS`（既定 72）より古い行は「未確認」として**不合格側**に数える
    （fail-open 禁止）。
- ONBOARDING に1行: **legacy 削除の前に必ずこのゲートを通す**。

### D-3. 鍵未受領の自己通報
- `tools/onboarding-sync.mjs` の `alertKeyserveFailure` は既に 24h 抑止つきで通報する。
  ここに「`~/.claude/.keys-sync-state.json` の last が 48h 以上前」の条件を追加し、
  **401 でなく "そもそも成功していない"** ケースも通報対象にする。秘密値・HMAC は本文に含めない（現状維持）。

## 受け入れ条件（Layer1 = ロジック再現）
- `tools/keyserve-rotation-gate.test.mjs`: ①全台 primary → exit 0 ②1台 legacy → exit 1 かつ PC 名が出る
  ③行が古い → 不合格 ④台帳取得失敗 → 不合格（fail-open しない）。
- `ORGIAST_HOME` を一時ディレクトリに向けた実行で、`keyserve-status --json` が新フィールドを返すこと。
- 既存 `onboarding-sync.test.mjs` / `keyserve-alert.test.mjs` が緑のまま。
- 破壊的変更なし: **既存 primary / legacy / enroll の受け付けは一切変えない**（置換は今回直した締め出しの再生産）。

## 後続フェーズ（この PR では触らない）
- **B**: `POST /api/enroll`（既存 PC が自分の鍵で認証 → 署名済み使い捨てトークンを発行。Vercel env 追加も
  再デプロイも不要）+ `tools/keyserve-enroll.mjs --pc <name>` が完成した1行とフル手順を Discord DM 送信。
- **C**: `install-orgiast.ps1 -Enroll <token>`（新 PC は1行で導入〜鍵受領〜200 確認〜自己報告）。
- **A**: PC ごと導出鍵 `HMAC(master, pcId)` + `x-orgiast-pc` ヘッダ + `ORGIAST_REVOKED_PCS`。
- **却下: GitHub org 所属で認証**。実測により `install-orgiast.ps1` は git/node だけを入れ、リポは
  **公開 ZIP** で取得しており、メンバー PC に `gh` も GitHub 認証も存在しない。採用すると全 PC に
  `gh` 導入 + `gh auth login`（ブラウザ device code）が増え、消そうとした手渡しより手数が増える。
- Google Workspace SSO の enroll ページは B/C があれば不要（メンバーの操作回数は同じ1回）。
