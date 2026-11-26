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

- `ALERT.md`（200KB以下を目安とする要約。最優先・人が決めた停止連絡・直近7日の下書きファイルは本文全文、未送信は先頭300文字）
- `ALERT-full.md`（全件の本文全文。Gmail下書きと14日超の下書きは要約版ではアカウント別・宛先ドメイン上位20の集計）
- `alerts.json` / `cards/<id>.json`
- `SUMMARY.md` 先頭の `<!-- UNSENT-ALERT-START -->` 区間

照合エラーは理由別件数と各5件を表示する。Gmail下書きの `match` 未設定はエラー集計から除き、その他のエラーは残す。Gmail一覧で同じアカウント・IDの下書きの現存を確認できた場合だけ送信照合を省略する。

`node tools/unsent-ledger.mjs --dry-run` は既存台帳から表示を再生成するだけで、台帳保存・取込・外部照合・通知・送信は行わない。定期ランナーは `--refresh --dry-run` により従来どおり取り込みと照合を行い、送信は予告に固定する。最優先や全文表示が必要な連絡が増えた場合も本文を削ってサイズを合わせない。

## 関連タスク（止めない）

- `OrgiastMailStaleDraft`（mail-stale-draft）: Gmail の「古い下書き」ラベル付け
- `ledger-stale-nag`: 別系統の停滞リマインド

本台帳は「送ると決まった件の追跡」に特化。役割は重なるが置換ではない。

## 通知

止まった・最優先が ack 無しで2回連続残ったら、`tools/notify-kim.mjs` の既定経路（kim-inbox）へ1日1件まで要約。kim 宛 Discord DM は使わない（組織ルール16）。
