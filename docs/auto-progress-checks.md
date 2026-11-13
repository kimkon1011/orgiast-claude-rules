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

## LINE / Gmail の継続監視

`auto-progress-external-check.mjs` を使う check は、新着があっても完了にしない。30分ごとの watch が新着を message ID で重複排除し、kim-inbox の `ask`（🔴、送信者・投稿時刻・本文先頭200字）と元セッションの再開キューへ保存した後、同じ行の `--since` を最新投稿時刻へ進める。通知失敗時はカーソルを維持して再試行する。期限の指定がなければ登録から14日間監視する。

```sh
node tools/auto-progress.mjs --add-check --session <sessionId> --check "node tools/auto-progress-external-check.mjs --channel line --thread-id <groupId> --since <ISO日時>" --label "LINE返信待ち"
node tools/auto-progress.mjs --add-check --session <sessionId> --check "node tools/auto-progress-external-check.mjs --channel gmail --thread-id <threadId> --mailbox seisaku-team@orgiast.jp --since <ISO日時>" --deadline +7d --label "Gmail返信待ち"
```

Stop hook は「この後の自動進行」に返信待ち・返事待ち・回答待ちがあるとき、同じ会話ターンの `line-group-send.mjs` / `gmail-draft.mjs --send` の成功結果を送信記録と照合して宛先を自動登録する。下書き・dry-run・失敗・他セッションの送信は対象外。同じ宛先の既存監視の期限とカーソルは保持する。

イベントと再開待ちは `~/.claude/external-monitor-events/` に保存される。再開は既存のセッション再開経路を使い、履歴確認と下書きまでに限定する。社外送信や過去の送信約束は実行しない。Gmail の `external-waiting.mjs` は監視中スレッドと通知済み message ID を参照し、同じ新着を重複通知しない。

Windows の `OrgiastAutoProgressWatch` は30分間隔・実行上限29分。`setup.mjs --converge` は既存PCの間隔と実行上限も検査し、登録スクリプト経由で修復する。
