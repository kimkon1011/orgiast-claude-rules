# 依頼追跡台帳（followup-ledger）

人や先方に依頼（確認・署名・印刷・郵送・返信・作業）を出したら、その時点で followup-ledger に載せる。完了条件・確認間隔・返答期限・再催促・最大催促回数・エスカレーション先を書く。報告だけで終わらせない。完了するまで追跡を止めない。前提が欠けて止まったら、その理由を台帳に書いてエスカレーションする。

## 使い方
- 追加: `node tools/followup-ledger.mjs add --id REQ-1 --to 佐藤 --channel beeper --chat <chatID> --scope internal --task "署名写真を送って" --done-when "署名入り写真" --done-pattern "." --interval 30 --due 2026-11-28T12:00:00+09:00 --renudge 60 --max-nudges 3 --escalate kim-inbox --owner-ai claude --owner-pc 011`
- 確認: `node tools/followup-ledger.mjs check`
- 完了: `node tools/followup-ledger.mjs complete --id REQ-1 --evidence "写真受領"`

台帳URLは `config/followup-ledger.json` の `url`。未送信台帳（unsent-ledger）は「送ったか」、こちらは「依頼が完了したか」。

- 担当PC: その経路で送れるPCを担当にする（Beeper は 000）。`check` は担当PC一致（または `any` / `--all-pcs`）の行だけ処理し、担当外は見張るだけ。
- 営業時間外: 22:00〜7:00（JST）は社内催促を送らず、7:00 以降へ延期する。
