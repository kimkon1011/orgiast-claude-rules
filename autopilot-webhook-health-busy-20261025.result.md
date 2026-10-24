# webhook-health busy 調査・修正結果 (2026-10-25)

## 真因

GAS fleet sheet の共有 ScriptLock を20秒以内に取得できず、JSONの {ok:false,status:503,error:'busy'} が返り、再試行なしの postSheet が例外終了していた。Discord 429 / SQLite / ローカルJSONファイルの EBUSY ではない。

直近7日（10月19日〜25日）の実ログ。ログ時刻は夜間バッチ側のローカル時刻 (JST)。

```text
nightly-batch-2026-10-19.log: 2026-10-19 04:00:55 / webhook-health / ok
nightly-batch-2026-10-20.log: 2026-10-20 03:39:07 / webhook-health / ok
nightly-batch-2026-10-21.log: 2026-10-21 04:20:48 / webhook-health / ok
nightly-batch-2026-10-22.log: 2026-10-22 04:56:28 / webhook-health / ok
nightly-batch-2026-10-23.log: 2026-10-23 06:43:33 / webhook-health / ok
nightly-batch-2026-10-24.log: 2026-10-24 05:49:22 / webhook-health / ok
nightly-batch-2026-10-25.log: 2026-10-25 03:20:46 / webhook-health / error:終了コード1: Error: fleet sheet rejected request: busy / at postSheet (file:///C:/Users/uers/.claude/nightly-repo/tools/webhook-health.mjs:170:23) / at process.processTicksAndRejections (node:internal/process/task_queues:104:5) / at async run (file:///C:/Users/uers/.claude/nightly-repo/tools/webhook-health.mjs:255:20)
```

- ログ出力先: tools/nightly-batch.ps1:5-12 の $HOME/.claude/logs/nightly-batch-yyyy-MM-dd.log。Write-NightlyStepResult は同ファイル:22-26で失敗詳細を保存する。
- スタックの旧 tools/webhook-health.mjs:170 が body.ok=false を例外にした位置。現行 tools/webhook-health.mjs:167 から postWebhookSheet(:170)へ委譲、:184-189 が busy 判定と最終エラー。
- gas/fleet-status-sheet/WebApp.gs:123 が kind=webhooks を upsertWebhookLedger に振り分ける。gas/fleet-status-sheet/WebhookLedger.gs:34 の getScriptLock().tryLock(20000) 失敗が busy の生成元。処理後は finally (:48) で解放する。WebApp.gs:2 の ContentService JSON 応答は status:503 をJSON内に保持するため HTTP 200 の body も判定する必要がある。
- 10/25 03:20:23 discord-channels ok → 03:20:46 webhook-health busy → 03:21:30 keyserve-status ok。nightly-batch.ps1:558-581 は逐次実行で、前ステップから約23秒後の失敗は20秒ロック待機と整合する。10/20 03:38:52 の discord-channels にも同じ fleet sheet rejected request: busy がある。
- cost-loop.mjs:72-79 は webhook-health --fix をバックグラウンド起動するが --post-sheet は付けない。morning-batch.mjs はDiscord取り込み・通知経路でfleet sheetへのpostはない。discord-webhook.mjs:31 は --create 時にkind=webhooksを送るため競合候補にはなるが、当該時刻の実行証拠はない。GAS内の他kindも同じ ScriptLock を使う。ロック保持リクエストの具体的なジョブ/PCはローカルログから特定できない。

## 変更ファイル

- tools/webhook-health.mjs: シート送信処理を postWebhookSheet に抽出。明示的なbusy応答のみ最大3試行、待機1秒・2秒。同一のシリアライズ済みpayloadを使用。恒久エラー/不正JSON/通信失敗は従来通り失敗。拒否理由は redactSecrets で伏せる。通常のstdout、台帳merge、Discord通知条件は変更なし。
- tools/webhook-health.test.mjs: busy→成功、3試行上限、HTTP 503 busy、再試行しないケース、payload保持、秘密の伏字を追加。既存4テストは維持。
- diff: 2 files changed, 96 insertions(+), 5 deletions(-)。git diff --check 成功。
- 一時クローン /tmp/webhook-health-busy-retry-repo のブランチ fix/webhook-health-busy-retry にコミット c4869a8。指定の Co-Authored-By を付与。git push / PR作成は実行していない。
- 元repoの.gitは読み取り専用でブランチ作成不可。調査中に外部の auto-session-rescue が変更2ファイルを 3526f52 (auto-session-rescue-20261025-071203) に自動コミットしたことを確認。一時クローンではこの同一差分を指定メッセージにamendした。元repoの履歴は変更していない。
- 一時領域消失への備えとして、元repo直下に webhook-health-busy-retry.bundle を保存。基点 e6e20f5 からの1コミットのみを収録。

## テスト

実行: node --test tools/webhook-health.test.mjs

exit code: 0 / tests: 14 / pass: 14 / fail: 0 / cancelled: 0 / skipped: 0 / todo: 0

## 実行結果

実行は1回のみ。--post-sheet も死亡webhookがあればDiscordへPOSTする実装 (tools/webhook-health.mjs:265-267) のため、ユーザー指定の例外に従い --dry-run を追加。これは通知とローカル台帳更新を抑止し、シート送信 (:275-277) は行う。

WSLの /home/kim/.claude に fleet-sheet.env がないため、一時preloadで os.homedir() を /mnt/c/Users/uers に設定し、実際のWindows側設定・台帳を参照した。環境変数HOMEは変更していない。既存 REPORTER_HOST と実行ホストは一致。preloadは追加防御としてDiscord宛GET以外を拒否する。fetchレスポンスのモックは使っていない。

command: node --import /tmp/webhook-health-safe-home.mjs tools/webhook-health.mjs --post-sheet --dry-run
startedAt (UTC): 2026-10-24T22:12:34.715Z
endedAt (UTC): 2026-10-24T22:12:37.931Z
exit code: 0
signal: null

stdout (全文、伏字処理済み):
```text
Discord webhook health: alive=4 dead=0 error=0
```
stderr (全文): 空

skipメッセージなし、例外なしで postSheet が完了。今回busyは再現せず、再試行分岐は単体テストで検証。Discord投稿・DM送信は実行していない。

## 未解決

- GAS共有ロックを占有していた具体的リクエストは未特定。確認場所: /mnt/c/Users/uers/.claude 直下のlog/jsonl、同logs直下（30MB以下のlog/jsonlを日時・webhook-health・03:20で検索）、nightly-batch-2026-10-19〜25.log、nightly-bootstrap系ログ、fleet-sheet/morning系ログ、/home/kim/.claude（該当ログなし）。GAS実行履歴はこの環境から取得していない。
- 長時間のロック占有では最大3試行でも失敗しうる。その場合は既存と同じ終了コード1で理由を保持する。
- 元repoでの指定ブランチ作成は権限制約のため未完了。一時クローンとbundleに指定ブランチ・コミットを保存済み。
- 指定結果パス /mnt/c/Users/uers/.claude/scratchpad/autopilot-webhook-health-busy-20261025.result.md への書き込み不可 (EROFS)。書き込み許可範囲内のrepo直下に代替保存した。
