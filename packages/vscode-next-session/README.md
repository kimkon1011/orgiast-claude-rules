# Orgiast Next Session

`vscode://orgiast.next-session/start` を受け取り、VS Code の統合ターミナルで Claude CLI を起動する極小拡張です。公式 Claude Code 拡張の URI は初期プロンプトを入力欄へ置くだけで送信しないため、次セッションを操作ゼロで開始する用途に使います。

## インストール

```sh
code --install-extension orgiast-next-session-0.1.1.vsix --force
```

通常は `tools/next-session-launch.mjs --target vscode-ext` が未導入時だけ同梱 VSIX を自動インストールします。

URI は外部プロセスやブラウザからも開けるため、`claude` パラメータは実在する絶対パスかつファイル名が `claude` / `claude.exe` の場合だけ実行します。

## アンインストール

```sh
code --uninstall-extension orgiast.next-session
```
