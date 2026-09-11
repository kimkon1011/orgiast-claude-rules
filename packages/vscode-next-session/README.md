# Orgiast Next Session

`vscode://orgiast.next-session/start` を受け取り、VS Code の統合ターミナルで Claude CLI を起動する極小拡張です。公式 Claude Code 拡張の URI は初期プロンプトを入力欄へ置くだけで送信しないため、次セッションを操作ゼロで開始する用途に使います。

## インストール

```sh
code --install-extension orgiast-next-session-0.3.3.vsix --force
```

通常は `tools/next-session-launch.mjs --target vscode-ext` が未導入時に同梱 VSIX を自動インストールします。

導入済みの版が同梱 VSIX より古い場合も、自動的に `--force` 更新します。

## スマホ Remote Control 用タブ

`vscode://orgiast.next-session/mobile?count=3&name=%E3%82%B9%E3%83%9E%E3%83%9B%E7%94%A8%E3%82%BB%E3%83%83%E3%82%B7%E3%83%A7%E3%83%B3` を開くと、公式 Claude Code の webview タブを指定数まで補充します。既に同じ接頭辞のタブは再利用するため、繰り返し実行しても増殖しません。

`recreate=1` を付けると `claude agents --json` の interactive 件数とラベル付きタブ数を比較し、応答セッションの無い余剰タブを閉じて作り直します。自動補充が有効なウィンドウでは、拡張の activate 後（初期化猶予90秒）と、前回チェックから10分以上経過してウィンドウが focused に戻った時（2秒デバウンス）に自己修復します。URI と自動チェックは共通のキューで直列化し、同じ処理の重複要求はまとめます。CLI の失敗・不正な JSON は生存0件と扱わず、既存タブの閉鎖を見送ります。

設定 `orgiast.nextSession.mobileTabs`（既定 `0`、最大 `10`）を正数にすると VS Code 起動後にも自動補充します。接頭辞は `orgiast.nextSession.mobileTabName`（既定 `スマホ用セッション`）です。

起動直後は Claude Code 拡張のコマンド登録を最長60秒待ち、その後も webview の準備が整うまで最長約2分間再試行します。URI からの補充は従来どおり1回だけ試します。

死活判定は件数差による推定です。他の VS Code ウィンドウの interactive セッションも件数に含まれ、個々のタブのブリッジ接続完了を検証するものではありません。

再作成時は対象タブを閉じてから `newConversation` と `renameSessionTab` で元のラベルに戻します。通常の補充で Claude Code タブが1つも無いときは `Claude Code: Open` で最初の1つを開き、2つ目以降は `Claude Code: New Conversation` で補充します。

公式拡張 v2.1.263 の `claude-vscode.renameSessionTab` は名前を第1引数に受け取ることを実体で確認済みです。作成したタブは `スマホ用セッション1` のように自動改名します。`claude-vscode.newConversation` の戻り値は `undefined` のため、タブ一覧の変化を最大5秒待ってから次を作ります。経過は Output の `Orgiast Next Session` に記録します。

URI は外部プロセスやブラウザからも開けるため、`claude` パラメータは実在する絶対パスかつファイル名が `claude` / `claude.exe` の場合だけ実行します。

## アンインストール

```sh
code --uninstall-extension orgiast.next-session
```

## 夜間・スリープ復帰

`tools/nightly-reload-vscode.ps1` は実行中の自動スリープを抑止し、再起動・URI リロード後は20秒ごとに interactive セッションを確認します。ユーザー設定の `mobileTabs`（未設定なら3、0なら復帰待ち無効）に6分以内に達しない場合、`node tools/mobile-sessions.mjs --count N --recreate` を1回実行し、最大2分再確認します。ログは `~/.claude/nightly-reload-vscode.log` の `RESUME-WAIT` / `RESUMED` / `RESUME-FAIL` です。

追加の `OrgiastRcResumeOnWake` タスクはスリープ復帰・ロック解除から90秒後に3タブの復帰を要求します。実行結果は `~/.claude/rc-resume-on-wake.log`、実際のタブ修復結果は拡張の Output に記録します。登録・更新コマンドはルート README に記載しています。

## ビルド

`npm test`、`npm run build`、`npm run package` で検証・VSIX生成を行います。VSIX名は `package.json` の version から決まり、既存PCも `tools/next-session-launch.mjs --target vscode-ext` の既存更新経路で最新版を自動取得します。
