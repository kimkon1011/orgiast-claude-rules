# schedule-sync

LINE・Discord・Gmail の日時付きメッセージから、kim@orgiast.jp の primary
カレンダーへ確度の高い将来の新規予定を登録する。medium は Discord DM の
確認候補だけにする。変更・取消・過去・仮定は予定を変更しない。

```sh
node tools/schedule-sync.mjs --dry-run --since 2026-10-15T00:00:00+09:00 --source gmail,discord --json
node tools/schedule-sync.mjs
```

`--source` は line,discord,gmail（省略時は全て）。初回は直近48時間、以降は
ソースごとのカーソル以降を処理する。初回の開始境界も保存し、中断後の再実行で
未処理の古いメッセージが移動する48時間窓から脱落するのを防ぐ。Gmail は既存 searchGmail のページングを
使い、受信日時で絞る。Discord は既存のチャンネル列挙・active 判定・履歴取得を
使い、Bot が読めるテキスト/announcement チャンネルを対象とする。
403/404 の件数を stderr に出す。Bot/webhook の投稿は再取り込みを避けるため除外。

LINE の対象外チャットは claude-mobile の候補フィルタを経由して
`~/.claude/schedule-inbox/line-YYYY-MM.jsonl` に届く。通常会話と未展開通知変数は
この受信箱へ保存しない。既存の allowlist 経路は従来の open-chat ストアを使う。
受信時刻でカーソルを切り、通知の遅延配信も拾う。受信側の内容ハッシュが同じでも
別日時の発言は別メッセージとして扱う。

LLM は既存 llm-ask.mjs の `--category extraction` を使う。送信日時と原文を渡し、
JSON スキーマ・JST日時・原文引用を検証する。形式不正は1回再試行後に記録して
スキップ、通信失敗はエラーにしてカーソルを保持する。

## 認証

- DWD: `tools/lib/drive-auth.mjs` の既定 SA ファイル、または `GOOGLE_SA_KEY`。
- impersonate: `kim@orgiast.jp`。
- Calendar: `https://www.googleapis.com/auth/calendar.events`。
- Gmail: 既存 gmail.readonly の委任も必要。
- Discord: `DISCORD_BOT_TOKEN` または `~/.claude/orgiast-discord-bot-token.txt`。
- LLM: llm-ask の既存設定。`ORGIAST_HOME` は設定・受信箱・状態のホームを指定できる。

Calendar DWD が拒否されたら、エラーと SA の client_id、追加すべき scope を表示して
非0終了する。dry-run だけは候補抽出を続け、`calendar-unverified` と `ok:false` を
返す。この状態で重複判定成功・作成可能とは扱わない。

## 永続化と再試行

`~/.claude/schedule-sync/state.json` はソース別カーソル、`ledger.jsonl` は抽出計画、
処理結果と eventId、報告済み記録を保存する。抽出計画は insert 前に fsync する。
予定 ID をメッセージ ID と抽出項目番号から固定生成し、insert の応答喪失後は
同じ ID を取得して回復する。異なるソースの既存予定は start 前後3時間の
Calendar 一覧をページングし、時間重複とタイトルの類似で除外する。

DM はリンクを省略しない長さで分割する。DM 失敗時は次回に未報告分を再送する。
送信成功と台帳記録の間にプロセスが停止した場合、DM だけは重複し得る。
抽出計画はローカルに原文を含むため、状態ディレクトリを共有・Git登録しない。
壊れた状態/台帳は黙って初期化せず停止する。

`--dry-run` は Calendar 登録、DM、カーソル、台帳、lock、LLM 利用ログと
プロバイダー状態を書き換えない。読み取り API と有料になり得る LLM 推論は行う。

## 30分タスク

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\register-schedule-sync-task.ps1 -DryRun
powershell -NoProfile -ExecutionPolicy Bypass -File tools\register-schedule-sync-task.ps1
```

`OrgiastScheduleSync` は30分間隔、同時実行禁止、25分タイムアウト。
実行元は必ず `%USERPROFILE%\.claude\nightly-repo`。main の同期前は登録を失敗させ、
古い開発コピーへフォールバックしない。PowerShell ファイルは BOM付きUTF-8/CRLF。

新規 install-orgiast.ps1 と既存 fleet-poller.ps1 の日次自己修復から `-Ensure` を呼ぶ。
`-Ensure` は `%USERPROFILE%\Downloads\claude-mobile\app\api\line-ingest\route.ts` が
存在する LINE 受信機だけで登録する。全フリートから kim の予定を重複収集しない。
受信機を別のパスへ移す場合は登録スクリプトを直接実行する。
既存タスクが無効化されている場合も自己修復する。

Calendar の API 仕様: [events.list](https://developers.google.com/calendar/api/v3/reference/events/list)、
[events.insert](https://developers.google.com/workspace/calendar/api/v3/reference/events/insert)。

## 検証

```sh
node --test tools/schedule-sync.test.mjs tools/gmail-search.test.mjs tools/discord-digest.test.mjs tools/discord-task-digest.test.mjs tools/discord-dm.test.mjs tools/llm-fallback.test.mjs tools/register-nightly-tools.test.mjs tools/fleet-poller-specs.test.mjs tools/fleet-poller-dry.test.mjs
```

Windows Task Scheduler の実登録・次回実行は main 同期後に Windows 上で確認する。
claude-mobile の反映には受信サービスの後日のビルド・再起動が必要。
