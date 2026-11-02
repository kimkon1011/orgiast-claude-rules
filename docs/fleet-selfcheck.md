# 遠隔の読み取り専用自己点検

`node tools/fleet-selfcheck.mjs` は身元、配布物、case-handoff の catalog と直近案件の resume バイト数、Gmail・Drive・Discord・LINE の読み取り結果を Markdown 表にする。結果は「読めた」「失敗（エラー原文。秘密値は伏字）」「経路なし」。一部の診断が失敗しても残りを続け、表を返せれば終了コードは0。

自己点検本体は保存・設定変更・サブプロセス起動・送信を行わない。case-handoff の保存付き catalog/resume コマンドは呼ばず GET API を読む。Google の OAuth トークン取得だけ POST を使い、Gmailはreadonlyスコープ。Driveは既存DWD委任済みのdriveスコープを使うが、実行はGET files.listだけ（drive.readonlyは既知の未委任）。API に到達したかはファイルの有無だけでは判定しない。

- Gmail: seisaku-team@orgiast.jp の messages.list。既存 SA/DWD または Gmail token relay を使う。
- Drive: 同アカウントの files.list を SA/DWD で読む。案件APIの成功からDrive全体の権限は推定しない。
- Discord: Botで #claude-code（なければ最初のテキストチャンネル）の履歴1件を読む。他チャンネルの権限は未検証。
- LINE: 既存の line-openchat 月次 JSONL の最新ファイルの最終発言を実際に読む。保存済み履歴の経路であり、ライブ受信の確認ではない。LINE_STORE_DIR 指定にも対応。
- 案件: 更新日時・このPCの案件紐付け/取得済みSTATE・LOGの最終利用日時順に1件。両方の日時がない場合だけcatalog返却順を使い、直近か未確認と表に表示する。

## fleet-mail から依頼する

```sh
node tools/fleet-selfcheck.mjs --prompt > /tmp/fleet-selfcheck-prompt.txt
node tools/fleet-mail.mjs --send --to 作業用008 --kind prompt --body-file /tmp/fleet-selfcheck-prompt.txt --why "作業用008 引継ぎ自己点検"
```

送信されたIDで `node tools/fleet-mail.mjs --sent-status <ID>` を実行し、deliveredAt と resultAt/resultBody を確認する。送信成功だけで完了と扱わない。

許可リストは tools/lib/fleet-selfcheck-prompt.mjs の完全一致する固定本文だけ。`selfcheck` という単語だけの本文、追加指示付きの本文は例外にならない。設定配布ガードの他の判定は変更しない。`--force` は不要。

受信側は既存の prompt オプトインを確認してから専用関数を直接実行する。Claude CLI・LLMを必要としない。fleet-mail の既存の実行ロック、結果保存、返信・再送制御はそのまま使う（これらは自己点検本体とは別の配送処理）。配布は通常の setup --converge 経由。旧受信側の汎用読み取りエージェントには Bash 実行権限がないため、新しい受信コードの配布完了も必要。

資格情報の不存在は「経路なし」、配置済みファイルの破損・APIの拒否・通信エラーは「失敗」。自動修復は自己点検に混ぜず、結果で原因を確認した後、既存の keyserve/setup 配布経路で行う。
