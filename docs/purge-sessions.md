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

`--hook` は `tools/restore-remote-sessions.mjs` も15分間隔で起動し、直近7日以内に更新された archived のうち、最新20イベントで最新アーカイブの直前2分以内に `system` / `host_exit` がある会話を自動復元する（時計差としてアーカイブ後1秒まで許容）。アーカイブイベントが取得範囲に無い場合は `host_exit` の有無で判定する。
空タイトル・`remote-control-` / `desktop-` / `会話なし` で始まる待機枠、purge の退避記録にある ID、最新 user/assistant の UUID が明示クローズ済みの会話は除外する。
復元は `unarchived-remote-sessions.jsonl` に記録し、同じ ID は前回の復元時刻より新しい `host_exit` がある場合だけ戻すため、復元後の手動アーカイブを尊重する。
一覧は `next_cursor` で最大30ページ、イベント取得150件・60秒まで。手動確認は `node tools/restore-remote-sessions.mjs --dry-run`（クールダウンを無視し、タイトル一覧の JSON を出力。POST・書き込みなし）。

`--hook` は `tools/sync-remote-archives.mjs` を5分ごとに起動し、導入後のサーバー側アーカイブを PC の退避帳簿へ同期する。再開済み・復元済みの会話は除外し、既存の live / VSCode 参照 / 直近更新の保護を通して退避する。
直前2分以内に `host_exit` がある archived（PC 側終了による本体の自動アーカイブ）は退避しない。
試算は `node tools/sync-remote-archives.mjs --dry-run --since <ISO>`。`purge-sessions.mjs --restore <id>` で復元すると `kept` に入り再同期を防ぐ。サーバー側の手動アーカイブと致命的エラー由来の archived は区別できない。
