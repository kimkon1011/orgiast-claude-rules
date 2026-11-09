# 監督側の起動と復旧（C3）

## 起動コマンド

C1 実測では Claude CLI 2.1.302 の `claude --help` に `--advisor` は存在しない。`--model` / `--fallback-model` / `--effort` は存在する。現状は次節のフォールバックを使う。

`--advisor` 対応時にのみ有効化する。更新後に次のコマンドで対応と引数形式を確認する。

```powershell
claude --version
claude --help
```

将来の help が `--advisor <model>` 形式と `opus` の指定を明示的にサポートした場合に限り、起動形は次のようになる。これは現行版で実行するコマンドではない。異なる形式ならその版の help に従う。

```powershell
claude --model sonnet --advisor opus
```

助言の発動は [監督側の助言ルール](advisor-rule-snippet.md) の3条件に限定する。`--fallback-model` は助言モデルの指定として扱わない。

## フォールバック（--advisor 非対応時）

PowerShell で監督側を起動する。

```powershell
claude --model sonnet
```

ルールの発動条件に達したときだけ、CLI 内で次を入力する。

```text
/model opus
```

ルールの最小形で文脈を渡し、助言を得た直後に次を入力して戻す。

```text
/model sonnet
```

実装は Codex へ委譲する。API 接続やキー設定は行わない。

## 戻し方

ここでの従来構成は、上記の Sonnet 単独起動とする。この手順は設定ファイルを変更しない。

1. 起動中の Claude CLI の入力欄で次を実行し、セッションを終了する。

   ```text
   /exit
   ```

2. PowerShell に戻ったら次を実行する。`--advisor` を付けず、Sonnet 単独で新しく起動する。

   ```powershell
   claude --model sonnet
   ```

3. 再起動せず Opus から戻すだけなら、CLI 内で次を入力する。

   ```text
   /model sonnet
   ```
