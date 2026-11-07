# RC preservation work

着手: 2026-11-06 / Codex / fix/rc-keep-unclosed-sessions。
目的: 未クローズセッションの夜間 RC 切断防止と host_exit 復旧。実再オープン・タスク登録・push は実施しない。

## 実装

- 夜間 URI reload / Restart / RESUME-RETRY の前に、未クローズで実会話がある interactive セッションを保護。一覧不明は安全側にスキップ。Overdue でもバイパスしない。
- 旧 ClaudeNightlyReloadVSCode は登録時に無効化し、削除しない。
- host_exit とローカル transcript を照合して復旧。起動時刻±15分、API取得60秒上限、既定最大30件・10秒間隔、10分 stale の heartbeat ロック。
- ログオン3分後の隠しタスク登録を既存 setup --converge の convergeNightlyReload 経路へ追加。
- dry-run は読み取り専用（ユーザー指定の作業ツリー外変更禁止に従い、実ユーザーのログ・ロックも作らない）。
- process-hygiene は変更していない。API利用は RC 管理情報の GET のみで、LLM呼び出しは追加していない。

## テスト

```
node --test tools/reopen-lost-sessions.test.mjs tools/setup-nightly-reload.test.mjs tools/restore-remote-sessions.test.mjs tools/process-hygiene.test.mjs tools/setup-manifest-onboarding.test.mjs
```

79件成功、失敗0。

```
node --test tools/setup.test.mjs
```

31件成功、失敗0、Windows限定1件はLinux実行のためskip。

以下3ファイルを、それぞれ Windows PowerShell 5.1 と PowerShell 7 の `-NoProfile -File` で実行。タスク登録はモックで、実タスクは変更していない。

```
tools/nightly-reload-vscode.test.ps1
tools/register-nightly-reload-vscode.test.ps1
tools/register-reopen-lost-sessions.test.ps1
```

## コミットを妨げた環境制限

`git add` が以下で失敗。権限回避・別経路による Git 管理領域の変更は行っていない。

```
fatal: Unable to create '/mnt/c/Users/uers/.claude/nightly-repo/.git/worktrees/wt-rc-keep/index.lock': Read-only file system
```

変更は本作業ツリーに保持。コミット・push・実セッション再オープン・実タスク登録は未実施。

最終検証: 両 PowerShell の nightly テスト（inventory / ledger / transcript 結合テストを含む）は成功。登録スクリプト2本も両 PowerShell で成功。`git diff --check` 成功。

実データ dry-run（Windows node.exe、実ユーザーの認証・projects・agents を使用）:

```
node tools/reopen-lost-sessions.mjs --dry-run --since 2026-11-05T19:40:00Z --until 2026-11-05T20:15:00Z
```

終了コード0。候補4件、除外 closed=1 / empty=0 / alive=0 / noLocal=7、reopened=0。全文は同じディレクトリの rc-keep-dry-run.json。
初回の空cursorによるHTTP400を修正し、取得並列数6と更新時刻による対象絞り込みでAPI60秒上限内に完了。RC記録のないtranscriptはJSON解析せず、実データ照合を軽量化した。

変更ファイル:

- protocols/INCIDENT-TYPES.md
- tools/nightly-reload-vscode.ps1
- tools/nightly-reload-vscode.test.ps1
- tools/register-nightly-reload-vscode.ps1
- tools/register-nightly-reload-vscode.test.ps1
- tools/reopen-lost-sessions.mjs
- tools/reopen-lost-sessions.test.mjs
- tools/register-reopen-lost-sessions.ps1
- tools/register-reopen-lost-sessions.test.ps1
- tools/setup-nightly-reload.mjs
- tools/setup-nightly-reload.test.mjs
- reports/rc-keep-work.md
- reports/rc-keep-dry-run.json
