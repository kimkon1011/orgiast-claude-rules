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

## 再ログイン

401／refresh token revoked の場合、まず Windows／WSL の生きている認証情報を確認して複製する。auth.json の存在だけで有効と判断せず、複製元で `codex exec` の rc=0 を実測する。GH_TOKEN／keyserve 等を使える CLI も既存の鍵を先に使う。鍵の値は表示しない。

複製元も失効していれば、Claude が Windows の PowerShell で次をバックグラウンド起動する。`<login-script>` は Claude が作成するスクリプトの絶対パス。user にコードやコマンドを入力させない。

```powershell
# <login-script> の内容（stdout を捕捉できるよう成功メッセージもログへ）
codex login *> "$env:TEMP\codex-login.log"
exit $LASTEXITCODE
# Claude が別プロセスで起動
Start-Process powershell.exe -ArgumentList '-NoProfile', '-File', '<login-script>' -PassThru
```

ブラウザが自動で開いたら user には承認ボタンを1回だけ頼む。「今やりますか？」を先に聞かない。Claude はプロセスとログを確認し、出力に `Successfully logged in` が出て終了コード0になるまで待機する。失敗を成功扱いしてコピーしない。

成功後、Claude が Windows から以下を実行する（`<user>` は実際の Windows ユーザー名に置換、WSL 側の `~/.codex` がなければ先に作成）。

```text
wsl -e bash -lc 'cp /mnt/c/Users/<user>/.codex/auth.json ~/.codex/auth.json && chmod 600 ~/.codex/auth.json'
```

最後に Windows と WSL のそれぞれで `codex exec --skip-git-repo-check -s read-only "Reply with OK only"` を1回実行し、各 rc=0 を記録する。認証ファイルのコピー成功だけでは完了にしない。

2026-11-24〜25 の実例では WSL 起動に1〜2分かかり、device-auth の提示が遅れて15分期限のコードが3回連続で期限切れになった。Windows のブラウザ型ログインと auth.json 複製で復旧した。

`--device-auth` は①生きている認証情報の複製②Windows／ネイティブのブラウザ型ログインが実測で不可の時だけ。理由を `[CODE-INPUT-UNAVOIDABLE: 試した①②の経路と結果]`（中身10文字以上）で示す。発行直後にコードと残り期限を即提示し、期限が切れたら Claude が自動再発行する。先に「今やる」と返答させてから準備を始めない。
