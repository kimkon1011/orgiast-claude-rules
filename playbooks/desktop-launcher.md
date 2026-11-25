aliases: [desktop-launcher, make-desktop-launcher, ダブルクリック, デスクトップファイル]

# desktop-launcher — 作成・成否確認・片付け

実測: 22回／7セッション、7/7でソースかhelpを読み直した。FULL-STEPS差し戻し32件／13セッション。出典: `~/.claude/skill-and-loop-redesign-20261028.md` §1。ONBOARDING §1.1・§1.5.1（手順を1個に畳む）と [実装](../tools/make-desktop-launcher.mjs) に基づく。

## 作成する

user の操作が2つ以上残る時に、前提確認→本処理→自動検証→後続処理を1個に畳む。完了済み工程はスキップするスクリプトを先に作り、内容・実行先・目的を説明する。本人の理解・同意は省略しない。

```text
node tools/make-desktop-launcher.mjs --name <name> (--ps-file <abs.ps1> | --command-file <abs.txt>) [--verify-cmd <pwsh>]
```

`<name>` は **`--name` で渡す**（位置引数は現行CLIが受理しない）。括弧・縦棒は選択を表すので実際には書かない。Windows 上で実行し、`--ps-file` と `--command-file` はどちらか1つ。後者のテキスト本文も PowerShell スクリプトであり、管理用ps1へコピーされる。

例（引数は実在する絶対パスに置換）:

```text
node tools/make-desktop-launcher.mjs --name "設定確認" --ps-file "C:\work\setup.ps1" --verify-cmd "if (-not (Test-Path 'C:\work\result.json')) { exit 1 }"
```

`--verify-cmd` は本処理成功後に走る PowerShell 検証。対象アプリの読み戻し・値の一致を検査し、不一致は非0で終了させる。例のファイル存在確認だけで業務結果の成功にしない。

## 結果を渡して片付ける

- 作成時の JSON の `cmdPath` が実際のデスクトップファイル。固定のDesktopパスを推測せず、表示されたパス・実行内容を渡す。作成成功は本処理の成功とは別。
- ダブルクリック後の画面に `Exit code: 0` と `OK`、失敗時には非0と `ERROR` が出て、キー入力まで残る。`ERROR` なら画面のエラーを Claude に伝えてもらい、user に原因調査を頼まない。
- 実行後は Claude が成果物を読み戻して確認し、`node tools/make-desktop-launcher.mjs --name "設定確認" --remove` で片付ける。JSON の `removed` と対象パスを確認する。削除対象はcmdと管理用ps1で、元の `--ps-file` は保持される。
