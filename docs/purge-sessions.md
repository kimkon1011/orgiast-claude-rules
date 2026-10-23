# セッションの自動退避

`setup --converge` は各アカウントの SessionStart / Stop に、リポジトリの
`tools/purge-sessions.mjs --hook` を登録する。旧 `session-list-tidy.mjs`、
`purge-hidden-sessions.py`、凍結コピーの `purge-closed-sessions.mjs` の登録も置き換える。
ランチャーは detached・windowsHide・stdio ignore で単発プロセスを起動して終了する。
常駐プロセスやスケジュールタスクは追加しない。

`~/.claude/current-sessions/*.json` の `at` が直近10分以内の ID は全条件に優先して保護する。
その他の JSONL は次の順に判定する。

| reason | 条件 | 経過時間の基準 |
|---|---|---|
| closed | closed-sessions.json に記録済み、45秒以上 | mtime |
| empty | 実発言・応答がなく、90秒以上（200KB以下のみ） | mtime |
| approved | 最後の assistant が「このセッション: …このセッションを閉じてよい」（旧表記「このセッション: アーカイブしてよい」も可。pending/open は対象外）、以降に user 発話なし、10分以上 | JSONL 最終行の timestamp |
| abandoned | 72時間以上 | JSONL 最終行の timestamp |

退避先は `~/.claude/projects-archive/<projectId>/`。JSONL と同名の付属ディレクトリを
move し、既存の退避ファイルは上書きしない。拡張の状態DBにはアクセスしない。
`archived-sessions.jsonl` に ID・projectId・reason・最初の user 発話の先頭60字・at を追記する。
abandoned には最後の「次に kim がすること」「この後の自動進行」を `nextKim` / `automatic` として残す。
台帳追記に失敗した場合はファイルを元に戻す。

1回500ファイルまで、走査の時間予算4.5秒（プロセス全体で5秒目標）。
途中までならカーソルを保存し、次の実行で続きから走査する。前回起動から5分間はスキップする。
PID付きロックで二重起動を防ぎ、死んだ PID のロックは回収する。
判定不能な不正 JSONL は保持する。巨大な単一行（32MB超）はエラーとして保持する。
次の hook が発火するまで退避は行わないため、閉じてから45秒で必ず消えるという保証ではない。

```sh
node tools/purge-sessions.mjs --dry-run
node tools/purge-sessions.mjs --dry-run --after '<前回出力の nextCursor>'
node tools/purge-sessions.mjs --restore '<sessionId>'
```

`--dry-run` はクールダウンの影響を受けず、ロック・台帳・状態ファイルも書き換えない。
`limited: true` の場合は `nextCursor` を使って残りを確認できる。
復元はクールダウン中でも可能で、復元直後10分は再退避から保護する。

設計参考: [マキモノ「Claude Code のセッション一覧を『閉じたら自動で消える』ようにする」](https://makimono-md.vercel.app/md/claude-code-2)。
常駐ウォッチャーの部分は今回の実装指示に従い単発 hook 起動へ置き換えた。

## スマホ／claude.ai の「Code」一覧（サーバー側）

`--hook` は `tools/purge-remote-sessions.mjs` を6時間ごとに起動し、明示的に閉じたセッションだけをアーカイブする。
クローズ記録は `~/.claude/closed-sessions.json` の `ids` と、`archived-sessions.jsonl` の `reason` が
`closed` または `approved` の行。`abandoned`・`empty` は対象にしない。
帳簿の行は transcript がまだ `projects-archive/` にあるときだけ数える（`--restore` で再開したものは外す）。
帳簿が closed でも、最後の発言の「このセッション:」行が閉じてよい以外（「まだ閉じない」等）なら外す
（2026-10-22 実例: close-session 後に作業を続けたセッションが closed 扱いになっていた）。

対象のローカル transcript を `projects/*/` と `projects-archive/*/` から探し、末尾512 KiBの完全な行だけから
user/assistant のメッセージ UUID を収集する。リモートが未アーカイブ・切断済み・10分以上更新なしの場合、
最新20イベントを取得し、その中で最も新しい UUID 付き user/assistant メッセージを照合する。
その UUID がクローズ済み transcript にある場合だけ退避する。新しい未照合メッセージがある場合や、
UUID がない・取得に失敗した場合は保持する。

イベント取得は1回150件まで、実行時間は約60秒までとし、残りは次回に扱う。
ログには `localSessionId` と `reason: 'closed'` も記録する。
`--dry-run` は一致したタイトルとローカル ID を表示し、POST や状態・ログの書き込みは行わない。

手動確認は `node tools/purge-remote-sessions.mjs --dry-run`。誤ってアーカイブしたものは
`POST /v1/code/sessions/{id}/unarchive` で戻せる（記録は `~/.claude/archived-remote-sessions.jsonl`）。
