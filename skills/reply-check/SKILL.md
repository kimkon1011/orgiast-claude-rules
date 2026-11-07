---
name: reply-check
description: 合言葉「返信チェック」。kim 宛で未返信の Messenger・LINE・メール・Discord を集め、返信案をチャットに並べて確認してもらい、OK が出たものだけ送る。状態は返信キュー（tools/reply-queue.mjs）が正本で、kim の修正は学習ループ（tools/reply-learning.mjs）に記録して次の案に効かせる。Discord の kim 宛は discord-autoreply.mjs が全件を承認なしで代理回答する（kim 2026-11-06 指示）。「返信チェック」「未返信チェック」「返事してないもの」「返信案を見せて」「/reply-check」と言われたら必ずこのスキルを使う。
---

# 返信チェック（kim 宛の未返信 → キューに積む → 返信案 → OK 分だけ送信 → 修正を学習）

対象は **kim 本人宛だけ**（1対1・kim へのメンション・To/Cc に kim）。グループの雑談、オープンチャット、bot や自動通知、ニュースレターは除外する。

**状態の正本は `node C:/Users/uers/.claude/nightly-repo/tools/reply-queue.mjs`**（保存先 `~/.claude/reply-queue/queue.json`）。収集した未返信は必ず `enqueue` し、同じ `channel:thread:message` は二度積まれない。セッションをまたいでも「提示済み・承認済み・送信済み」が残るので、二重提示・二重送信を防げる。

状態遷移: `queued → drafted → presented → approved | edited | rejected | no-reply → sent | failed | uncertain`。送信直前の `receipt` で相手の新着を検知したら `queued` に戻る。

## 0. Discord は自動（kim の承認なし・2026-11-06 kim 指示）

※ PR #1685 にて段階 E（Discord 全件代理回答）はマージ済み。この節の内容が有効。

kim 宛の Discord（@メンション・kim の発言への返信・「金さん／キムさん／kim さん」の呼びかけ・Bot 代筆 DM への相手の返信・Bot が参加しているグループ DM）は、`tools/discord-autoreply.mjs`（定期タスク OrgiastDiscordAutoReply、5 分ごと）が **全件をキューへ積み、08:00〜21:00 JST に承認なしで自動送信**する。

- 本文は機械で強制: 先頭 **「【kimのClaudeによる代理回答】」**、続けて元メッセージの日時と先頭行の引用、末尾に「このメッセージへの返答は、Bot ではなく金に直接お願いします。」。この形でない本文は送信関数が拒否する。
- 金額・値引き・契約・支払い承認・人事評価・採用可否・社外への約束・根拠が見つからないものは推測で答えず「【kimのClaudeによる代理回答】金に確認して回答します」と返し、kim-inbox の ask に積む。
- 社外の相手（Discord のお客様・外注）宛は、社内情報（原価・利益率・他社の見積・社員の評価）が混ざっていないかを送信前に検査し、混ざっていれば送らず kim-inbox の ask に回す。
- 同じ相手には 1 時間に 3 通まで。止めるときは `~/.claude/reply-queue/discord-autosend.disabled` を作る（消せば再開）。
- 送った全文は毎回 kim-inbox の info に残る。kim が後から直した内容は `decide <id> --verdict edited --final-file <最終文>` で学習ループに戻す。
- kim 個人 DM のうち Bot が参加していないものは読めない（ユーザートークン方式は Discord 規約違反のため使わない）。`status` の `unreadable` に出る。
- このスキルで Discord を扱うのは「自動送信が止まっている／判断待ちの ask を処理する」ときだけ。手動で送るときも同じ見出し・引用・末尾を付ける。

承認なしの自動送信は **メール・LINE・Messenger には作らない**（組織指示 11）。分類ごとに無修正承認率が 30 件以上で 95% 以上になったら「この分類は自動送信にしますか」を kim-inbox の ask に出すだけにする。

## 1. 収集（4チャネル並行。重い読み取りは Agent(model:"sonnet") に投げ、結果だけ受け取る）

| チャネル | 取得方法 | 未返信の判定 |
|---|---|---|
| メール | Gmail MCP（kim@orgiast.jp）で直近7日の受信トレイ。人間が書いたもののみ | スレッドの最後が kim 以外 |
| Discord | 自動（§0）。`node tools/reply-queue.mjs list --channel discord --state queued` で積み残しを見る。kim 本人の DM は DISCORD_USER_TOKEN が無いため読めない | `discord-autoreply.mjs` が判定 |
| Messenger | `node C:/Users/uers/.claude/nightly-repo/tools/messenger-watch.mjs --dry-run`（作業ツリー版は playwright-core が無く exit 4 になる） | 未読の1対1のみ。グループは kim 宛の時だけ |
| LINE | `powershell -STA -File C:/Users/uers/.claude/tools/line-pc-act.ps1 -Action shot/click` で PC 版 LINE を撮影。一覧の未読バッジ付きの1対1と「メンションされました」を開いて読む | 最後が相手の発言 |

- 集めたら JSON（`[{channel, thread, message, from:{id,name,external}, body, receivedAt, context?, link?}]`）を一時ファイルに書き `node tools/reply-queue.mjs enqueue --file <json>` に通す。`duplicates` に入ったものは前回提示済みなので `list --brief` で状態を確かめ、`presented` のままなら kim の返事待ちとして再掲する。
- LINE は開くと既読が付く。それを承知のうえで読む。
- LINE は検索語が残っていることがある。検索欄の × (443,89) をクリックし、別途 shot を撮る（click 直後の画像は描画前のことがある）。
- 取れなかったチャネルは「未確認（理由）」と書く。0件と書かない。

## 2. 返信案の作成と提示（チャットに表で出す）

**案を作る前に必ず** `node tools/reply-learning.mjs context --from <相手の名前> --category <question|request|confirm|report|other> --channel <ch> --item <id>` を実行し、返ってくる `examples`（同じ相手 → 同じ分類 → 全体の順で、kim が過去に承認・修正した最終文 最大5件）と `voiceRules`（`~/.claude/reply-learning/kim-voice.md`、口調と判断のルール集）に合わせて書く。使った例は usage.jsonl に残る。

案ができたら `node tools/reply-queue.mjs draft <id> --file <案.txt>`、提示したら `present <id> <id> ...`。

1件ごとに `番号 / id / チャネル / 相手 / 日時 / 要旨 / 返信案（そのまま送れる完成文）/ 要判断` を並べる。
- 文面は kim の口調に合わせる。社員には短く丁寧に、社外には敬語で署名つき。
- 判断が要るもの（採否・面談の可否・金額の承認）は、選択肢ごとの返信案を A/B で並べる。kim が選んだ方を送る。
- 返信不要と判断したもの（報告だけ・他の人が対応済み）は「返信不要（理由）」の行にまとめる。
- 各件に「推奨（A/B・送る/送らない）と理由」を付ける。kim が判断しないと書けないもの（採否・予定）は「送らない」を推奨にする。
- 最後に「推奨のままなら『推奨でOK』、変える番号だけ添えてください」と1行書く。kim の手間はこの一言だけにする。

### 返信案を作る前の必須チェック（2026-10-23 の事故から）
- **相手が日程を出していたら、まずその日程をカレンダーで照合する**。空いていれば、その枠を承諾する返信にする。こちらから候補を出すのは、相手の候補が全部ふさがっている時か、相手が「候補をください」と言っている時だけ。要約ではなく、元メールの本文（get_thread）を読んでから判定する。
- **候補日はいちばん近い週から出す**。複数の相手に出すときも、近い週を後ろの人に回さない（同じ枠を2人に出すのは可。決まった時点で片方を差し替えればよい）。
- **返信はもらったチャネルで返す**。LINE で来たものは LINE で返す。メールに切り替えない。
- **kim に渡すファイルは必ず Google Drive の URL にする**（ローカルパス・scratchpad は禁止）。PDF や画像は元の Drive ファイルの URL（`?authuser=kim@orgiast.jp` を付ける）か、Drive に上げた URL で渡す。サブエージェントへの指示にも「出力は Drive URL」と書く。

## 3. kim の返事を記録する（修正は必ず最終文を保存）

| kim の返事 | コマンド |
|---|---|
| 「推奨でOK」 | 該当 id ごとに `node tools/reply-queue.mjs decide <id> --verdict approved` |
| 「3番は○○に変えて」 | 直した最終文をファイルに保存し `decide <id> --verdict edited --final-file <最終文.txt> --reason "<何を直したかを一言>"`（例: 「敬語を簡潔に」「日程は相手候補を先に」） |
| 「送らない」 | `decide <id> --verdict rejected --reason "<理由>"` |
| 「返信不要」 | `decide <id> --verdict no-reply --reason "<理由>"` |

`decide` のたびに `~/.claude/reply-learning/corrections.jsonl` に（受信本文・相手・分類・Claude の案・kim の最終文・判定・理由・差分率）が 1 行追記され、次回の `context` の例とルール昇格（夜間）に使われる。**直しがあったのに approved で済ませない。**

## 4. 送信（kim が OK と言った番号だけ）

送る直前に必ず `node tools/reply-queue.mjs receipt <id>` を実行する（Discord は Bot トークンでスレッドを取り直す。メール・LINE・Messenger は `--latest-file <json>` に「案を作った後に届いた相手の発言」の配列を渡す。無ければ `[]`）。
- `context_changed`（exit 3）で拒否されたら**送らない**。新着を読んで案を作り直し、再提示する。
- 発行された receipt は 60 秒だけ有効。失効したら `receipt` から取り直す。
- 送ったら `mark-sent <id> --receipt <rid> --message-id <送信後の id>`。送信結果が分からない（タイムアウト・応答なし）ときは **再送せず** `mark-uncertain <id> --reason "<状況>"` にし、送信済みフォルダ等で読み戻せたら `reconcile <id> --message-id <id>`。

| チャネル | 送信方法 |
|---|---|
| Discord | 自動送信（§0）。手動時は `node C:/Users/uers/orgiast-main/tools/discord-dm.mjs <名前> --body-file <file>`（見出し・引用・末尾つき）か `mcp__claude_ai_Discord__reply_message`。送信後に message_id を `mark-sent` に渡す |
| LINE | `powershell -STA -File ~/.claude/tools/line-send.ps1 -SearchFile <検索語.txt> -BodyFile <本文.txt>` を1回実行する（検索→トークを開く→貼り付け→撮影。送信はしない）。line.png で**トーク名**と本文を一字一句確かめてから `line-pc-act.ps1 -Action key -Keys "{ENTER}"` で送る。検索で別のトークが開くことがある（2026-10-23、AI代行堂が開いた）。トーク名が違ったら送らず、入力欄を消して一覧から開き直す。本文は必ず -TextFile で渡す |
| Messenger | 送信ツールが未実装。返信案をそのまま貼れる形で出し、送信ツールの実装を提案する |
| メール | 既定は `create_draft` まで。kim が「送って」と明示した番号だけ `send_message`（draftId 指定）で送る。送信直前に、重複（`in:sent` と同スレッド）と矛盾（過去の送信本文・相手の最新メール・カレンダー）を照会する。送信後は送信済みフォルダで読み戻す。正本は ONBOARDING「外部へのメールは下書きまでが既定」（2026-10-25 kim） |

- OK の出ていないものは送らない。文面を直す指示が出たら直した案を再提示し、改めて OK をもらう。
- 送信後は、送れた件と失敗した件（エラー文つき）を表で報告する。
- 未完了の作業（先方の返信待ち、資料の修正、GUI が空くのを待つ など）が残ったら、**CronCreate で毎時の進捗チェックを登録してから止まる**。kim に「進捗どう？」と聞かせない。変化があった時だけ報告し、全部終わったら CronDelete する。

## 5. 学習ループと精度（夜間に自動）

- 定期タスク OrgiastReplyLearningNightly（毎日 04:40）が `node tools/reply-learning.mjs nightly` を実行: Gmail の下書き→実送信の差分取り込み（seisaku-team@ と kim@、読み取りのみ）→ 修正の型を安いAIで分類し同型 2 件以上を `kim-voice.md` に昇格（既存ルールと矛盾すれば kim-inbox の ask）→ 週次の精度集計 → Discord の漏れ検査（直近 7 日の対象件数と queue 登録数の突き合わせ）。
- 精度は `node tools/reply-learning.mjs metrics` と Google スプレッドシート「返信代行_精度ログ」（kim@orgiast.jp の Drive。id は `~/.claude/reply-learning/sheet-id.txt`）で見る。
- kim が kim-voice.md を直接直してもよい。変更履歴は `kim-voice.changelog.md`。
