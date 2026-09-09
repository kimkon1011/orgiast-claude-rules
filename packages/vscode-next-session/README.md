# Orgiast Next Session

`vscode://orgiast.next-session/start` を受け取り、VS Code の統合ターミナルで Claude CLI を起動する極小拡張です。公式 Claude Code 拡張の URI は初期プロンプトを入力欄へ置くだけで送信しないため、次セッションを操作ゼロで開始する用途に使います。

## インストール

```sh
code --install-extension orgiast-next-session-0.3.1.vsix --force
```

通常は `tools/next-session-launch.mjs --target vscode-ext` が未導入時だけ同梱 VSIX を自動インストールします。

導入済みの版が同梱 VSIX より古い場合も、自動的に `--force` 更新します。

## スマホ Remote Control 用タブ

`vscode://orgiast.next-session/mobile?count=3&name=%E3%82%B9%E3%83%9E%E3%83%9B%E7%94%A8%E3%82%BB%E3%83%83%E3%82%B7%E3%83%A7%E3%83%B3` を開くと、公式 Claude Code の webview タブを指定数まで補充します。既に同じ接頭辞のタブは再利用するため、繰り返し実行しても増殖しません。

設定 `orgiast.nextSession.mobileTabs`（既定 `0`、最大 `10`）を正数にすると VS Code 起動後にも自動補充します。接頭辞は `orgiast.nextSession.mobileTabName`（既定 `スマホ用セッション`）です。

起動直後は Claude Code 拡張のコマンド登録を最長60秒待ち、その後も webview の準備が整うまで最長約2分間再試行します。URI からの補充は従来どおり1回だけ試します。

公式拡張 v2.1.263 の `claude-vscode.renameSessionTab` は名前を第1引数に受け取ることを実体で確認済みです。作成したタブは `スマホ用セッション1` のように自動改名します。`claude-vscode.newConversation` の戻り値は `undefined` のため、タブ一覧の変化を最大5秒待ってから次を作ります。経過は Output の `Orgiast Next Session` に記録します。

URI は外部プロセスやブラウザからも開けるため、`claude` パラメータは実在する絶対パスかつファイル名が `claude` / `claude.exe` の場合だけ実行します。

## アンインストール

```sh
code --uninstall-extension orgiast.next-session
```
