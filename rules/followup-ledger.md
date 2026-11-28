# 依頼追跡台帳（followup-ledger）

人や先方に依頼（確認・署名・印刷・郵送・返信・作業）を出したら、その時点で followup-ledger に載せる。完了条件・確認間隔・返答期限・再催促・最大催促回数・エスカレーション先を書く。報告だけで終わらせない。完了するまで追跡を止めない。前提が欠けて止まったら、その理由を台帳に書いてエスカレーションする。

## 使い方
- 追加: `node tools/followup-ledger.mjs add --id REQ-1 --to 佐藤 --channel beeper --chat <chatID> --scope internal --task "署名写真を送って" --done-when "署名入り写真" --done-pattern "." --interval 30 --due 2026-11-28T12:00:00+09:00 --renudge 60 --max-nudges 3 --escalate kim-inbox --owner-ai claude --owner-pc 011`
- 確認: `node tools/followup-ledger.mjs check`
- 完了: `node tools/followup-ledger.mjs complete --id REQ-1 --evidence "写真受領"`

台帳URLは `config/followup-ledger.json` の `url`。未送信台帳（unsent-ledger）は「送ったか」、こちらは「依頼が完了したか」。

## 勤務形態の前提（必須）

会社はフルリモートで、アシスタントは各地に住んでいる。依頼先が大阪や特定事務所にいる前提にせず、法務局・郵便局などは全国で使えることを前提に担当を決める。台帳の「担当者区分」に `cafe-solo` / `remote-assistant` / `staff` / `external`、「居住地・最寄り」に居住地と最寄り窓口、「作業場所」に `in-store` / `off-site` / `any` を書く。作業場所が空なら依頼内容から自動判定する。

大阪のカフェスタッフは一人勤務のため、店を離れる作業（コンビニ、郵便局、投函、法務局、裁判所、役所、配達、訪問、銀行など）を頼まない。`cafe-solo` に店外作業を載せると、催促せず「止まった」にし、店を離れられる各地のアシスタント等への付け替えをエスカレーションする。カフェスタッフには、書類が店にあるかの確認、店まで来た人への手渡し、メッセージへの返事など店内でできることだけを別行で頼む。

前提が欠けても黙って止めてはならない。必ず理由を台帳に書き、付け替えをエスカレーションする。旧 `OrgiastLahainaPrintFollowup-1126` がカレンダー未共有を理由に黙って止まった事例を繰り返さない。

- 担当PC: その経路で送れるPCを担当にする（Beeper は 000）。`check` は担当PC一致（または `any` / `--all-pcs`）の行だけ処理し、担当外は見張るだけ。
- 営業時間外: 22:00〜7:00（JST）は社内催促を送らず、7:00 以降へ延期する。


## 受けた依頼も同じ台帳に載せる（2026-11-28）

人に頼んだもの・グロボが受けたもの・Claude Code が受けたもの・自動化の成果監視を、同じ台帳に `--kind human|globo|claude-code|automation` で載せる。新しい台帳・シートに分けない。

完了は実物（追跡番号・公開URL・返信本文・成果物パス）で確認する。`--evidence-kind tracking-number|public-url|reply-text|file` と `complete --id <ID> --evidence <実物>` を使い、exit 0 や approved だけでは完了にしない。

前提欠落・成果ゼロは「止まった」にし、理由と金さんだけができること（`--kim-only`）、付け替え先（`--reassign-to`）を記録する。`--prereq file:<絶対パス>` で前提を検査し、`--outcome-source insta-queue:<dir>` または `json:<file>` で成果を確認する。別PCからの観測事実も `outcome --id <ID> --job-result 0 --pending-approved <件数>` で記録する。

朝の報告は `report --morning`。`--kim-inbox` 指定時だけ社内の info として同日1件を登録する。毎朝07:30 JSTの `OrgiastFollowupLedgerMorning` から実行する。

再発事例: 2026-11-24 承認の Instagram 自動投稿が 015 のトークン無しで投稿0のまま、誰も報告しなかった。

## 途中で止まった作業は終了時に台帳へ入れる（2026-11-28 GB-229）

中断・金さん待ち・残件あり・インシデント・exit 非0・上限停止で終えた作業は、終わらせた時点で必ず `node tools/ledger-open-item.mjs open --id <ID> --task <残件> --owner-pc <PC> [--kim-wait] [--due "YYYY-MM-DD HH:MM"] [--evidence-path <STATUS/REPORT>]` で台帳に入れる（冪等。同じ id は更新）。channel=manual で登録し、催促メッセージは送らない。期限が無ければ、金さん待ちは翌営業日09:00 JST、それ以外は翌日09:00 JST。claude -p の wrapper は `templates/run-cc-ledger-snippet.ps1` を終了処理に入れる。入れ忘れても 008 の `followup-ledger check`（hub PC のみ）が gb-reports の STATUS/REPORT/EXIT と巡回 STATUS-<PC>.md を `node tools/ledger-open-item.mjs scan` で走査し、同じ作業の行が無い未完了を登録する。他PCの gb-reports は 008 から読めないため、各PCの終了時登録が必須。詳細は portable-knowhow/20_止まった作業を台帳に入れる.md。

再発事例: 2026-11-26 神原さんのグループ外し作業で common.users の約100人を誤削除し、19:30 に「100人未復旧・金さん待ち」で止まったのに台帳に行が作られず、11/28 まで2日間だれも追わなかった。
