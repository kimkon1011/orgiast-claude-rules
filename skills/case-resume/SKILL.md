---
name: case-resume
description: 案件IDまたは案件名から他の席の案件作業を再開する。短いSTATEと直近LOGを先に読み、詳細だけ後から検索する。
---

配布リポジトリの `tools/case-handoff.mjs resume "<案件ID または案件名>"` を実行する。出力は STATE.md と直近10セッションの LOG のみ、合計6KB以内。作業中の席の時刻を確認し、直近30分の別席があれば同時編集に注意して進める。

`tools/case-handoff.mjs bind <確定した案件ID> --session <現在のsessionId>` でこのセッションも紐付ける。

詳細が必要な場合だけ `tools/case-handoff.mjs sync <案件ID>` で全文を `~/.claude/case-sessions/<案件ID>/transcripts/` に同期し、Grep/rg で目的の語・日時を検索する。全文を Read や cat で丸読みしない。STATE の決定事項は引用元のファイル名・日時から確認できる。保存エラー・要約未生成は成功扱いせず `tools/case-handoff.mjs retry` で再送を試す。
