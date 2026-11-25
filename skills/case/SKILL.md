---
name: case
description: 現在のセッションを案件一覧の案件IDに明示的に紐付ける。複数案件の紐付けも可能。
---

引数の案件IDを使い、配布リポジトリの `tools/case-handoff.mjs bind <案件ID> --session <現在のsessionId>` を実行する。sessionId は hook が示す現在のものを使い、他のセッションを推測して選ばない。`CLAUDE_SESSION_ID` が設定済みなら `--session` は省略できる。

これ以降の Stop / SessionEnd が全文の未送信分をキュー経由で保存する。過去の会話も同じセッションの先頭から取り込む。複数案件への紐付けは追加型なので、指定済み案件を消さない。
