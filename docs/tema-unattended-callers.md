# 無人送信の手間チェック対応表（修正指示3）

送信ゲートの既定は `block`。記録は本文から外し、正規化本文の SHA-256 に対応する `~/.claude/tema-records/` に保存する。本文を変えた場合は別の検証が必要。記録に合格しても従来の HUMAN-ONLY 判定・承認・履歴・重複防止を省略しない。

停止した本文と理由は `prepareTemaSend` / `parkTemaBlocked` から `kim-inbox` に `source=tema-blocked-send`、高優先度、本文単位の重複防止キー付きで保存する。`localOnly` により、この退避処理から社外送信や別PC転送は行わない。本文全文を保持し、常設の inbox 見回り対象にする。退避先への保存に失敗した場合も成功扱いせず呼び出し元へエラーを返す。

検索はリポジトリ全体に対して行い、実行・import と、コメント・読み取り専用参照・テストを分けて確認した。

```powershell
rg -n 'assertNoHandback|sendDiscordDm|sendDraft|beeperSend|discord-dm\.mjs|beeper-send\.mjs|line-(channel|group-send)\.mjs|gmail-draft\.mjs' --glob '!*.test.mjs'
rg -n 'sendMessage\(|sendDM\(|sendDm\(' tools --glob '!*.test.mjs'
```

| 呼び出し元 | 文面・経路 | 対応 |
|---|---|---|
| `discord-autoreply.mjs` | LLM → Discord API | 生成指示に記録ブロックを必須化。送信前に検証し除去。記録なしは送信せず inbox に全文・理由を保存。再生成に渡す以前の回答からは記録を外す |
| `discord-beeper-autoreply.mjs` | LLM → Beeper API | 同じ生成指示・記録必須・退避。トライアルの固定文だけ専用記録を渡す |
| `followup-ledger.mjs` | 催促・承認依頼・再確認 | 台帳の `temaCheck` を検証し別保存。欠落・不合格を inbox に退避。既存の新着取得、重複確認、回数制限を維持 |
| `lib/followup-adapters.mjs` | Discord / Beeper 直接送信 | アダプターの入口でも本文・台帳記録を検証し、停止を退避。Gmail アダプターは従来どおり送信非対応 |
| `fleet-chase.mjs` / `lib/fleet-chase-actions.mjs` | 停止PCの電源・起動依頼 | ビーコン停止確認後にのみ使う固定記録と HUMAN-ONLY 理由をテンプレートへ添付 |
| `lahaina-daily-post.mjs` / `lahaina-daily-message.mjs` | 当日の写真依頼 → LINE | 撮影依頼用の固定記録を登録。当日の写真撮影と、AIが行う画像調整・投稿文を分けて記録 |
| `lahaina-standing-send.mjs` | 同写真依頼の Beeper 代替経路 | 常設許可範囲の照合後に同じ固定記録を登録 |
| `daily-beeper-approval.mjs` | 承認済みキュー → Beeper CLI | キュー本文に対応する記録を共通送信入口で再検証。承認表示時にカード登録 |
| `reply-queue.mjs` | 下書き・承認・receipt の管理 | 自身は送信しない。`present` でカード登録。送信側の検証・退避に接続 |
| `unsent-ledger.mjs` | 承認済み本文 → `beeperSend` | 共通入口で別保存記録を再検証。欠落時は本文と理由を inbox に保存 |
| `origuchi-referral-monthly.mjs` | 月次照合後の請求書依頼下書き | 案件シート・freee 照合後に専用固定記録を `createDraft` へ渡す。下書きに記録を残さない |
| `satou-secretary-daily.mjs` | LLM要約を含む日報 → Discord DM | **warn例外**。第三者の依頼を引用・要約する報告で、各要約の検証記録が未対応。警告監査し、従来の handback 停止は inbox に退避 |
| `schedule-sync.mjs` | 抽出予定を含む通知 → Discord DM | **warn例外**。第三者メッセージ由来の予定通知。本文中の依頼表現を監査ログへ記録 |
| `vehicle-inspection-watch.mjs` | 車検台帳の固定通知 → Discord DM | **warn例外**。車検証原本の所在・担当者による入力要否を固定文だけでは検証できない。共通DM入口へ移し監査・退避 |
| `feedback-nag.mjs` / `feedback-progress-notify.mjs` / `ledger-stale-nag.mjs` | フィードバック・停滞案件の通知 | **warn例外**（共通 `feedback-nag.sendDiscordDm`）。既存項目の引用を含むため警告監査。実送信前の handback 停止は inbox に退避。owner の inbox 配送は外部送信しない |
| `internal-pending-replies.mjs` | 未返信の一覧 | 読み取り専用。送信関数を呼ばない。見回り担当が上記の共通送信入口を使う |
| `line-export-reminder.mjs` / `line-share-health.mjs` | LINE取込監視通知 | `sendDiscordDm` という関数名だが実体は `kim-inbox.addItem`。外部送信しない |
| `notify-kim.mjs` / `notify-owner.mjs` | 通知・判断待ちの配送 | 対象の共通送信関数を呼ばない inbox 系。承認 ask は `kim-inbox` 側のカード登録で捕捉 |
| `feedback-done-notify.mjs` | 完了報告の独立リレー | 対象の共通送信関数を呼ばない。今回の呼び出し元検索では除外 |
| `auto-progress-external-check.mjs` / `send-context-check.mjs` / `event-shop-inquiry-triage.mjs` | LINE資格情報・Gmailトークンの import | 読み取り専用の import。送信呼び出しなし |
| `discord-group-dm-request.mjs`、各ゲート・定時再確認プロンプト | 実行コマンドの案内 | コマンドを実行した時点で共通CLIが検証・退避。委任AI/Botは `tema-check --save` または `--tema-record` を使用 |

警告例外の出力先は `~/.claude/tema-check/warn.jsonl`。時刻・チャネル・呼び出し元・本文・検出理由を記録する。例外は上記4系統に限定し、共通ゲートの既定値は変更していない。

## 承認カードと下書き

- Gmail 下書き作成、送信承認全文を照合するゲート、`kim-inbox` の宛先・件名付き ask、`reply-queue present`、日次承認表示でカードを登録する。
- 他Botは `node tools/approval-cards.mjs --register --draft-id ... --to ... --subject ...` を使う。
- Gmail送信の直前に直近10分の送信済みをキャッシュなしで再検索し、同じ宛先・件名を検出したら `DUP_SENT_BY_USER` で停止する。
- 成功後の後始末でカードを送信済みにし、`cardNotice` を返す。送信報告には「送信済みなのでカードは押さないで」を含める。Stop ゲートが同件カードの注意漏れを検出する。
