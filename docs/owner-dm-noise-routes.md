# 持ち主DMの経路と検証結果

共通の振り分けは `tools/lib/owner-dm-policy.mjs`。notifyOwner / notifyKim / deliverKim と feedback の sendDiscordDm が利用する。ClaudeInboxBridge はBotの名前であり、別の送信APIではない。

| 呼び出し元 | kind |
| --- | --- |
| `tools/ai-receipt-scan.mjs` | 未指定は automatic（保留）。明示的な ask / kimActionRequired、または本文の具体的な質問は action |
| `tools/aihaijin-digest.mjs` | 未指定は automatic（保留）。明示的な ask / kimActionRequired、または本文の具体的な質問は action |
| `tools/api-billing-guard.mjs` | 未指定は automatic（保留）。明示的な ask / kimActionRequired、または本文の具体的な質問は action |
| `tools/assign-app-gate-fire.mjs` | 未指定は automatic（保留）。明示的な ask / kimActionRequired、または本文の具体的な質問は action |
| `tools/auto-progress-check.mjs` | 人の依頼の達成 done-requested、それ以外 automatic |
| `tools/auto-progress-digest.mjs` | 朝夕の digest（1回1通） |
| `tools/auto-progress-watch.mjs` | 判断依頼 action、人の依頼完了 done-requested、検出・バックログ・未達・待ち状況 automatic |
| `tools/auto-progress.mjs` | 未指定は automatic（保留）。明示的な ask / kimActionRequired、または本文の具体的な質問は action |
| `tools/auto-session-streak-watch.mjs` | 未指定は automatic（保留）。明示的な ask / kimActionRequired、または本文の具体的な質問は action |
| `tools/autopilot-tick.mjs` | automatic。具体的な判断待ち質問は action |
| `tools/cost-improve-loop.mjs` | 未指定は automatic（保留）。明示的な ask / kimActionRequired、または本文の具体的な質問は action |
| `tools/cost-monthly-report.mjs` | 未指定は automatic（保留）。明示的な ask / kimActionRequired、または本文の具体的な質問は action |
| `tools/cost-weekly-improve.mjs` | 未指定は automatic（保留）。明示的な ask / kimActionRequired、または本文の具体的な質問は action |
| `tools/daily-notices.mjs` | 未指定は automatic（保留）。明示的な ask / kimActionRequired、または本文の具体的な質問は action |
| `tools/decision-watch.mjs` | 未指定は automatic（保留）。明示的な ask / kimActionRequired、または本文の具体的な質問は action |
| `tools/discord-autoreply.mjs` | 未指定は automatic（保留）。明示的な ask / kimActionRequired、または本文の具体的な質問は action |
| `tools/evening-digest.mjs` | 未指定は automatic（保留）。明示的な ask / kimActionRequired、または本文の具体的な質問は action |
| `tools/expense-leak-check.mjs` | 未指定は automatic（保留）。明示的な ask / kimActionRequired、または本文の具体的な質問は action |
| `tools/feedback-100oku.mjs` | 未指定は automatic（保留）。明示的な ask / kimActionRequired、または本文の具体的な質問は action |
| `tools/feedback-zero-sweep.mjs` | 未指定は automatic（保留）。明示的な ask / kimActionRequired、または本文の具体的な質問は action |
| `tools/fleet-chase.mjs` | 未指定は automatic（保留）。明示的な ask / kimActionRequired、または本文の具体的な質問は action |
| `tools/fleet-convergence-watch.mjs` | 未指定は automatic（保留）。明示的な ask / kimActionRequired、または本文の具体的な質問は action |
| `tools/fleet-lane-health-report.mjs` | 未指定は automatic（保留）。明示的な ask / kimActionRequired、または本文の具体的な質問は action |
| `tools/fleet-mail-watchdog.mjs` | 未指定は automatic（保留）。明示的な ask / kimActionRequired、または本文の具体的な質問は action |
| `tools/gate-runtime.mjs` | 未指定は automatic（保留）。明示的な ask / kimActionRequired、または本文の具体的な質問は action |
| `tools/gemini-budget-guard.mjs` | 未指定は automatic（保留）。明示的な ask / kimActionRequired、または本文の具体的な質問は action |
| `tools/interaction-rollout.mjs` | 未指定は automatic（保留）。明示的な ask / kimActionRequired、または本文の具体的な質問は action |
| `tools/internal-audit.mjs` | 未指定は automatic（保留）。明示的な ask / kimActionRequired、または本文の具体的な質問は action |
| `tools/keyserve-enroll.mjs` | 未指定は automatic（保留）。明示的な ask / kimActionRequired、または本文の具体的な質問は action |
| `tools/kim-push-relay.mjs` | 未指定は automatic（保留）。明示的な ask / kimActionRequired、または本文の具体的な質問は action |
| `tools/lane-doctor.mjs` | 未指定は automatic（保留）。明示的な ask / kimActionRequired、または本文の具体的な質問は action |
| `tools/lane-repair-log.mjs` | 未指定は automatic（保留）。明示的な ask / kimActionRequired、または本文の具体的な質問は action |
| `tools/messenger-watch.mjs` | 未指定は automatic（保留）。明示的な ask / kimActionRequired、または本文の具体的な質問は action |
| `tools/mobile-standby-status.mjs` | 未指定は automatic（保留）。明示的な ask / kimActionRequired、または本文の具体的な質問は action |
| `tools/model-scout.mjs` | 未指定は automatic（保留）。明示的な ask / kimActionRequired、または本文の具体的な質問は action |
| `tools/morning-batch.mjs` | 未指定は automatic（保留）。明示的な ask / kimActionRequired、または本文の具体的な質問は action |
| `tools/nightly-health-remediate.mjs` | 未指定は automatic（保留）。明示的な ask / kimActionRequired、または本文の具体的な質問は action |
| `tools/nightly-health.mjs` | 未指定は automatic（保留）。明示的な ask / kimActionRequired、または本文の具体的な質問は action |
| `tools/nightly-kpi.mjs` | 未指定は automatic（保留）。明示的な ask / kimActionRequired、または本文の具体的な質問は action |
| `tools/notify-kim.mjs` | 未指定は automatic（保留）。明示的な ask / kimActionRequired、または本文の具体的な質問は action |
| `tools/notify-owner.mjs` | action / done-requested / digest、未指定は automatic |
| `tools/owner-inbox-hook.mjs` | 未指定は automatic（保留）。明示的な ask / kimActionRequired、または本文の具体的な質問は action |
| `tools/process-hygiene.mjs` | 未指定は automatic（保留）。明示的な ask / kimActionRequired、または本文の具体的な質問は action |
| `tools/proposal-session.mjs` | 未指定は automatic（保留）。明示的な ask / kimActionRequired、または本文の具体的な質問は action |
| `tools/provider-balance.mjs` | 未指定は automatic（保留）。明示的な ask / kimActionRequired、または本文の具体的な質問は action |
| `tools/quota-sweep.mjs` | 未指定は automatic（保留）。明示的な ask / kimActionRequired、または本文の具体的な質問は action |
| `tools/rescue-policy.mjs` | 未指定は automatic（保留）。明示的な ask / kimActionRequired、または本文の具体的な質問は action |
| `tools/sga-autopilot.mjs` | 未指定は automatic（保留）。明示的な ask / kimActionRequired、または本文の具体的な質問は action |
| `tools/stale-work-watch.mjs` | 未指定は automatic（保留）。明示的な ask / kimActionRequired、または本文の具体的な質問は action |
| `tools/stall-sweeper.mjs` | 未指定は automatic（保留）。明示的な ask / kimActionRequired、または本文の具体的な質問は action |
| `tools/stalled-session-resume.mjs` | 未指定は automatic（保留）。明示的な ask / kimActionRequired、または本文の具体的な質問は action |
| `tools/stuck-dialog-watch.mjs` | 未指定は automatic（保留）。明示的な ask / kimActionRequired、または本文の具体的な質問は action |
| `tools/unattended-job-audit.mjs` | 未指定は automatic（保留）。明示的な ask / kimActionRequired、または本文の具体的な質問は action |
| `tools/vehicle-inspection-watch.mjs` | 未指定は automatic（保留）。明示的な ask / kimActionRequired、または本文の具体的な質問は action |
| `tools/x-ai-tips-collect.mjs` | 未指定は automatic（保留）。明示的な ask / kimActionRequired、または本文の具体的な質問は action |
| `tools/feedback-progress-notify.mjs` | 質問 answered は action（全文添付）、進捗とリマインダーは automatic |
| `tools/feedback-nag.mjs` | 持ち主宛の巡回 automatic、その他の報告者宛は対象外 |
| `tools/feedback-done-notify.mjs` | HTTP リレー。リモート実装は未確認・未変更 |

変更ファイル: tools/notify-owner.mjs、tools/notify-kim.mjs、tools/auto-progress-watch.mjs、tools/auto-progress-check.mjs、tools/auto-progress-digest.mjs、tools/autopilot-tick.mjs、tools/feedback-nag.mjs、tools/feedback-progress-notify.mjs、tools/lib/owner-dm-policy.mjs、tools/lib/owner-dm-digest.mjs、tools/owner-dm-policy.test.mjs、本書。

制限: 日次上限は同じhome内で持ち主別に共有する。複数PCの別home間で通数は共有しない。第1回時点では既存テストは変更していない（第2回の更新は後述）。

## 第1回検証（未完了だった時点の履歴）

新規回帰: 10 pass / 0 fail。関連一式（新規含む）: 532件、436 pass / 96 fail / skip 0。EPERM・EACCES の記録はなく、サンドボックス由来として除外した失敗はない。完了条件未達。既存テストの削除・skip・期待値変更は行っていない。主に未指定kindの即時送信、無人完了の即時送信、大量項目の分割DMなどの旧期待に関する失敗を含むが、全96件を仕様衝突だけとは断定していない。

- not ok 23 - watch: before deadline stays open; overdue queues once and retries DM; recovery sends completion once
- not ok 34 - digest: hundreds of rows across three categories are all delivered in 1800-char chunks
- not ok 72 - kim summaries never use the old outbound digest delivery
- not ok 85 - 定期digestに開始予約と期限超過が出る
- not ok 93 - timeoutを繰り返した実例は2回でSheetとDMまとめへ一度報告される
- not ok 121 - digest: DM未達を成功にせず、公開webhookへ送らない
- not ok 130 - digest: 大量の完了も全件を名前で出し、次回へ回さない
- not ok 133 - digest routes each promise only to its owner
- not ok 134 - digest: owner 未記録の行は自PCの持ち主へ送り、owner 空で notifyOwner を呼ばない
- not ok 136 - digest: 無人処理は数だけ、なし系を正規化し、埋め込まれた識別子も本文に出さない
- not ok 140 - digest: 同じ判定は再送せず、判断依頼の追加と判定変化だけを次の枠で送る
- not ok 141 - digest: 長文でも件の途中で切らず、成功した宛先を失敗後に再送しない
- not ok 142 - digest: 長文でも全件を名前で出し、1800字を超えたら分割して届ける
- not ok 146 - digest: noop はDMにも件数にも含めない
- not ok 148 - digest: checkなしも新形式で集約しdoneは一度だけ
- not ok 149 - digest: 待機理由だけでは依頼せず、具体的なkimの操作がある場合のみ通知
- not ok 152 - digest(要件5): 判断待ちの新規は枠外でも1回だけ送る（同一項目は1回だけ）
- not ok 153 - digest: urgentを3回呼んでも1回だけで、行の可変状態が変わっても再送しない
- not ok 154 - digest: urgent本文は未通知項目だけで、既知の判断待ちを載せない
- not ok 155 - digest: JST 03:00はurgentを保留し、翌朝枠の先頭に夜間項目として載せる
- not ok 157 - digest(要件5): 変化0件なら送らない
- not ok 158 - digest: 朝枠の定時報告（朝枠・変化0件・進行中1件→sent、夕枠・変化0件・進行中1件→送らない、朝枠・同じ日の2回目→already-sent）
- not ok 165 - digest: 送信した本文を sent.jsonl に残し、dryRun では書かない
- not ok 178 - watch: 他者待ちの通知は成功後24時間抑制し、失敗時は再試行する
- not ok 180 - watch: 疎通確認の登録・完了再送でDMせず、digestは件数に集約する
- not ok 183 - digest: toast配達を受領ログに残し、未達時はsentにしない
- not ok 196 - run.log records whether the digest was actually delivered, even on a paused tick
- not ok 238 - hours cap uses the range of today log timestamps and fires immediately on post
- not ok 239 - consecutiveNoop resets on progress, unchanged progress is noop, watchdog only notifies on transition
- not ok 246 - digest records the real delivery result and never re-sends the same slot
- not ok 247 - done is durable, notifies once, and handoff contains the seven session-close headings
- not ok 254 - done pre replenishes in priority order, skips human work and previous objective, sends once
- not ok 262 - one decision DM accepts yes/no only while pending and does not repeat
- not ok 265 - progress 100 with unverified completes and registers a watch
- not ok 266 - watch ok removes the watch and notifies once
- not ok 267 - watch ng three times fails the check, notifies once and records history
- not ok 268 - watch expires after seven days and notifies once
- not ok 271 - Discord notices never leak internal codes, commands or ids
- not ok 273 - a watch never checked for seven days is closed by pre with one plain notice
- not ok 275 - configured mirror follows one DM and gets identical final body as one JSON line
- not ok 288 - periodic DM preserves waiting action and days despite notify-kim handoff/failure rewriting
- not ok 305 - morning and evening digest sends watched cases without local ledger and commits delivery point only on success
- not ok 310 - failed later message part retains the previous delivery point for retry
- not ok 343 - 台帳へ結果を保存し同日抑制と明示再送を維持する
- not ok 407 - kim reminders stay in session context across days and answered rows disappear
- not ok 443 - quota-sweep の deferred 通知は目的文に「失敗」があっても起票しない
- not ok 448 - token と userId で DM チャンネルを開いて投稿する
- not ok 449 - DM 失敗時は webhook へフォールバックする
- not ok 450 - token がなければ最初から webhook へ送る
- not ok 451 - 宛先IDが空でも kim 宛報告は台帳に保存する
- not ok 452 - 2000文字を超える本文を省略表示付きで切る
- not ok 453 - 送信直前に平易化を通す（内部用語が書き換わる）
- not ok 454 - NOTIFY_PLAIN_JA=0 相当（plainJa:false）では本文をそのまま送る
- not ok 455 - 原因・対処の欠落は既存TODOへ起票、日時・回数が変わっても24時間抑制
- not ok 456 - delegation-health通知はquota割合とtickだけが変わっても修復TODOを増やさない
- not ok 458 - 異なる発生元・原因は抑止しない
- not ok 461 - 送信失敗後は再送可能、同時呼び出しでも1通知・1起票
- not ok 463 - 人の操作が必要な試行と証拠がある場合は具体的な操作を残す
- not ok 464 - 完了報告に failed/失敗 が引用されても修復TODOを起票しない（自己増殖ループの回帰）
- not ok 465 - 定時ダイジェストは失敗語を含んでも起票しない
- not ok 467 - 修復TODOを目標文に引用した quota-sweep 報告は新キーで再起票しない
- not ok 469 - 夜間セッション再開は目的文に失敗を含んでも全行 progressed なら起票しない
- not ok 470 - 夜間セッション再開に1行でも error があれば目的文の失敗語によらず起票する
- not ok 477 - PRマージ依頼は送信せずblockedを返す
- not ok 478 - notify-kim CLIはblockedでexit 3、明示例外なら送信する
- not ok 479 - HTTP success without message id is not a delivered DM
- not ok 480 - DM 送信応答に json がない場合は配達済みにしない
- not ok 481 - DM 送信応答に JSON 解析が失敗する場合は配達済みにしない
- not ok 482 - DM 送信応答に JSON が null場合は配達済みにしない
- not ok 483 - silentはDMとwebhookでflagsを切り替え、環境変数の既定も反映する
- not ok 487 - DM 解決不能時は未達にして他人へ送らない
- not ok 489 - owner空の旧行はローカル持ち主を解決して通知する
- not ok 490 - 持ち主未設定・別ownerへのkim ID流用はいずれも未達
- not ok 491 - nishi のローカルkim IDを拒否しtoastとログへ送る
- not ok 492 - ローカルPCの明示notifyDiscordIdはownerがcrでもkimへDMする
- not ok 493 - notifyDiscordIdなしでIDファイルがkimなら従来どおりtoastへ送る
- not ok 494 - 別PCのnotifyDiscordIdはローカルPCの宛先に使わない
- not ok 496 - daily setup notice is suppressed on the same day and resets next day
- not ok 497 - toast failure is recorded by exit code and inbox succeeds; failed setup can retry
- not ok 500 - toast・none は伏字本文をowner inboxに保存しDM成功では保存しない
- not ok 501 - owner inbox 書き込み失敗でも呼び出し元を壊さない
- not ok 502 - 既知の他人のIDはファイル・map・明示指定の全経路で拒否する
- not ok 504 - 一致する持ち主へDMできたときtoastを出さない
- not ok 505 - 別PCの持ち主宛はローカルtoastで配達済みにしない
- not ok 506 - メンバー台帳が空でも別ownerのPC設定に紐づくIDは拒否する
- not ok 507 - DM result without message id falls back, including injected notify
- not ok 508 - DM 送信応答に json がない場合は実際の通知経路でも未配達にする
- not ok 509 - DM 送信応答に JSON 解析が失敗する場合は実際の通知経路でも未配達にする
- not ok 510 - kim names in directory reject alternate IDs for nishi
- not ok 511 - missing and empty ID files never invoke Discord
- not ok 512 - both fallbacks failing returns none, ledger records actual failures
- not ok 513 - concurrent watch and digest preserve both inbox messages and one setup notice
- not ok 514 - Discord failure with a valid recipient falls back without setup warning
- not ok 515 - kim 所有者は台帳配達を成功とし toast に重複通知しない
- not ok 531 - kim warning is limited to one attempt per day under concurrent notifications
- not ok 532 - kim warning failure preserves fallback and resolved recipients do not alert


## 2026-11-04 第2回修正・96件の分類

初回の96失敗を **A（仕様衝突）77件 / B（回帰）19件** に分類した。Aは変更箇所（共通fixtureを含む）に `2026-11-04 仕様変更:` のコメントを追加した。Bは期待値を変更せず製品コードを修正した。テストの削除・skipはない。

送信処理そのものの既存テストは明示的な `kind=digest` をfixtureに渡して配達処理まで進める。未指定kindの保留・action・done-requested・JSTの日次8通制限は既存の新規回帰10件で引き続き検査する。無人autopilotのテストは即時DMの代わりに保留台帳の本文・件数を読み、元の状態遷移・通知の重複防止・内容の検査を残した。

### 製品コードで戻した機能

- `auto-progress-digest.mjs`: 成功・失敗双方の `sent.jsonl` とsummary log。本文・ISO日時・slot・parts・receipts（messageId / recipientId / httpStatus / 実配達channel）を記録する。
- dryRunでは送信・状態・ログ・ロックディレクトリ作成・案件watch移行を行わない。朝夕のJSTスロット重複防止、owner別の配達点、失敗分だけの再送、夕の変化ゼロ抑止を復元した。
- owner空の旧行はlocalOwnerへ補完し、明示された他ownerの行を捨てず宛先別に配達する。他PCラベルではkim-PC専用の案件ハブ照会を行わない。kim-PCの通常台帳は引き続き会話内で回収し、案件ハブ・保留DMは朝夕に扱う。
- 案件ハブは成功した時だけcaseProgressを進める。本文のID・更新席は出さず案件件数に集約する。要約はownerごとに1枠1通で、旧分割送信は戻していない。
- 完了の同時刻遷移を拾い、即時完了通知済み／まとめ配達済みの完了は再送しない。`compactDigest`へhomeを渡して無人パス判定を修復し、操作不要の待機は質問にしない。依頼された作業の停止件数も残す。
- `autopilot-tick.mjs`: 具体的な判断依頼をactionへ戻した。無人完了・予告・巡回報告は保留する。
- `notify-kim.mjs`: 既存のPR依頼禁止ガードのblockedとCLI exit 3を復旧した。また新しいまとめ見出しを結果報告として認識し、本文に「失敗」が含まれても修復TODOを自己増殖させない。

### 分類表（元の96失敗、元のテスト名を保持）

| # | テスト名 | 分類 | 対応 |
| --- | --- | --- | --- |
| 1 | watch: before deadline stays open; overdue queues once and retries DM; recovery sends completion once | B | 即時完了通知済みの行をdigestから除外し、完了の二重配達を防いだ。 |
| 2 | digest: hundreds of rows across three categories are all delivered in 1800-char chunks | A | 200件を要約対象として数え、3区分・1通・10行以内を検査。分割／全件の名前表示の期待を変更。 |
| 3 | kim summaries never use the old outbound digest delivery | B | kim-PCの台帳まとめをセッション内で回収する分岐を復元した。 |
| 4 | 定期digestに開始予約と期限超過が出る | A | 開始予約も依頼区分の進行中に集約する期待へ変更。予約抽出自体の検査は保持。 |
| 5 | timeoutを繰り返した実例は2回でSheetとDMまとめへ一度報告される | B | 依頼作業の停止件数を依頼区分にも残し、Sheet・まとめ双方の報告を保持した。 |
| 6 | digest: DM未達を成功にせず、公開webhookへ送らない | B | webhookFallback:falseと失敗結果の返却を復元した。 |
| 7 | digest: 大量の完了も全件を名前で出し、次回へ回さない | A | 完了総数と代表2件を表示する期待へ変更。次日の再送防止は保持。 |
| 8 | digest routes each promise only to its owner | B | owner別にグループ化し、他者の約束を混ぜず各ownerへ1通ずつ送る。 |
| 9 | digest: owner 未記録の行は自PCの持ち主へ送り、owner 空で notifyOwner を呼ばない | B | owner空の旧行はlocalOwnerへ補完し、明示ownerの行も落とさない。 |
| 10 | digest: 無人処理は数だけ、なし系を正規化し、埋め込まれた識別子も本文に出さない | A | 無人分も件数に含める期待へ変更。homeを渡して無人パス判定を修復し、名前・内部IDの非表示を検査。 |
| 11 | digest: 同じ判定は再送せず、判断依頼の追加と判定変化だけを次の枠で送る | B | lastVerdicts・lastKim・lastWaitingを成功時に保存する処理を復元した。 |
| 12 | digest: 長文でも件の途中で切らず、成功した宛先を失敗後に再送しない | B | 宛先別の成功を保存し、同枠の再試行では失敗した宛先だけ送る。 |
| 13 | digest: 長文でも全件を名前で出し、1800字を超えたら分割して届ける | A | 長文・大量項目でも1通・10行・1800字以内とする期待へ変更。質問の内容と重複防止を検査。 |
| 14 | digest: noop はDMにも件数にも含めない | B | noop除外を維持し、要約にも実際の完了件数を残した。 |
| 15 | digest: checkなしも新形式で集約しdoneは一度だけ | B | 同一時刻の状態変化を拾い、配達済みの完了判定を再送しない。 |
| 16 | digest: 待機理由だけでは依頼せず、具体的なkimの操作がある場合のみ通知 | A | 操作不要の状況も朝夕のまとめに含め、具体的な操作は次の枠に載せる期待へ変更。 |
| 17 | digest(要件5): 判断待ちの新規は枠外でも1回だけ送る（同一項目は1回だけ） | A | 朝夕枠での要約文面に変更。枠外では送らず、1枠1通を検査。 |
| 18 | digest: urgentを3回呼んでも1回だけで、行の可変状態が変わっても再送しない | A | 枠外urgentは送らず状態を書かない期待へ変更。夕枠に入った時だけ1通送る。 |
| 19 | digest: urgent本文は未通知項目だけで、既知の判断待ちを載せない | A | 枠外では送らず、次の夕枠で既知・新規の未回答項目をまとめる期待へ変更。 |
| 20 | digest: JST 03:00はurgentを保留し、翌朝枠の先頭に夜間項目として載せる | A | 深夜もoutside-slotとして保留。翌朝に操作内容を含む1通が出ることを検査。 |
| 21 | digest(要件5): 変化0件なら送らない | B | 夕枠の変化ゼロ抑止をlastVerdicts等で復元した。 |
| 22 | digest: 朝枠の定時報告（朝枠・変化0件・進行中1件→sent、夕枠・変化0件・進行中1件→送らない、朝枠・同じ日の2回目→already-sent） | A | 朝の本文は依頼区分の進行中として検査。同枠重複防止と夕の変化ゼロ抑止は維持。 |
| 23 | digest: 送信した本文を sent.jsonl に残し、dryRun では書かない | B | 成功・失敗双方のsent.jsonl記録、本文、slot、parts、ISO日時、dryRun非書込を復元した。 |
| 24 | watch: 他者待ちの通知は成功後24時間抑制し、失敗時は再試行する | A | 呼出オプションにautomatic・now・sessionが付く期待へ変更。失敗再試行と24時間抑止の検査は保持。 |
| 25 | watch: 疎通確認の登録・完了再送でDMせず、digestは件数に集約する | A | 無人の疎通確認は自動作業区分の件数で検査。登録・完了の個別送信ゼロは保持。 |
| 26 | digest: toast配達を受領ログに残し、未達時はsentにしない | B | toast/inboxの配達結果もreceiptsに保存し、noneはsentにしない。 |
| 27 | run.log records whether the digest was actually delivered, even on a paused tick | A | 無人の定期報告の実結果deferredをrun.logに残す期待へ変更。 |
| 28 | hours cap uses the range of today log timestamps and fires immediately on post | A | 時間上限時の通知本文をdeferredから検査。停止のタイミング・理由は保持。 |
| 29 | consecutiveNoop resets on progress, unchanged progress is noop, watchdog only notifies on transition | A | 進捗なしによる停止通知をdeferredから検査。状態遷移・一度だけの登録は保持。 |
| 30 | digest records the real delivery result and never re-sends the same slot | A | 無人の定期報告はdeferredを記録し、Discord未送信と同枠の再登録抑止を検査。 |
| 31 | done is durable, notifies once, and handoff contains the seven session-close headings | A | 無人完了の本文をdeferredで検査。完了の永続化・二重実行防止・handoff見出しは保持。 |
| 32 | done pre replenishes in priority order, skips human work and previous objective, sends once | A | 次作業の予告をdeferredで検査。候補順・人の作業除外・一度だけの登録は保持。 |
| 33 | one decision DM accepts yes/no only while pending and does not repeat | B | autopilotの具体的な判断依頼をactionとして送り、yes/noの既存操作を復旧した。 |
| 34 | progress 100 with unverified completes and registers a watch | A | 未検証の無人完了をdeferredで検査。watchの登録内容は保持。 |
| 35 | watch ok removes the watch and notifies once | A | watch成功の通知をdeferredで検査。watch削除と通知内容は保持。 |
| 36 | watch ng three times fails the check, notifies once and records history | A | watch失敗通知をdeferredで検査。3回で失敗・履歴保存・一度だけの登録は保持。 |
| 37 | watch expires after seven days and notifies once | A | 7日経過のwatch終了通知をdeferredで検査。期限切れと履歴は保持。 |
| 38 | Discord notices never leak internal codes, commands or ids | A | 自動通知はdeferred、判断依頼は即時DMとして両方の本文を検査。内部コード・コマンドの非表示は保持。 |
| 39 | a watch never checked for seven days is closed by pre with one plain notice | A | 未検査watchの終了通知をdeferredで検査。7日での自動終了と一度だけの登録は保持。 |
| 40 | configured mirror follows one DM and gets identical final body as one JSON line | B | 判断依頼をactionに戻し、DMとmirrorが同じ本文を受け取る経路を復旧した。 |
| 41 | periodic DM preserves waiting action and days despite notify-kim handoff/failure rewriting | A | 定期報告の待ち日数・操作内容をdeferredで検査。ローカル保存本文との一致は保持。 |
| 42 | morning and evening digest sends watched cases without local ledger and commits delivery point only on success | B | 案件ハブの収集と成功時だけのcaseProgressチェックポイント更新を復元した。 |
| 43 | failed later message part retains the previous delivery point for retry | A | 複数partの失敗から1通の失敗へ変更。配達点を進めず同枠で再試行する検査は保持。 |
| 44 | 台帳へ結果を保存し同日抑制と明示再送を維持する | A | 無人の夕報はkim-inboxではなくdeferredに保存する期待へ変更。同日抑制・force再登録は保持。 |
| 45 | kim reminders stay in session context across days and answered rows disappear | B | kimの未回答項目を会話内で回収する分岐を復元し、回答済み除外を維持した。 |
| 46 | quota-sweep の deferred 通知は目的文に「失敗」があっても起票しない | A | 無人quota報告はdmではなくdeferredの期待へ変更。修復TODOの誤起票防止は保持。 |
| 47 | token と userId で DM チャンネルを開いて投稿する | A | 送信処理のfixtureにkind=digestを明示し、未指定kindによる保留と分離。既存の配達・整形・失敗・修復・抑制のassertは保持。 |
| 48 | DM 失敗時は webhook へフォールバックする | A | 送信処理のfixtureにkind=digestを明示し、未指定kindによる保留と分離。既存の配達・整形・失敗・修復・抑制のassertは保持。 |
| 49 | token がなければ最初から webhook へ送る | A | 送信処理のfixtureにkind=digestを明示し、未指定kindによる保留と分離。既存の配達・整形・失敗・修復・抑制のassertは保持。 |
| 50 | 宛先IDが空でも kim 宛報告は台帳に保存する | A | 送信処理のfixtureにkind=digestを明示し、未指定kindによる保留と分離。既存の配達・整形・失敗・修復・抑制のassertは保持。 |
| 51 | 2000文字を超える本文を省略表示付きで切る | A | 送信処理のfixtureにkind=digestを明示し、未指定kindによる保留と分離。既存の配達・整形・失敗・修復・抑制のassertは保持。 |
| 52 | 送信直前に平易化を通す（内部用語が書き換わる） | A | 送信処理のfixtureにkind=digestを明示し、未指定kindによる保留と分離。既存の配達・整形・失敗・修復・抑制のassertは保持。 |
| 53 | NOTIFY_PLAIN_JA=0 相当（plainJa:false）では本文をそのまま送る | A | 送信処理のfixtureにkind=digestを明示し、未指定kindによる保留と分離。既存の配達・整形・失敗・修復・抑制のassertは保持。 |
| 54 | 原因・対処の欠落は既存TODOへ起票、日時・回数が変わっても24時間抑制 | A | 送信処理のfixtureにkind=digestを明示し、未指定kindによる保留と分離。既存の配達・整形・失敗・修復・抑制のassertは保持。 |
| 55 | delegation-health通知はquota割合とtickだけが変わっても修復TODOを増やさない | A | 送信処理のfixtureにkind=digestを明示し、未指定kindによる保留と分離。既存の配達・整形・失敗・修復・抑制のassertは保持。 |
| 56 | 異なる発生元・原因は抑止しない | A | 送信処理のfixtureにkind=digestを明示し、未指定kindによる保留と分離。既存の配達・整形・失敗・修復・抑制のassertは保持。 |
| 57 | 送信失敗後は再送可能、同時呼び出しでも1通知・1起票 | A | 送信処理のfixtureにkind=digestを明示し、未指定kindによる保留と分離。既存の配達・整形・失敗・修復・抑制のassertは保持。 |
| 58 | 人の操作が必要な試行と証拠がある場合は具体的な操作を残す | A | 送信処理のfixtureにkind=digestを明示し、未指定kindによる保留と分離。既存の配達・整形・失敗・修復・抑制のassertは保持。 |
| 59 | 完了報告に failed/失敗 が引用されても修復TODOを起票しない（自己増殖ループの回帰） | A | 送信処理のfixtureにkind=digestを明示し、未指定kindによる保留と分離。既存の配達・整形・失敗・修復・抑制のassertは保持。 |
| 60 | 定時ダイジェストは失敗語を含んでも起票しない | A | 送信処理のfixtureにkind=digestを明示し、未指定kindによる保留と分離。既存の配達・整形・失敗・修復・抑制のassertは保持。 |
| 61 | 修復TODOを目標文に引用した quota-sweep 報告は新キーで再起票しない | A | 送信処理のfixtureにkind=digestを明示し、未指定kindによる保留と分離。既存の配達・整形・失敗・修復・抑制のassertは保持。 |
| 62 | 夜間セッション再開は目的文に失敗を含んでも全行 progressed なら起票しない | A | 送信処理のfixtureにkind=digestを明示し、未指定kindによる保留と分離。既存の配達・整形・失敗・修復・抑制のassertは保持。 |
| 63 | 夜間セッション再開に1行でも error があれば目的文の失敗語によらず起票する | A | 送信処理のfixtureにkind=digestを明示し、未指定kindによる保留と分離。既存の配達・整形・失敗・修復・抑制のassertは保持。 |
| 64 | PRマージ依頼は送信せずblockedを返す | B | PR依頼の禁止ガードは保留成功へ変換せず、元のblockedを返すよう戻した。 |
| 65 | notify-kim CLIはblockedでexit 3、明示例外なら送信する | B | 禁止されたCLI呼び出しはexit 3、既存の明示的な操作依頼は送信する分岐を復元した。 |
| 66 | HTTP success without message id is not a delivered DM | A | 送信処理のfixtureにkind=digestを明示し、未指定kindによる保留と分離。既存の配達・整形・失敗・修復・抑制のassertは保持。 |
| 67 | DM 送信応答に json がない場合は配達済みにしない | A | 送信処理のfixtureにkind=digestを明示し、未指定kindによる保留と分離。既存の配達・整形・失敗・修復・抑制のassertは保持。 |
| 68 | DM 送信応答に JSON 解析が失敗する場合は配達済みにしない | A | 送信処理のfixtureにkind=digestを明示し、未指定kindによる保留と分離。既存の配達・整形・失敗・修復・抑制のassertは保持。 |
| 69 | DM 送信応答に JSON が null場合は配達済みにしない | A | 送信処理のfixtureにkind=digestを明示し、未指定kindによる保留と分離。既存の配達・整形・失敗・修復・抑制のassertは保持。 |
| 70 | silentはDMとwebhookでflagsを切り替え、環境変数の既定も反映する | A | 送信処理のfixtureにkind=digestを明示し、未指定kindによる保留と分離。既存の配達・整形・失敗・修復・抑制のassertは保持。 |
| 71 | DM 解決不能時は未達にして他人へ送らない | A | 宛先／フォールバック検査のfixtureにkind=digestを明示。未指定kindの保留と分離し、既存の本人照合・未達判定・警告・保存のassertは保持。 |
| 72 | owner空の旧行はローカル持ち主を解決して通知する | A | 宛先／フォールバック検査のfixtureにkind=digestを明示。未指定kindの保留と分離し、既存の本人照合・未達判定・警告・保存のassertは保持。 |
| 73 | 持ち主未設定・別ownerへのkim ID流用はいずれも未達 | A | 宛先／フォールバック検査のfixtureにkind=digestを明示。未指定kindの保留と分離し、既存の本人照合・未達判定・警告・保存のassertは保持。 |
| 74 | nishi のローカルkim IDを拒否しtoastとログへ送る | A | 宛先／フォールバック検査のfixtureにkind=digestを明示。未指定kindの保留と分離し、既存の本人照合・未達判定・警告・保存のassertは保持。 |
| 75 | ローカルPCの明示notifyDiscordIdはownerがcrでもkimへDMする | A | 宛先／フォールバック検査のfixtureにkind=digestを明示。未指定kindの保留と分離し、既存の本人照合・未達判定・警告・保存のassertは保持。 |
| 76 | notifyDiscordIdなしでIDファイルがkimなら従来どおりtoastへ送る | A | 宛先／フォールバック検査のfixtureにkind=digestを明示。未指定kindの保留と分離し、既存の本人照合・未達判定・警告・保存のassertは保持。 |
| 77 | 別PCのnotifyDiscordIdはローカルPCの宛先に使わない | A | 宛先／フォールバック検査のfixtureにkind=digestを明示。未指定kindの保留と分離し、既存の本人照合・未達判定・警告・保存のassertは保持。 |
| 78 | daily setup notice is suppressed on the same day and resets next day | A | 宛先／フォールバック検査のfixtureにkind=digestを明示。未指定kindの保留と分離し、既存の本人照合・未達判定・警告・保存のassertは保持。 |
| 79 | toast failure is recorded by exit code and inbox succeeds; failed setup can retry | A | 宛先／フォールバック検査のfixtureにkind=digestを明示。未指定kindの保留と分離し、既存の本人照合・未達判定・警告・保存のassertは保持。 |
| 80 | toast・none は伏字本文をowner inboxに保存しDM成功では保存しない | A | 宛先／フォールバック検査のfixtureにkind=digestを明示。未指定kindの保留と分離し、既存の本人照合・未達判定・警告・保存のassertは保持。 |
| 81 | owner inbox 書き込み失敗でも呼び出し元を壊さない | A | 宛先／フォールバック検査のfixtureにkind=digestを明示。未指定kindの保留と分離し、既存の本人照合・未達判定・警告・保存のassertは保持。 |
| 82 | 既知の他人のIDはファイル・map・明示指定の全経路で拒否する | A | 宛先／フォールバック検査のfixtureにkind=digestを明示。未指定kindの保留と分離し、既存の本人照合・未達判定・警告・保存のassertは保持。 |
| 83 | 一致する持ち主へDMできたときtoastを出さない | A | 宛先／フォールバック検査のfixtureにkind=digestを明示。未指定kindの保留と分離し、既存の本人照合・未達判定・警告・保存のassertは保持。 |
| 84 | 別PCの持ち主宛はローカルtoastで配達済みにしない | A | 宛先／フォールバック検査のfixtureにkind=digestを明示。未指定kindの保留と分離し、既存の本人照合・未達判定・警告・保存のassertは保持。 |
| 85 | メンバー台帳が空でも別ownerのPC設定に紐づくIDは拒否する | A | 宛先／フォールバック検査のfixtureにkind=digestを明示。未指定kindの保留と分離し、既存の本人照合・未達判定・警告・保存のassertは保持。 |
| 86 | DM result without message id falls back, including injected notify | A | 宛先／フォールバック検査のfixtureにkind=digestを明示。未指定kindの保留と分離し、既存の本人照合・未達判定・警告・保存のassertは保持。 |
| 87 | DM 送信応答に json がない場合は実際の通知経路でも未配達にする | A | 宛先／フォールバック検査のfixtureにkind=digestを明示。未指定kindの保留と分離し、既存の本人照合・未達判定・警告・保存のassertは保持。 |
| 88 | DM 送信応答に JSON 解析が失敗する場合は実際の通知経路でも未配達にする | A | 宛先／フォールバック検査のfixtureにkind=digestを明示。未指定kindの保留と分離し、既存の本人照合・未達判定・警告・保存のassertは保持。 |
| 89 | kim names in directory reject alternate IDs for nishi | A | 宛先／フォールバック検査のfixtureにkind=digestを明示。未指定kindの保留と分離し、既存の本人照合・未達判定・警告・保存のassertは保持。 |
| 90 | missing and empty ID files never invoke Discord | A | 宛先／フォールバック検査のfixtureにkind=digestを明示。未指定kindの保留と分離し、既存の本人照合・未達判定・警告・保存のassertは保持。 |
| 91 | both fallbacks failing returns none, ledger records actual failures | A | 宛先／フォールバック検査のfixtureにkind=digestを明示。未指定kindの保留と分離し、既存の本人照合・未達判定・警告・保存のassertは保持。 |
| 92 | concurrent watch and digest preserve both inbox messages and one setup notice | A | 宛先／フォールバック検査のfixtureにkind=digestを明示。未指定kindの保留と分離し、既存の本人照合・未達判定・警告・保存のassertは保持。 |
| 93 | Discord failure with a valid recipient falls back without setup warning | A | 宛先／フォールバック検査のfixtureにkind=digestを明示。未指定kindの保留と分離し、既存の本人照合・未達判定・警告・保存のassertは保持。 |
| 94 | kim 所有者は台帳配達を成功とし toast に重複通知しない | A | 宛先／フォールバック検査のfixtureにkind=digestを明示。未指定kindの保留と分離し、既存の本人照合・未達判定・警告・保存のassertは保持。 |
| 95 | kim warning is limited to one attempt per day under concurrent notifications | A | 宛先／フォールバック検査のfixtureにkind=digestを明示。未指定kindの保留と分離し、既存の本人照合・未達判定・警告・保存のassertは保持。 |
| 96 | kim warning failure preserves fallback and resolved recipients do not alert | A | 宛先／フォールバック検査のfixtureにkind=digestを明示。未指定kindの保留と分離し、既存の本人照合・未達判定・警告・保存のassertは保持。 |

### 最終検証

前回と同じ26ファイル（既存の新規回帰10件を含む）: **532 pass / 0 fail / 0 cancelled / 0 skip**。
追加した `tools/owner-dm-digest-regression.test.mjs`: **6 pass / 0 fail**。receiptsの3項目、失敗記録と同枠再送、dryRunの書込ゼロ、owner別再送、上限超過actionの成功後消費、無人判定と10行上限、新まとめからの修復TODO自己増殖防止を検査する。
合計: **538 pass / 0 fail**。すべて一時home・注入した送信スタブで実行し、実際のDiscord送信や実homeの書換えは行っていない。git操作も行っていない。

再現コマンド（homeは一時ディレクトリ）:

```bash
ORGIAST_HOME="$(mktemp -d /tmp/dmnoise-suite-XXXXXX)" node --test \
  tools/aihaijin-digest.test.mjs \
  tools/auto-progress-check.test.mjs \
  tools/auto-progress-fleet.test.mjs \
  tools/auto-progress-inbox-hook.test.mjs \
  tools/auto-progress-session-digest.test.mjs \
  tools/auto-progress-start-when.test.mjs \
  tools/auto-progress-watch.test.mjs \
  tools/auto-progress.test.mjs \
  tools/autopilot-distribution.test.mjs \
  tools/autopilot-run.test.mjs \
  tools/autopilot-tick.test.mjs \
  tools/case-progress-digest.test.mjs \
  tools/discord-digest.test.mjs \
  tools/discord-task-digest.test.mjs \
  tools/evening-digest.test.mjs \
  tools/feedback-done-notify.test.mjs \
  tools/feedback-nag.test.mjs \
  tools/feedback-progress-notify.test.mjs \
  tools/kim-awaiting.test.mjs \
  tools/line-digest.test.mjs \
  tools/mail-task-digest.test.mjs \
  tools/notify-kim-quota-sweep.test.mjs \
  tools/notify-kim.test.mjs \
  tools/notify-owner.test.mjs \
  tools/owner-dm-policy.test.mjs \
  tools/owner-inbox-hook.test.mjs \
  tools/owner-dm-digest-regression.test.mjs
```
