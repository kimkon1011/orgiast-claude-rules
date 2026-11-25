# 停止 PR の修復とセッション内の進捗まとめ

`config/stuck-pr-sweeper.json` の指定2リポジトリに、既存の `tools/feedback-apps.json` と `tools/cron-watch.json` にある自前リポジトリを加える。所有者は kimkon1011 に限定し、修復対象の作成者は設定の社内アカウントのみ。fork・draft は対象外。

`node tools/stuck-pr-sweeper.mjs --dry-run` は GitHub を照会して候補の番号・件名・理由を JSON に表示する。台帳作成・clone・修復・通知・マージは行わない。照会失敗を空の正常結果と扱わず、errors と exit 1 で返す。

- CI の失敗完了から3時間、auto-merge の有効化から12時間、レビュー待ちでも失敗でもない OPEN が作成から24時間で候補にする。コメントの更新時刻では時計をリセットしない。
- kim-PC の `OrgiastStuckPrSweeper` が 00:17 起点・3時間間隔で実行する。setup --converge の既存 scheduled-task 修復経路に登録。別PCでは実行しない。
- 1巡回最大4件、1 PR 最大2回。`~/.claude/state/stuck-pr-sweeper.json` に実行前から試行・head・失敗ログ・結果を保存する。中断した試行も上限に数える。同時巡回はPIDロックで拒否し、死んだPIDは次回回収する。
- 修正は PR ごとの独立 clone で codex-do に指示書ファイルを渡し、同じブランチへ通常 push する。未コミットの修正は捨てない。exit 0 を修復成功に数えず、次の巡回で GitHub の状態を確認する。
- auto-merge が明示的に有効な PR だけ、全チェック成功・レビュー条件を確認したうえで `node tools/pr-merge.mjs` を使う。修復子プロセスはマージしない。マージ済み・クローズ済みは個別照会して台帳を閉じる。
- 2回後も解消しなければ、原因・2回の結果・判断理由を kim-inbox の ask に1件だけ登録する。登録済み項目の識別子を再利用し、保存直前の異常終了でも増殖させない。kim-inbox がない環境は auto-progress 台帳へ追記する。Discord は使用しない。

進捗表示は既存の auto-progress-inbox-hook（SessionStart / UserPromptSubmit）から `sessionDigest` を呼ぶ。kim-PC の実台帳から kim 所有の未完了項目を選び、期限切れ・24時間以内の期限・状態変化の順で最大5件だけ、何が・現在の状態・次の担当と作業を1行で表示する。日本時間の1日1回で、同時セッションをロックし、表示した項目だけ状態を記録する。旧定時ダイジェストからの kim 宛配信は停止する。

検証: `node --test tools/stuck-pr-sweeper.test.mjs tools/auto-progress-session-digest.test.mjs tools/auto-progress-inbox-hook.test.mjs tools/auto-progress.test.mjs tools/fleet-scope.test.mjs tools/setup-manifest.test.mjs`。
