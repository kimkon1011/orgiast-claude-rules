# webhook-health 本番実走検証（2026-10-25 JST）

## 前提確認

- cwd: /mnt/c/Users/uers/.claude/nightly-repo
- 最初の git status --short は出力なし（clean）。その直後の git log --oneline -1 は dda1d4c auto-session-rescue-20261025-072209。指定の e6e20f5 とは異なっていた。
- dda1d4c の変更は fleet-directives.json のみ。対象2ファイルの e6e20f5..HEAD 差分はなく、対象ファイルに未コミット変更もなかったため、指定修正の適用を継続した。
- 並行して実行した status/log では HEAD が e6e20f5 に変わり、fleet-directives.json の staged 変更を観測した。この検証では branch/commit/index 操作を一切行っていない。外部の並行処理による状態変動に注意。
- git show 3526f52 -- tools/webhook-health.mjs tools/webhook-health.test.mjs | git apply で適用。
- 適用直後の git diff --stat -- tools/webhook-health.mjs tools/webhook-health.test.mjs:

```text
 tools/webhook-health.mjs      | 29 ++++++++++++++---
 tools/webhook-health.test.mjs | 72 ++++++++++++++++++++++++++++++++++++++++++-
 2 files changed, 96 insertions(+), 5 deletions(-)
```

## テスト

コマンド: `node --test tools/webhook-health.test.mjs`

exit code: 0。14 tests / pass 14 / fail 0（サブテスト含む）。

```text
✔ 指定の正規表現でwebhook URLを抽出する (12.8727ms)
✔ 生存確認結果を既存台帳へマージし、tokenは保存しない (1.0042ms)
✔ 置換候補は同一チャンネルの生存webhookだけ (0.6598ms)
✔ ログ用マスクはtokenを一切残さない (1.9106ms)
✔ HTTP 200 busy はバックオフ後に同じ台帳payloadを再送する（最大3試行） (11.198801ms)
✔ busy が続いても3試行で終了し最後の失敗理由を保持する (1.7385ms)
✔ HTTP 503 の明示的な busy 応答も再試行する (1.0862ms)
▶ 成功・恒久的な拒否・不正JSON・通信失敗は再送しない
  ✔ success (0.7341ms)
  ✔ rejected (0.578ms)
  ✔ http (0.6526ms)
  ✔ invalid JSON (0.6098ms)
  ✔ network (0.6582ms)
✔ 成功・恒久的な拒否・不正JSON・通信失敗は再送しない (16.2615ms)
✔ シートの拒否理由に含まれるwebhook秘密を伏せる (0.784ms)
ℹ tests 14
ℹ suites 0
ℹ pass 14
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 511.290909
```

## 実走

コマンド: `node --import /tmp/webhook-health-safe-home.mjs tools/webhook-health.mjs --post-sheet --dry-run`

- 開始 UTC: 2026-10-24T22:25:38.993Z
- 終了 UTC: 2026-10-24T22:25:49.169Z
- exit code: 0
- signal: なし
- 実行回数: 1回。
- preload は os.homedir() を /mnt/c/Users/uers に設定。fetch は Discord webhook 宛 GET と設定済み fleet sheet 宛 POST のみ許可。他の直接リクエストを拒否し、Discord GET のリダイレクトも拒否。fleet sheet の通常リダイレクトは許可。
- --dry-run により Discord 通知とローカル台帳更新を抑止。fleet-sheet.env は存在し、reporter 解決でも書換不要であることを事前確認。
- URL・トークンを伏せて stdout/stderr を保存。以下は省略なし。

stdout:

```text
Discord webhook health: alive=4 dead=0 error=0
```

stderr:

```text
```

stderr は空。

## 判定

- fleet sheet への POST は成功と判定。設定あり、skip 出力なし、exit code 0。実装は POST の HTTP 成功かつ JSON body.ok が真の場合のみ通常結果出力へ進むため、その制御フローに基づく判定。HTTP 応答本文やシートの独立 read-back は取得していない。
- webhook 生存確認: alive=4 / dead=0 / error=0。
- busy/再試行: 再試行の有無はこの実行では観測不能。修正版は busy と再試行のログを出さず、最終成功時に途中の応答を表示しない。busy が無かったとは断定しない。
- busy の最大3試行・バックオフ・HTTP 503 busy 等の挙動は上記単体テストで通過。

## 未解決

- 本番実走で busy 再試行分岐が発生した証拠はない。
- 作業中の HEAD/index 変動を観測。監督が commit/PR 前に最新状態を再確認する必要がある。
- 新規コード変更は行わず、指定コミットの対象2ファイルの差分を残した。git commit / push / PR / branch 作成、Discord 投稿・DM は行っていない。

最終内容確認: 対象2ファイルはそれぞれ `git show 3526f52:<path>` の内容とバイト単位で一致。結果ファイルの必須5節も確認済み。
