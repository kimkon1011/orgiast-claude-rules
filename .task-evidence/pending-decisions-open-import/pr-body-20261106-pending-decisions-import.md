2026-10-09登録の判断待ち5件は `status: open` で保存されていましたが、朝バッチは `pending` の完全一致で抽出していたため、件数集計・kim-inboxへの取り込みから漏れていました。

共通のstatus正規化で `open` を `pending` と同義として抽出します。保存済みのstatusは読み取り時に変更せず、batched・resolved・closed・done・cancelled・不明なstatusは取り込みません。朝バッチと同じpendingフィルターを使う集計もこの修正を利用します。

回帰テストは5件と新規pendingの同時取り込み、kim-inboxへの保存、処理済み除外、dry-runの無変更、再実行時の重複防止を確認します。実データ本体は変更していません。

検証: Windows Node.jsで対象・関連テストを実行（結果は実行後に追記）。

🤖 Generated with [Claude Code](https://claude.com/claude-code)
