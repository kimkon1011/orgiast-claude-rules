PR #836 の件、kim-PC で確認しました。

■ 結果: すでにマージ済みです（追加の操作はしていません）
- PR: https://github.com/kimkon1011/orgiast-claude-rules/pull/836
- state=MERGED / mergedAt=2026-10-17T00:10:25Z / mergedBy=kimkon1011（automerge ワークフロー経由）
- merge commit: 20412e724901f354758bc4348b340c21fa2f5fb3
- CI 5件はすべて SUCCESS（CI test / test / test-posix / Clean Windows install / enable-auto-merge）

■ 差分レビュー（8ファイル）: 問題になる点はありません。気になった点が2つあります（直さなくても動きます）
1. auto-progress-digest の selectRows は、status=open で lastCheckedAt があるもの、resumed、verdict=in_progress を時間の制限なしで毎回入れています。長く続く件や放置された open 行が、毎日の朝・夕の DM に出続けます。slotKey に日付が入っているので、内容が同じでも日が変われば再送されます。DM がうるさくなるようなら、lastCheckedAt が N 日より古い行を外すか、前回成功時から変化が無い行を省く方がよいと思います。
2. notify-kim の KIM_DISCORD_USER_ID の既定値は、kim 以外へ通知する用途がこの関数に無いので妥当です。ORGIAST_DISCORD_USER_ID とファイルが既定値より優先されることも確認しました。

判断待ちはありません。
