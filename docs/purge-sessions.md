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
| approved | 最後の assistant が「このセッション: アーカイブしてよい」、以降に user 発話なし、10分以上 | JSONL 最終行の timestamp |
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
