aliases: [codex-do, codex, 実装して, 委譲, Codex]

# codex-delegate — 起動から Windows 再検証まで

実測: 起動52回／16セッション、警告28件／15セッション（piped-output 23、shell-wrapped 3、backtick 2）。WSL pass 後の Windows 再検証漏れがあった。出典: `~/.claude/skill-and-loop-redesign-20261028.md` §1。参照: ONBOARDING §1.17–§1.18、[codex-do.mjs の usage](../tools/codex-do.mjs)。

## 起動する

監督は設計・レビュー・検証だけ。実装は Codex へ渡す。指示ファイルには目的・対象・完了条件・禁止事項と、MEMORY.md・関連memoryの失敗パターンを必要分だけ含める。

```text
node tools/codex-do.mjs --prompt-file <指示ファイル> --cwd <対象の絶対パス> --origin unattended --timeout 1800
```

`--timeout <秒>` は既定1800秒だが、呼出しには明示する。指示本文のargv直渡しや `bash -lc` / `sh -c` 等のshell経由のラップをしない。TTYなし、外側のパイプなしで直接起動する。`| head` / `| tail` / `tee` を足さない。wrapper内部のstdin送信・close・stdio pipeはそのまま使う。`--origin unattended` は無人委譲の枠を守る指定。

## 待機・結果回収

1. 起動ツールが返した実行IDで、同じプロセスの完了を待つ。前景で完了するならそのまま回収する。独自のsleepポーリングや同じ指示の重複起動はしない。
2. stdout・stderr・終了コードを回収する。**終了コード75は deferred（上限中）**。出力の `reason`・`retryAt` を保存し、`retryAt` 以降まで再試行しない。失敗や完了に読み替えない。
3. 成功報告だけで完了扱いにせず、対象cwdで差分・変更ファイル・commitを読み戻し、依頼範囲と禁止事項をレビューする。他セッションの変更を混ぜない。

## Windows で再検証する

WSLでテストがpassしていても、監督が Windows の対象リポジトリを作業ディレクトリにして `node --test <関連テスト>` を再実行する。`git diff --check` も確認し、Windowsの実行コマンド・終了コード・結果を報告する。Windowsで未実行なら「Windows検証は未確認」と明記し、WSLの結果をWindows成功として扱わない。
