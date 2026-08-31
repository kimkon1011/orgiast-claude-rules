# Claude Code バックアップの復元手順（Windows）

> ⚠️ このバックアップには API キー、認証情報、会話履歴が入っています。フォルダや zip を絶対に他人と共有しないでください。

## バックアップがある場所

Google Drive デスクトップを開き、「マイドライブ」→「Claude-Backups」→元のパソコン名のフォルダへ進みます。`claude-パソコン名-YYYY-MM-DD.zip` がバックアップです。通常は日付が最も新しい zip を使います。

zip の中には `.claude` と `home` の2つのフォルダがあります。`.claude` には Claude Code の設定、hooks、skills、memory、会話 transcript などが入り、`home` にはホーム直下の `.claude.json`、`.claude.json.backup`、`.codex` が入っています。

## 新しいパソコンへ戻す手順

1. 最初に Claude Code 本体を入れます。Windows の「スタート」を押して `PowerShell` と入力し、「Windows PowerShell」を開きます。`npm install -g @anthropic-ai/claude-code` と入力して Enter キーを押し、処理が終わるまで待ちます。Visual Studio Code を使う場合は、左側の「拡張機能」を開いて `Claude Code` を検索し、Anthropic の拡張機能を「インストール」する方法でも構いません。
2. バックアップ内の `.codex` も戻す場合は、同じ PowerShell で `npm install -g @openai/codex` を実行し、Codex CLI を先に入れます。
3. Claude Code、Codex、Visual Studio Code、PowerShellなどのターミナルをすべて閉じます。復元中にファイルが書き換わるのを防ぐためです。
4. Google Drive の上記フォルダで、復元する最新の zip を右クリックし、「コピー」を選びます。
5. Windows の「ダウンロード」フォルダを開き、何もない場所を右クリックして「貼り付け」を選びます。コピーが終わるまで待ちます。
6. 貼り付けた zip を右クリックし、「すべて展開」を選びます。「完了時に展開されたファイルを表示する」にチェックを入れ、「展開」を押します。
7. 展開後に開いたフォルダで `.claude` と `home` の2つのフォルダが見えることを確認します。`.claude` を開き、`CLAUDE.md`、`settings.json`、`projects` があることも確認します。
8. エクスプローラー上部のアドレス欄をクリックし、`%USERPROFILE%` と入力して Enter キーを押します。
9. `.claude` フォルダが既にある場合は、右クリックして「名前の変更」を選び、`.claude-before-restore` に変えます。問題があった場合に元へ戻せるよう、すぐには削除しません。
10. 手順7で確認したバックアップ側の `.claude` フォルダを右クリックして「コピー」を選び、手順8で開いた `%USERPROFILE%` の何もない場所を右クリックして「貼り付け」を選びます。これで `%USERPROFILE%\.claude` に戻ります。
11. バックアップ側の `home` フォルダを開きます。Ctrl+A ですべて選択し、Ctrl+C でコピーします。
12. 手順8の `%USERPROFILE%` へ戻り、何もない場所で Ctrl+V を押します。同じ名前のファイルをどうするか聞かれたら「ファイルを置き換える」を選び、`.claude.json` を上書きします。`.claude.json.backup` と `.codex` もホーム直下へ戻ります。
13. Claude Code を起動します。ログインを求められた場合は画面の案内どおり再ログインします。PC 固有のアクセス許可や Google/外部サービスの OAuth は、期限切れの場合だけ再認証が必要です。
14. Claude Code が通常どおり開き、MCP、skills、過去のプロジェクトが見えることを確認します。Codex を使う場合は Codex CLI も起動できることを確認します。問題がなければ、後日 `.claude-before-restore` を削除できます。

復元後もバックアップを続けるには、`orgiast-claude-rules` リポジトリの `tools\register-claude-backup-task.ps1` を実行して日次タスクを登録します。
