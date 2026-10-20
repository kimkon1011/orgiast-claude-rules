# C④-1 定期タスク移行の棚卸し — 検証結果（2026-10-20）

## 範囲

C④ のうち、まず移行対象を機械的に確定する部分だけを実施した（実際の `register-*.mjs` 化は次段）。
指示書 C④ の「register-*.ps1 約30本を tools/register-*.mjs へ」「config/scheduled-tasks.json を唯一の定義にする」の元データを作る。

## 変更

- `tools/linux-port/task-inventory.mjs` を新規追加。`tools/register-*.ps1` から
  タスク名（`$taskName=` / `$names=@()` / `Register-ScheduledTask -TaskName` / `TaskName=` / hashtable の `Name=`）、
  時刻（`-At` と `At=`）、繰り返し分（`-RepetitionInterval` のみ。`-ExecutionTimeLimit` の `-Minutes` は除外）、
  実行対象（`tools\*.mjs|ps1` と `ScriptName=`）を静的に抽出し、対応する `.mjs` の有無を数える。
  `--json` / `--write`（`reports/linux-port-tasks.{json,md}`）/ `--check`（抽出できない ps1 があれば exit 1、計測対象ゼロなら exit 2）。
- `tools/linux-port/task-inventory.test.mjs` を新規追加（6 tests）。
- `tools/linux-port/inventory.mjs`: `tools/linux-port/` 配下を Windows 依存の計測対象から除外（移植ツール自身が計測用に `schtasks` 等の語を含むため）。生成物 `linux-port-tasks.{json,md}` も除外。
- `tools/linux-port/check-hooks.mjs`: `--settings` 指定時は win32 ベースライン比較を行わないよう修正。C③ で追加された test「win32 keeps accepting PowerShell hooks」が、実PC一部の settings（1 hook）を 52 hook のベースラインと比較して必ず落ちる状態だった（C③ の報告「9 pass」と食い違う既存不具合。本変更で 13 pass に回復）。

## 実測（2026-10-20 / HEAD 1e835b9 + 本変更）

| コマンド | 結果 |
| --- | --- |
| `node --test tools/linux-port/task-inventory.test.mjs tools/linux-port/inventory.test.mjs tools/linux-port/check-hooks.test.mjs` | 13 pass / 0 fail |
| `node tools/linux-port/task-inventory.mjs --write` | `ps1=31 tasks=37 mjs=5` |
| `node tools/linux-port/task-inventory.mjs --check` | exit 0（タスク名を抽出できない ps1: 0） |
| `node tools/linux-port/inventory.mjs --check` | `Inventory ratchet passed` |

抽出結果の要点:

- register-*.ps1: 31 本、タスク名 37 件（1 ps1 が複数タスクを持つもの: auto-progress 2件、nightly-tools 2件、role-sessions 3件など）。
- 対応する `register-*.mjs` がある ps1: 5/31（auto-progress / decision-watch / fleet-mail / stalled-session-nightly / stall-sweeper など）。
- ps1 内の `schtasks` 直書きは 2 箇所、`taskkill` / レジストリ参照は 0 箇所。Windows 専用呼び出しの大半は ps1 の `New-ScheduledTask*` / `Register-ScheduledTask` 側にある。
- 一覧は `reports/linux-port-tasks.md`（全31行）。

## 残り（次段以降）

1. `reports/linux-port-tasks.json` を元に `config/scheduled-tasks.json` を確定し、`tools/register-*.mjs` を task-scheduler.mjs 経由へ移行（既存 Windows タスク名 `Orgiast*` と task-scheduler の `orgiast-` 接頭辞の互換を先に決める）。
2. `taskkill` → `process.kill` 相当、レジストリ参照の platform 分岐、`H:\` → rclone mount（`~/GoogleDrive`、systemd user service）。
3. `C:\Users\...` 直書き 80 ファイル 193 行（2026-10-20 棚卸し値）の `os.homedir()` / `path` 置換。

実機（R640 / Ubuntu）での systemd timer 登録は未検証（実機なし）。
