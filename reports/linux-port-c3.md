# C③ hooks 移植 — 検証結果（2026-10-19）

## 変更

- `tools/session-triage-hook.mjs` を新規追加（`tools/session-triage-hook.ps1` の移植）。ps1 は node を呼ぶだけの薄いラッパに縮小。
- `tools/register-hooks.mjs`
  - 配布 hook を `node "<repo>/tools/*.mjs"` 形式に統一。既存の同名 `.ps1` 登録はその場で `.mjs` コマンドへ置換（総数を減らさない）。
  - `session-triage-hook.ps1` を `.mjs` へ移行して SessionStart に登録。
  - `ORGIAST_PLATFORM` が `win32` 以外のとき、ユーザー定義分も含め `pwsh/powershell/.ps1` を含む hook を生成物から除去（`stripPowerShellHooks`）。Windows では no-op。
  - 同期途中のツリー（`tools/lib/` 未同期）でも落ちないよう、platform 判定は静的 import にしない。
- `tools/linux-port/check-hooks.mjs` を新規追加。配布正本（`register-hooks.mjs --expected-json`）または `--settings <file>` の hook を数え、linux/darwin は PowerShell 依存 0 を必須化。win32 は `reports/linux-port-hooks.baseline.json` に対して総数の減少を検出。
- `tools/linux-port/inventory.mjs` に `distributionHooksTotal` / `distributionPwshHooksTotal` を追加（hooks 計測を配布正本まで拡張）。

## 実測

| コマンド | 結果 |
| --- | --- |
| `node tools/linux-port/check-hooks.mjs --platform linux` | `hook total: 52` / `pwsh-dependent hooks: 0` / exit 0 |
| `node tools/linux-port/check-hooks.mjs --platform win32 --write-baseline` | `hook total: 52` / `pwsh-dependent hooks: 0` / exit 0 |
| `node tools/linux-port/check-hooks.mjs --platform win32 --settings ~/.claude/settings.json` | 実PC `hook total: 86` / `pwsh-dependent hooks: 19`（Windows の既存登録。自動移行対象） |
| `node tools/linux-port/inventory.mjs --check` | `Inventory ratchet passed` |
| `node --test tools/register-hooks.test.mjs` | 22 pass / 0 fail |
| `node --test tools/linux-port/check-hooks.test.mjs tools/session-triage-hook.test.mjs tools/linux-port/inventory.test.mjs` | 9 pass / 0 fail |

注: 計画時の調査値は 71 hook / 19 pwsh だったが、2026-10-19 の実PC settings.json は 86 hook / 19 pwsh。総数の差は計画後に追加された hook によるもので、本変更は総数を減らさずに PowerShell 依存を 0 にする。実PCへの収束（register-hooks 実行）は本タスクでは行っていない（HUMAN_GATE: 本番 settings.json への配布）。
