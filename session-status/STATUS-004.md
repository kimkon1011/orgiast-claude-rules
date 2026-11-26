# session-status  PC=004  host=004MINPAKU  updated 2026-11-27 06:13 JST

- claude auth: {"at":"2026-11-26T21:13:13.543Z","event":"launch_allowed","reason":"below_cap","activeCount":0,"limit":2,"staleHours":3,"abandoned":[]} { "loggedIn": true, "authMethod": "claude.ai", "apiProvider": "f
- 案件数: 17

- 004・cc-probe-1125・停止・最終更新 11/25 12:12、STATUS.mdなし・期限なし・次:作業フォルダを確認して続きを進める
- 004・codex-redispatch・金さん待ち・渡し直すはずだった指示書（codex-hourly-change-gate.md）の実装は fix/hourly-change-gate に 86a6652c までコミット済みで、渡し直しは不要。Windows で session-cap-guard.test.mjs は 22/22 合格、diff --check も問題なし（2026-11-27 深夜3時・期限なし（元の期限 2026-11-28 07:11 の作業は完了）・次:kim-inbox ki-20261126001009-0ddc（main への反映・全PC配布）の承認が出たら、pr-land で着地させる
- 004・codex-token-refresh・進行中・Codex のアクセストークンの期限は 2026-11-27 11:57 JST（auth.json の exp、発行は 11/17 11:57 JST）。11/27 04:07 に Windows で codex exec を実行すると rc=0（OK）だったが、Codex 0.169 は期限前には自分から更新しないため、last_refresh は 11・期限2026-11-27 12:30 JST（失効の確認）・次:11/27 12:00 JST 以降に `codex exec --skip-git-repo-check -s read-only "Reply with OK only"` を Windows で実行する（WSL でも1回）。rc=0 で、auth.json の last_refresh が 11/27 以降になっていれば完了。401 や refresh
- 004・local-seo-1125・停止・最終更新 11/25 15:21、STATUS.mdなし・期限なし・次:作業フォルダを確認して続きを進める
- 004・loop-check-1125・金さん待ち・最終更新 11/25 15:44、STATUS.mdなし、REPORTあり、金さん待ちの記述あり・期限なし・次:金さんの判断を待つ
- 004・loop-check-1125-lahaina・金さん待ち・最終更新 11/25 15:43、STATUS.mdなし、REPORTあり、金さん待ちの記述あり・期限なし・次:金さんの判断を待つ
- 004・merci-autosend-1125・完了・最終更新 11/25 10:25、STATUS.mdなし、DONEあり、REPORTあり、ログに上限・ログアウト・エラー、金さん待ちの記述あり・期限なし・次:なし
- 004・minpaku-okazaki-check-1124・停止・最終更新 11/24 14:37、STATUS.mdなし・期限なし・次:作業フォルダを確認して続きを進める
- 004・minpaku-price-1124・停止・最終更新 11/24 09:43、STATUS.mdなし・期限なし・次:作業フォルダを確認して続きを進める
- 004・nf-toho-1110-1124・停止・最終更新 11/24 12:20、STATUS.mdなし、REPORTあり・期限なし・次:作業フォルダを確認して続きを進める
- 004・okazaki-line-1125・完了・最終更新 11/25 10:16、STATUS.mdなし、DONEあり、REPORTあり、ログに上限・ログアウト・エラー・期限なし・次:なし
- 004・STATUS・金さん待ち・物件別損益のスプレッドシート（6タブ）と価格・清掃費の変更案は完成。価格変更の承認が未回答（kim-inbox ki-20261126122609-f9dc）。あわせて、成果物への kim@orgiast.jp 編集権限の付与が3経路とも拒否され、3億円計画シート（1Qa5bPpvjgpm2lFPfeG08jVMem1FWk1QkbsCHSf5eS4o）も読・期限なし（打ち手13のシート上の期限は 2026-11-20 で経過済み）・次:「2（A＋B）」など承認が返ったら、設定シート B2（メルシアター上限価格 14,100→15,500）と Beds24 roomTypes 554789 の cleaningFee（5,000→12,000）を書き換え、pricing-decisions.json に決定・reviewBy を追記し、Beds24 と Airbnb の実表示で読み戻す。決め
- 004・plan3oku-13-minpaku-1126・停止・最終更新 11/26 21:38、STATUS.mdなし・期限なし・次:作業フォルダを確認して続きを進める
- 004・reply-drafts-1125・停止・最終更新 11/25 19:09、STATUS.mdなし、run.logあり・期限なし・次:作業フォルダを確認して続きを進める
- 004・rescue-triage-20261127・完了・11/26〜11/27 の rescue ブランチ24本を仕分け済み。取りこぼしなし（3本は PR #2841 が OPEN で進行中）・期限なし・次:要確認2本（231402 lane-doctor.test.mjs +16行・031604 x-ai-tips-collect.mjs）の中身を夜間か対話セッションで見る
- 004・tasks・停止・最終更新 11/24 09:30、STATUS.mdなし・期限なし・次:作業フォルダを確認して続きを進める
- 004・toho-fax-ingest・送信済み・2026-11-26 17:28:32 JST、西田直哉さんの LINE 個人トークへ、承認済み全文を1回送信（Beeper message id 47900）。文面は ask-20261125.md の全文と一致。再送しない。・期限2026-11-27 12:00・次:西田さんの返事を待つ。11/12 18時〜11/18 11時（受信番号 3780〜3972）の抜けの扱いは返事で決める
