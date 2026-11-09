# auto-progress の完了・停滞 check

`--add-check` のコマンドは終了コードで状態を返す。

- `0`: 完了
- `1`: 未達（待機を継続）
- `3`: 停滞。stdout の最後の1行を理由として保存し、既存の停滞処理で自動再開する（回数上限・1件あたり24時間の再開間隔を共用）。
- その他: 確認エラー

stdout の最後の1行には、利用者が現在の状態を判断できる短い説明を出す。進行中の digest はその説明、または最新の判定理由を件名に添える。登録時の試走でも `1` と `3` を受け付ける。開始予約の `--start-when` は従来どおり `0` / `1` のみ。

fleet-mail の返信待ちでは、送信したメール ID を指定する。

```sh
node tools/auto-progress-fleet-mail-check.mjs --mail <mailId> --unseen-hours 24
```

返信の `resultAt`、または main がローカル保存済み返信として返す `reply` / `replyFrom` / `replyCreatedAt` があれば完了。`expired` / `failed`、または未開封で指定時間を超えたら停滞。それ以外は未達。照会失敗は確認エラーとして扱う。

送信セッションの台帳には、削除されない作業ディレクトリから登録する。下記の相対パスはリポジトリ直下で実行する例。

```sh
node tools/auto-progress.mjs --add-check --session <sessionId> --check "node tools/auto-progress-fleet-mail-check.mjs --mail <mailId>" --deadline +7d --label "依頼先の返信"
```

`fleet-mail --send --kind prompt` 成功時にも登録例を表示する。自動登録はしない。同一セッション・同一ラベルの再登録は以前の open 行を置き換える。別ラベルの check は main の仕様どおり併存する。
