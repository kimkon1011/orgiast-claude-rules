# 送信待ち台帳（unsent-ledger）v2

止まった送信を必ず追う台帳。schema: `unsent-ledger/v2`。

## 状態（6つだけ）

| 状態 | 意味 |
|---|---|
| 承認待ち | 社外など、金さんの承認が必要 |
| 自動送信待ち | 社内かつ金さん決定あり。dry-run 以外は Beeper 送信可 |
| 止まった | 理由必須。下書きのみ・照合失敗の固定など |
| 送信未確認 | 送信した痕跡あり・読み戻し未確定 |
| 送信済み | 照合で確定 |
| 取り下げ | 金さんの決定記録（hasKimDecision）が必須 |

PENDING（照合対象）= 承認待ち・自動送信待ち・送信未確認・止まった。

## 入口

- inbox: `~/.claude/unsent-ledger/inbox/*.json` と `gb-reports/unsent-ledger/inbox/*.json`（取込後 `done/` へ移動）
- CLI: `node tools/unsent-ledger.mjs add --file <json>`
- 定期: `OrgiastUnsentLedger`（毎時 :20 と :50）→ `tools/unsent-ledger-runner.mjs`

## 出力

`UNSENT_LEDGER_EXPORT_DIR`（既定: `gb-reports/unsent-ledger`）へ毎回上書き:

- `ALERT.md`（最優先→止まった→照合エラー→未送信。0件でも時刻付き）
- `alerts.json` / `cards/<id>.json`
- `SUMMARY.md` 先頭の `<!-- UNSENT-ALERT-START -->` 区間

## 関連タスク（止めない）

- `OrgiastMailStaleDraft`（mail-stale-draft）: Gmail の「古い下書き」ラベル付け
- `ledger-stale-nag`: 別系統の停滞リマインド

本台帳は「送ると決まった件の追跡」に特化。役割は重なるが置換ではない。

## 通知

止まった・最優先が ack 無しで2回連続残ったら、`tools/notify-kim.mjs` の既定経路（kim-inbox）へ1日1件まで要約。kim 宛 Discord DM は使わない（組織ルール16）。
