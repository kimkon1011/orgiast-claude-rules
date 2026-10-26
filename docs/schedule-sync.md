# schedule-sync

LINE・Discord・Gmail の日時付きメッセージから、kim@orgiast.jp の primary
カレンダーへ確度の高い将来の新規予定を登録する。medium は Discord DM の
確認候補だけにする。変更・取消・過去・仮定は予定を変更しない。

```sh
node tools/schedule-sync.mjs --dry-run --since 2026-10-20T00:00:00+09:00 --source line,gmail,discord --json
node tools/schedule-sync.mjs
```

`--source` は line,discord,gmail（省略時は全て）。初回は直近48時間、以降は
ソースごとのカーソル以降を処理する。初回の開始境界も保存し、中断後の再実行で
未処理の古いメッセージが移動する48時間窓から脱落するのを防ぐ。Gmail は既存 searchGmail のページングを
使い、受信日時で絞る。Discord は既存のチャンネル列挙・active 判定・履歴取得を
使い、Bot が読めるテキスト/announcement チャンネルを対象とする。
Gmail は List-Unsubscribe、promotions/social/forums、noreply/no-reply/notifications 系の
送信元と Gemini 自動会議メモ（gemini-notes@google.com）を LLM に渡す前に除外する。
403/404 の件数を stderr に出し、読み取り不可チャンネルを state の `discordDenied` に
24時間キャッシュする。期限後に再確認し、読めるようになればキャッシュを削除する。
Bot/webhook の投稿は再取り込みを避けるため除外。

LINE の対象外チャットは claude-mobile の候補フィルタを経由して
`~/.claude/schedule-inbox/line-YYYY-MM.jsonl` に届く。通常会話と未展開通知変数は
この受信箱へ保存しない。既存の allowlist 経路は従来の open-chat ストアを使う。
受信時刻でカーソルを切り、通知の遅延配信も拾う。受信側の内容ハッシュが同じでも
別日時の発言は別メッセージとして扱う。

LLM は既存 llm-ask.mjs の `--category extraction` を使う。既定では
`--provider gemini --prefer-provider` で Gemini を先頭候補にし、既存のフォールバック・
cooldown・予算制御を維持する。`--llm-provider auto` で実測表による自動選択へ戻せる。
`--per-provider-timeout-ms N`（既定45000）を llm-ask に渡し、各プロバイダの
通信・本文受信・再試行待機を合計45秒に制限する。期限切れは同じ候補を再試行せず次へ進む。
子プロセスの期限は `(フォールバック連鎖数 + 1) × N + 30000` ms（現在480秒）。
全体の `--timeout-ms` は別途適用される。
共通 llm-ask のカテゴリ自動選択は `--prefer-provider` を渡さない呼び出しでは従来通り。
送信日時と原文を渡し、
JSON スキーマ・JST日時・原文引用を検証する。最大10件を1呼び出しにまとめ、既定で
同時3バッチを実行する。各入力の出典を含む一意な id を返させ、順序に依存せず照合する。
全 id の存在・重複なし・各原文の引用を検証し、形式不正は1回再試行する。
llm-ask の既存プロバイダフォールバックを維持し、プロバイダ名・HTTPステータス・
メッセージ先頭・子プロセス終了情報を stderr に残す。再試行後の形式不正や通信失敗は
バッチを半分に分割して再試行し、最終的に1件まで分離する。
1件でも失敗したら ledger に `failed` と `attempts`、原文を保存する。失敗回数は
1実行につき1回加算し、3回目で `skipped` として完了記録・ログを残す。
成功分は通常処理し、再試行対象の最古の受信時刻を含む位置までカーソルを進める。
保存済み計画と失敗メッセージは、取得元から消えても台帳から再開する。
部分成功は警告付き exit 0、抽出が全件失敗なら exit 1（3回目のskipでもカーソルは進む）。
JSON の `counts.failed` / `counts.skipped` はメッセージ数、その他のstatusは予定数。
予定なしの抽出成功も `successful` に数える。
4,000字超の本文は日時表現の周辺の原文を最大4,000字に切り出す。
引用検証には原文全体を使い、UTF-8 一時ファイルは成功・失敗とも削除する。

1回の処理は受信日時順に既定60件まで。上限を超えた分は次回へ回す。
ソースごとのカーソルは最古の未処理メッセージの受信時刻を超えない（境界を含めて再取得）。
同時刻の複数投稿は台帳で処理済み分だけを省き、LINE は送信日時でなく受信日時を使う。
日時候補でないメッセージは上限を消費しない。JSON に processed/deferred/durationMs を返す。
`--max-messages N`、`--batch-size N`（最大10）、`--concurrency N`（最大4）、
`--timeout-ms N`（既定1200000＝20分）で変更できる。
タイムアウトは収集・抽出・Calendar・通知を含み、通信と LLM 子プロセスを中断する。
完了前に中断した場合はカーソルを確定せず、次回に保存済み計画・結果から回復する。

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

2026-10-22、DWD クライアントID `110910358431552197763` に `calendar.events` を追加済み。
同スコープで kim@orgiast.jp のトークンを取得し、primary の 2026-10-26（JST）を
`events.list` で読み取れた（12件）。既存の「【ラハイナ】全社mtg」12:00〜13:00 を確認済み。

## 永続化と再試行

`~/.claude/schedule-sync/state.json` はソース別カーソルとDiscord不可チャンネルの再確認期限、
`ledger.jsonl` は抽出計画、失敗回数、skip、処理結果と eventId、報告済み記録を保存する。
抽出計画は insert 前に fsync する。
予定 ID をメッセージ ID と抽出項目番号から固定生成し、insert の応答喪失後は
同じ ID を取得して回復する。異なるソースの既存予定は start 前後3時間の
Calendar 一覧をページングし、時間重複とタイトルの類似で除外する。

DM はリンクを省略しない長さで分割する。DM 失敗時は次回に未報告分を再送する。
送信成功と台帳記録の間にプロセスが停止した場合、DM だけは重複し得る。
抽出計画はローカルに原文を含むため、状態ディレクトリを共有・Git登録しない。
壊れた状態/台帳は黙って初期化せず停止する。

`--dry-run` は Calendar 登録、DM、カーソル、台帳、Discord不可キャッシュ、永続 lock、LLM 利用ログと
プロバイダー状態を書き換えない。読み取り API と有料になり得る LLM 推論は行う。
OS 一時ディレクトリの共通ロックで dry-run を含む同じ状態ディレクトリの多重起動を防ぐ。
本番では従来の state ディレクトリ内の run.lock も維持する。終了時にロックを解放する。

## 30分タスク

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\register-schedule-sync-task.ps1 -DryRun
powershell -NoProfile -ExecutionPolicy Bypass -File tools\register-schedule-sync-task.ps1
```

`OrgiastScheduleSync` は30分間隔、同時実行禁止、25分タイムアウト。
実行元は共通ヘルパーが解決する同期先（既定 `$HOME\.claude\nightly-repo`、
`ORGIAST_NIGHTLY_REPO` で変更可能）。main の同期前は登録を失敗させ、
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
node --test tools/schedule-sync.test.mjs tools/llm-ask.test.mjs tools/batch-model-consistency.test.mjs tools/gemini-instrumentation.test.mjs tools/gmail-search.test.mjs tools/discord-digest.test.mjs tools/discord-task-digest.test.mjs tools/discord-dm.test.mjs tools/llm-fallback.test.mjs tools/register-nightly-tools.test.mjs tools/fleet-poller-specs.test.mjs tools/fleet-poller-dry.test.mjs
```

Windows Task Scheduler の実登録・次回実行は main 同期後に Windows 上で確認する。
claude-mobile の反映には受信サービスの後日のビルド・再起動が必要。

2026-10-23 の実データ dry-run（`--since 2026-10-20T00:00:00+09:00 --source line,gmail,discord --json`）は exit 0 / ok:true、156.943秒（約2分37秒）。LINE 0件・Gmail 81件・Discord 130件を収集し、日時候補外143件を除外、60件処理・8件を次回へ繰り越し。status は created 0 / would-create 0 / review 0 / duplicate 0 / ignored 3 / calendar-unverified 0、invalid 0。would-create 一覧は空。Calendar 登録・DM・カーソル・台帳の更新は0件。Discord は4チャンネル読取可、125チャンネルは403/404。

既存141件＋追加13件のテストは154 pass / 0 fail。

2026-10-23、LLM耐性修正後の通常 `--dry-run --json`（WSL、Windowsの認証・state参照）は
exit 0 / ok:true、95.819秒。LINE 0 / Discord 124 / Gmail 48、候補外131、
処理41 / 成功41 / deferred 0。statusは ignored 2、created / would-create / review /
duplicate / calendar-unverified / failed / skipped は全て0、would-create一覧は空。
Groqの予算不足・HTTP429とGLMのクールダウンを観測し、Gensparkへの既存フォールバックで回復した。
元の一律エラーで隠された初回停止のHTTP種別は再現できず、断定しない。
一方、1バッチの例外で全体を中断して成功分の登録とカーソル更新を止める経路は修正・スタブ検証済み。
