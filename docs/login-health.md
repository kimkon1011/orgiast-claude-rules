# login-health (ログイン切れ自動点検・修復・通知)

## 目的
1PC上の各サービス（GitHub, Claude Code, Codex, 安いAIレーン, ブラウザ常駐セッション）のログイン状態を、**対話UIを一切出さず**に自動点検・修復・通知する。
ログイン切れが「枠切れ待ち(quota_wait)」「判定不能」「認証ファイル有り」等に化けて放置される問題を防ぐ。

## 対象サービスと判定基準
| サービス名 | 識別子 | 点検方法 | 状態判定 |
| --- | --- | --- | --- |
| GitHub | `github` | GCM/git credential より PAT 取得 → `GET https://api.github.com/user` & `gh auth status` | PAT有効＋ghログイン済: `ok`<br>PAT有効＋gh未ログイン: `warn`<br>PAT期限7日以内: `warn`<br>PAT無効/gh不可: `fail` |
| Claude Code | `claude` | `claude auth status` | loggedIn=true かつ authMethod=claude.ai: `ok`<br>authMethodがclaude.ai以外（APIキー等）: `fail`<br>未ログイン: `fail` |
| Codex | `codex` | `sc query WslService`, `~/.claude/lane-health.json`, `~/.codex/auth.json` | WslService STOP_PENDING: `fail` (`wsl_hung`)<br>real24h に最新 401: `fail` (`auth_lost`)<br>auth.json 不在/空: `fail`<br>正常: `ok` |
| 安いAIレーン | `ai-lane:<名>` | `~/.claude/lane-health.json` | 最終実測24時間超過: `stale`<br>alive=false: `fail`<br>稼働: `ok` |
| ブラウザセッション | `browser:<名>` | `~/.claude/*/*-session-state.json` | loggedIn=false / needsHuman=true: `fail`<br>checkedAt 6時間超過: `stale`<br>維持: `ok` |

## 直し方（remedy）と自己修復
- **自己修復 (`--fix`) の範囲**:
  - `github`: PATが有効で `gh` だけが未ログインの場合、`gh auth login --with-token` を非対話で実行して修復。
  - `wsl_hung`: `schtasks /run /tn OrgiastWslFix` タスクが登録されていれば自動で実行し、WSLService の凍結を解除。
- **人手操作（remedy）**:
  - デスクトップ上に対応する `.cmd` ショートカット（例: `Codexログイン（ダブルクリック）.cmd`, `WSL-fix.cmd`）が存在する場合はそれを提示。
  - 存在しない場合は実行可能な1コマンドを提示。

## 定期実行タスクと通知
- 定期タスク名: `OrgiastLoginHealth` (2時間ごとに非対話で実行)
- 実行コマンド: `node tools/login-health.mjs --fix --notify` (kim-PC では `--fleet` も付加)
- `kim-inbox` 通知: `dedupeKey` (`login-health:<host>:<id>`) により 1サービス1件の ask を upsert。復旧時は自動で close。

## 解除手順（タスク削除コマンド）
```powershell
schtasks /delete /tn OrgiastLoginHealth /f
```
また、WSL自動修復タスクが登録されている場合:
```powershell
schtasks /delete /tn OrgiastWslFix /f
```
