# Orgiast Next Session

`vscode://orgiast.next-session/start` を受け取り、VS Code の統合ターミナルで Claude CLI を起動する極小拡張です。公式 Claude Code 拡張の URI は初期プロンプトを入力欄へ置くだけで送信しないため、次セッションを操作ゼロで開始する用途に使います。

## インストール

```sh
code --install-extension orgiast-next-session-0.3.4.vsix --force
```

通常は `tools/next-session-launch.mjs --target vscode-ext` が未導入時だけ同梱 VSIX を自動インストールします。

導入済みの版が同梱 VSIX より古い場合も、自動的に `--force` 更新します。

## スマホ Remote Control 用タブ

既定の待機数は1本です。最初のプロンプトによりタブの自然なタイトルが変わると、次の空タブを補充します。閉じた場合も補充します。使用中のタブや既存の余剰タブは閉じません。余剰がある間は追加を停止するため、起動済みの余剰分を削除せずに運用できます。

`~/.claude/mobile-sessions.json` の `{"count": 1}`、または `CLAUDE_MOBILE_STANDBY=1`（環境変数を優先）で1〜10本に設定できます。VS Code の `orgiast.nextSession.mobileTabs=0` は起動時の補充を無効化する既存の設定として残します。

`node tools/mobile-sessions.mjs --count 1` でも URI 経由で補充できます。`--name` は呼出元との互換性のため受け付けますが、タブの改名はしません。公式拡張2.1.278では改名コマンドが入力ダイアログを開き、固定タイトルは使用開始の検出も妨げるためです。待機判定は公式拡張の空セッション名 `Claude Code` に基づきます。待機タブに手動で固定名を付けないでください。旧版が改名済みのタブの未使用判定はできません。

URI、起動時、タブ変更、5秒ごとの補充は同じ処理で直列化します。ウィンドウ間はループバックの39741番ポートを排他制御に使い、1つのウィンドウだけが補充します。ポートの取得に失敗した側は起動しません。起動したタブを確認できない間は追加コマンドを送らず、遅延による重複も防ぎます。

`node tools/mobile-sessions.mjs --dry-run` は状態ファイル（拡張が5秒ごとに更新）から「現在の待機数 / 目標 / 起動する本数」を表示します。起動・設定変更はしません。30秒以上古い状態、未導入・停止中の拡張は `不明` と表示し、0本と誤認しません。WSLからWindows側を確認するときは `ORGIAST_HOME=/mnt/c/Users/uers` を指定します。

この変更はタブの補充を担当します。別の `claude-mobile` サーバーやスケジュールタスクを停止・変更しません。実機の補充には同梱0.3.4 VSIXの導入が必要です。

URI は外部プロセスやブラウザからも開けるため、`claude` パラメータは実在する絶対パスかつファイル名が `claude` / `claude.exe` の場合だけ実行します。

## アンインストール

```sh
code --uninstall-extension orgiast.next-session
```
