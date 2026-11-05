2026-10-09登録の判断待ち5件は status=open ですが、朝バッチは pending の完全一致で抽出しており、集計・kim-inboxへの取り込みから漏れていました。

共通のstatus正規化でopenをpendingと同義として抽出します。保存済みstatusは読み取り時に変更せず、batched・resolved・closed・done・cancelled・不明なstatusは取り込みません。

回帰テストで5件と新規pendingの取り込み、kim-inbox保存、処理済み除外、dry-run無変更、再実行時の重複防止を確認。Windowsのnode --test（pending-decisions、morning-batch、nightly-health、nightly-health-remediate、kim-inbox、fleet-chase）は154 pass / 0 fail。Linuxの対象テストも12 pass / 0 fail。実データread-backは27件（pending22件＋open5件）。実データ本体は無変更。

🤖 Generated with [Claude Code](https://claude.com/claude-code)
