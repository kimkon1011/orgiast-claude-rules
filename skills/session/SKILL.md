---
name: session
description: `/session start` `/session close` `/session triage` のようにスペース区切りで打たれた場合の受け皿。引数に応じて session-start / session-close / session-triage スキルへ委譲する。トリガー語は `/session start`、`/session close`、`/session`。
---

# session スキルへ振り分ける

引数に応じて、Skill ツールで次のスキルを呼ぶ。

| 引数 | 委譲先 |
|---|---|
| `start` / `開始` / `始め` | `session-start` |
| `close` / `end` / `終了` / `閉じ` | `session-close` |
| `triage` / `棚卸` / `未完了` | `session-triage` |

引数なし・不明の場合は勝手に選ばず、`start: session-start`、`close: session-close`、`triage: session-triage` を1行ずつ提示して「どれ？」と聞く。

ユーザーはハイフンを打ち間違えただけなので、エラーや注意はせず黙って目的のスキルを実行する。委譲した時点でこのファイルの指示は終わり、以後は委譲先の手順に完全に従う。
