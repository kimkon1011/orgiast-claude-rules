# 修正指示3 A〜K 対応記録

基点: `7c6d1db4`。対象ブランチ: `feat/tema-check-1127`。外部送信・push・PR作成は行わず、APIはモック、未モック通信はテストのプリロードで拒否する。

## 無人呼び出し元

探索: `rg -n 'assertNoHandback|sendDiscordDm|sendDraft|beeperSend|discord-dm\.mjs|beeper-send\.mjs|line-(channel|group-send)\.mjs|gmail-draft\.mjs' tools --glob '!*.test.mjs'`。全リポジトリでも同じ検索を実施し、説明文・読み取り専用import・テストfixtureを実送信呼び出しと区別した。

| 呼び出し元 | 対応 | 停止時 |
|---|---|---|
| discord-autoreply / discord-beeper-autoreply | 生成指示で記録必須。送信前に検証しタグ除去 | 全文・理由をkim-inboxへ保存 |
| discord-beeper-autoreplyのトライアル終了定型文 | 本人の退会・勤怠申告用の固定記録 | 共通退避 |
| followup-ledger → followup-adapters（Discord/Beeper） | 台帳のtemaCheckまたは本文に対応する保存記録を検証 | 全文・理由をkim-inboxへ保存 |
| fleet-chase → discord-dm | ビーコン停止後の物理電源操作用の固定記録＋HUMAN-ONLY | 共通退避 |
| lahaina-daily-post / lahaina-standing-send / daily-beeper-approval | 当日現地写真の固定記録を送信本文に対応して保存。既存の常設許可・当日範囲照合を維持 | 共通退避・既存の不確実送信抑止 |
| origuchi-referral-monthly → createDraft | 案件シート・freee照合後の請求書依頼用記録を渡す | 共通退避 |
| satou-secretary-daily（報告・失敗通知） | 引用を含む報告のためtemaMode:warn、source付き監査ログ | 従来のhandbackは禁止のまま、該当時は共通退避 |
| schedule-sync（予定登録結果） | 引用を含む結果報告のためtemaMode:warn | 同上 |
| vehicle-inspection-watch → discord-dm | 所在等を固定文だけで確定できないためtemaMode:warn | 同上 |
| feedback-nag / feedback-progress-notify / ledger-stale-nag | 共通のfeedback送信関数でtemaMode:warn | 同上 |
| unsent-ledger / reply-queue → beeper-send | 保存記録を共通入口で再利用。承認receiptを維持 | 記録不足・handbackはkim-inboxへ保存 |
| 定時再確認・auto-progressの各送信CLI | gmail-draft / discord-dm / line-channel / line-group-send / beeper-sendの共通検証を経由 | 全文・理由をkim-inboxへ保存。送信済み台帳でも停止 |
| internal-pending-replies | 未返信の一覧取得のみ。送信関数なし | 実返信側の共通入口で検証 |
| notify-kim / line-export-reminder / line-share-health等 | kim-inboxへの通知経路。askの宛先・件名またはdraftIdをカード登録 | 社外送信処理ではない |
| discord-dm-drafts | scanは下書き保存のみ。UI送信は明示操作の別経路 | 無人送信元に含めない |

warn例外は上記の satou-secretary-daily、schedule-sync、vehicle-inspection-watch、feedback通知群。`~/.claude/tema-check/warn.jsonl` にsource・本文・理由を保存する。共通ゲートの既定はblockのまま。

## チャネル×項目

定数: `tools/lib/send-consistency.mjs` の `CHANNEL_ITEM_SUPPORT` / `CONSISTENCY_ITEM`。取得失敗は常にblock。未対応項目だけ `UNSUPPORTED_<項目>` を出力し、`~/.claude/send-consistency/unsupported.jsonl` に保存する。

| チャネル | 1 送信済み | 2 他下書き・予定 | 3 氏名/CC/日程等 | 4 過去発言 | 5 最新指示 | 6 過去日付 | 7 新着 | 8 直前送信済み |
|---|---|---|---|---|---|---|---|---|
| Gmail | Gmail＋台帳、block | 下書き・タスク・全PC、block | 本文・履歴・Calendar、block | Gmail、block | 設定、block | 本文、block | Gmail再読込、block | 3アカウントをno-cache検索＋台帳再読込、block |
| Discord | 履歴＋台帳、block | 他下書き未対応warn、予定はblock | 本文・履歴・Calendar、block | Discord、block | 設定、block | 本文、block | Discord再読込、block | 台帳再読込、block |
| LINE | 履歴＋台帳、block | 他下書き未対応warn、予定はblock | 本文・履歴・Calendar、block | 履歴readerに従う | 設定、block | 本文、block | Supabase readerはblock、reader未提供経路だけwarn | 台帳再読込、block |
| Beeper | 履歴＋台帳、block | 他下書き未対応warn、予定はblock | 本文・履歴・Calendar、block | 履歴readerに従う | 設定、block | 本文、block | Beeper readerはblock、reader未提供経路だけwarn | 台帳再読込、block |

この基点にはLINEのSupabase履歴・BeeperのAPI履歴・共通Calendar取得が既に存在する。これらの401・通信失敗を「未対応」に読み替えない。LINE/Beeperのreaderを実装していない接続経路は依存の `fetchHistory:null` で表し、履歴と確認時刻が未対応であることを警告する。項目1・8はこの場合も台帳で必ず照合し、warnへ降格させない。

## A〜Kと検証

| 指示 | 実装・検証 |
|---|---|
| A | 決まり文句を除外、作業対象付き依頼は保持、認証の名詞だけは対象外 |
| B | 正規化本文のSHA-256で記録保存。Gmail送信・--tema-record・tema-check --saveで再利用。タグ別エラー |
| C | 上記呼び出し元表、記録必須のLLM指示、停止本文のローカル退避、warn例外監査 |
| D | 下書きの作成から送信までモックで確認。欠落記録でPOSTゼロ・kim-inbox全文保存 |
| E | 実行ログからtest-results.mdを更新 |
| F | ONBOARDING・absolute-rules・要約・portable-knowhow/15の項目8 |
| G | カードライブラリ/CLI、登録経路、送信直前検索、送信後notice、Stopフック。複数行報告とカード台帳破損も回帰検証 |
| H | T8a/T8b/T8c。17秒前のユーザー送信・通常送信・注意文の有無 |
| I | ビーコンcard=yes/no、反映表のカード注意列 |
| J | J-LINE/J-GMAIL、対応表固定、認証失敗と未対応の区別、項目1/8の降格禁止 |
| K | PowerShell 5.1で一括テストとtema-check単独を実行。基点7c6d1db4の上にコミット |

実際の件数・各ケース結果は作業ディレクトリの親にある `test-results.md` / `test-results-consistency.md` と `.tap` に記録する。
