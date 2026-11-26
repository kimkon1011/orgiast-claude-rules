## Summary
- ALERT.md を要約版にし、グロボが毎時読める大きさ（目安 200KB 以下）にする
- 【最優先】全文 / 【止まった】は人が決めた連絡を全文、Gmail下書き・古い下書きは集計節へ
- 【照合エラー】は理由ごとの件数＋代表5件（Gmail下書きの match 未設定は除外）
- 【未送信】は本文先頭300字、全件詳細は ALERT-full.md / alerts.json / cards/

## Test plan
- [x] `node --test tools/unsent-ledger.test.mjs`（既存＋要約版・照合スキップ）
- [ ] マージ後 `node tools/unsent-ledger.mjs --dry-run` で ALERT.md サイズ確認
