# 連絡をキャッチして行動に移す

LINE・メールは、言われる前にキャッチして、日程更新・提出物の回収・返信案・作業記録につなげる。日付つきのお題（インスタ等）はその日のうちに投稿・提出し、遅れそうなら kim-inbox で金さんにプッシュする。社外への送信は下書き・承認を通す。

日程変更は kim@orgiast.jp の Google カレンダーを更新する。時刻未定は「【仮】…（時間未定）」の終日・予定なし（transparent）として登録し、確定したら時刻付きに更新する。招待通知は送らず、社外の参加者を追加しない。対象が複数ある、日付が不明などの場合は ask に記録する。

引用された過去日付は自動更新しない。既存の確定時刻は「時間未定」等の明示がない限り解除しない。書き込み前のイベント全体を `~/.claude/catch-and-act/calendar-journal/` に保存する。

見張り・仕分けは `llm-ask` の安い AI を使う。Cursor への委譲は 2026-11-25 金さん指示で停止した。画像・動画調整は Muse（Claude Code 配下）が担当する。

## 運用

- `node tools/catch-and-act.mjs [--classifier llm-ask]`。GLM → DeepSeek → Groq を各18秒（子プロセス22秒）で試し、失敗したプロバイダはその実行中休止する。全失敗時はキーワード判定。内部の自動フォールバックは無効で、Claude API/モデルには回さない。
- `powershell -NoProfile -File tools/register-catch-and-act.ps1` で OrgiastCatchAndAct を15分おきに登録する。既定は同期済み nightly-repo。検証用だけ `-RepoRoot <専用worktree>` が使える。非表示実行、重複起動禁止、14分上限。
- Gmail は kim@ / seisaku-team@、LINE は既読・ミュート・アーカイブにかかわらず全チャットをページ送りで確認する。Beeper がアドレス帳から作る履歴なしのチャット（lastActivityなし・未読0）は本文取得せず、新着で活動日時または未読が付けば取得する。送信済みメール・本人のLINE送信は対象外。初回は24時間前から。以後は各箱・チャットの読取位置に60秒重ね、チャネル＋メッセージIDで重複排除する。
- `~/.claude/catch-and-act/state.json` に受信内容・分類・処理結果・通知履歴を保存。取得ページごとに保存し、取得に失敗したソースの位置を進めない。処理失敗は次回再試行。1回40件・10分を目安とし、残件数はログに記録する。既存の comms-hub（保管）と deadline-watch/detect（期限台帳）は継続する。
- `watch.json` の events に送信者・イベントID・対象日・有効期限を設定する。初期値は KAZUAKII / 2026-11-25 / `o1kpj57ak6e1s845184ci4q0kk`。時刻だけの返信にも対応。用途が変わったら設定を見直す。
- 「株式会社ラハイナ」の写真は受信日のお題に結び付け、`insta-queue/*.json` と隣の画像ファイルへ保存。期限は受信日20:00 JST。本文は写真を見ていない下書きとして金さんが確認する。画像加工や投稿は実行しない。お題送信用 standing-approval.json は投稿許可として扱わない。
- 中継経由の写真取得には Beeper ホスト側も本PRの `beeper-gateway.mjs` が必要。`/gateway/attachment` は mxc/localmxc のみ受け付け、Beeper が返したURLのみ内部で取得する。任意のホストファイルは公開しない。旧中継ならキュー・ask に取得失敗を残して再試行する。
- kim-inbox の ask に写真のパス・投稿文全文・期限を保存。期限2時間前と超過時に、それぞれ一度 urgent を積む。承認回答だけでは投稿済みとせず、投稿担当が既存 `instagram/post.mjs` / `verify-post.mjs` で承認・投稿・読み戻しを行い、キューの status を `published`（不要なら `cancelled`）にする。
- 返信案は ask、作業依頼は info。LINE・メール・Instagram への送信経路は持たない。通知は kim-inbox の既存転送経路を使い、Discord DM は使わない。
- `~/.claude/logs/catch-and-act.log` に1実行1行のJSON。本文・秘密値は含めず、件数・分類・動作・失敗コード・残件数を記録する。`status:error` は次回再試行対象。キーワード代替は `keywordFallback` で確認する。
- 登録タスクは `--runner-log` を付ける。この場合はJSONを標準出力に一度だけ書き、run-hidden.vbs に同ログへの追記を任せる（Windowsのログ共有違反を避ける）。直接CLI起動では本体がログを保存する。

## 検証

`node --test tools/catch-and-act.test.mjs tools/schedule-sync.test.mjs tools/beeper-api.test.mjs tools/beeper-gateway.test.mjs tools/gmail-search.test.mjs tools/lahaina-daily-post.test.mjs`

Calendar 更新は既存 DWD / Calendar v3 クライアントを利用する。仕様: [Calendar events.patch](https://developers.google.com/workspace/calendar/api/v3/reference/events/patch)。
