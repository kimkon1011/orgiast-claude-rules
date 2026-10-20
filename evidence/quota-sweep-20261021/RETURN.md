TASK_ID: quota-sweep-20261021

STATUS: BLOCKED — 実装・検証済み。Git 管理領域と実ホームが read-only のため未コミット・未配備。

RESULT:
- 残枠判定、Claude/Codex の手動 tick、独立 watchdog、WSL SIGKILL timeout、対話ガード、重複防止、再試行上限、PR/レジャ/DM 処理を実装。
- makeloop の導入・EBUSY ローカル clone 代替・読戻し、15分タスクの登録、setup manifest 3項目、文書を追加。
- 作業ブランチは feat/quota-sweep。push・PR作成・マージ・実モデル tick は今回実行していない。テストでは子プロセスや通知を注入し、実プロセス終了テストだけ無害な Node 子を起動した。
- 指定外の外部配備・別バックエンドへの委譲は行っていない。

ARTIFACTS:
- tools/lib/quota-windows.mjs / quota-windows.test.mjs
- tools/quota-sweep.mjs / quota-sweep.test.mjs / quota-sweep-contract.tmpl.md
- tools/lib/quota-sweep-host.mjs / quota-sweep-process.mjs / quota-sweep-watchdog.mjs
- tools/install-makeloop.mjs / install-makeloop.test.mjs
- tools/register-quota-sweep.mjs / register-quota-sweep.ps1 (UTF-8 BOM)
- tools/lib/scheduled-task.mjs / scheduled-task.test.mjs、tools/setup-manifest.json
- docs/quota-sweep.md、evidence/quota-sweep-20261021/

VERIFICATION:

1. 指定テスト一式（exit 0）。実行環境 Node v24.19.0。Windows専用 shim テスト1件はこのLinux実行ではSKIP。Node22実機の検証は未実施。

```sh
node --test tools/lib/quota-windows.test.mjs tools/quota-sweep.test.mjs tools/install-makeloop.test.mjs tools/lib/scheduled-task.test.mjs tools/setup.test.mjs tools/delegation-health-check.test.mjs tools/import-cycle.test.mjs tools/no-bare-node.test.mjs
```
```text
ℹ tests 148
ℹ suites 0
ℹ pass 147
ℹ fail 0
ℹ cancelled 0
ℹ skipped 1
ℹ todo 0
ℹ duration_ms 61815.232889
```

全出力は tests.log。PowerShell parser の read-back は `PowerShell parse: OK`。変更した既存ファイルの `git diff --check` も exit 0。

2. `node tools/quota-sweep.mjs --dry-run --json`（exit 0）。WSL の既定ホームは Claude 認証を持たない。

```json
{
  "windows": [
    {
      "provider": "codex",
      "observedAt": 1792538369913.4355,
      "stale": false,
      "exhausted": false,
      "window": "primary",
      "usedPercent": 7,
      "windowMinutes": 10080,
      "resetsAt": 1793100581000
    }
  ],
  "reasons": {
    "claude": "credentials: ENOENT",
    "codex": null
  },
  "decision": []
}
```

追加: Windows の Claude 認証と Windows/WSL 両ログを同時に読む実測（exit 0、spawnなし）。最新 mtime の WSL ログが採用された。

```sh
node --input-type=module <<'EOF'
import { main } from './tools/quota-sweep.mjs';
await main(['--dry-run', '--json', '--home', '/mnt/c/Users/uers'], { wslHome: '/home/kim' });
EOF
```
```json
{
  "windows": [
    {
      "provider": "claude",
      "window": "5h",
      "usedPercent": 19,
      "resetsAt": 1792547999971
    },
    {
      "provider": "claude",
      "window": "7d",
      "usedPercent": 72,
      "resetsAt": 1792594799971
    },
    {
      "provider": "codex",
      "observedAt": 1792538619433.4395,
      "stale": false,
      "exhausted": false,
      "window": "primary",
      "usedPercent": 8,
      "windowMinutes": 10080,
      "resetsAt": 1793100581000
    }
  ],
  "reasons": {
    "codex": null
  },
  "decision": []
}
```

Windows ホームだけを指定した CLI 出力は dry-run-windows-home.json に保存。候補があるケースでも spawn が0回であることをテスト済み。

3. `node tools/install-makeloop.mjs`（exit 1）。マーカー書込み不可。

```text
Codex makeloop already installed: /home/kim/.codex/plugins/cache/makeloop
EROFS: read-only file system, open '/home/kim/.claude/.makeloop-installed.json'
```

Windows の実 `claude plugin list`（cmd.exe 経由）は exit 0。WSL Codex の cache 存在も確認。両プラグインはすでに存在するが、インストーラのWindows実経路とマーカー作成の完了とは区別する。

```text
Installed plugins:

  ❯ makeloop@makeloop
    Version: 0.12.0
    Scope: user
    Status: ✔ enabled

WSL cache exists: /home/kim/.codex/plugins/cache/makeloop
```

Windows の `C:/Users/uers/.claude/.makeloop-installed.json` も存在しない。

4. `node tools/register-quota-sweep.mjs`（exit 0、非Windowsなので登録なし）。

```text
Skipped: OrgiastQuotaSweep registration requires Windows
```

Windows の `schtasks.exe /Query /TN OrgiastQuotaSweep` は exit 1。出力は CP932 から UTF-8 に変換して記録。

```text
エラー: 指定されたファイルが見つかりません。
```

`Get-ScheduledTask` の読戻しも `OrgiastQuotaSweep: not registered`。ExecutionTimeLimit の実タスク値は未確認。コードは150分、共通ヘルパーのdry-run/生成PowerShellのテストは合格。

5. `node tools/setup.mjs --json`（exit 1）。追加3項目は出力されたが、現在のWSLホームではNG。

```json
[
  {
    "id": "task:quota-sweep",
    "severity": "optional",
    "status": "NG",
    "checked": true,
    "repaired": false
  },
  {
    "id": "plugin:makeloop",
    "severity": "optional",
    "status": "NG",
    "checked": true,
    "repaired": false
  },
  {
    "id": "tool:quota-sweep",
    "severity": "optional",
    "status": "NG",
    "checked": true,
    "repaired": false
  }
]
```

6. コミットは Git 管理領域が許可範囲外で失敗。最初の `git add` が拒否されたため、`git commit -F ... -- <paths>` へ進めていない。コミット数0、clean未達。

```text
$ git add -- tools/lib/quota-windows.mjs tools/lib/quota-windows.test.mjs tools/lib/scheduled-task.mjs tools/lib/scheduled-task.test.mjs
fatal: Unable to create '/mnt/c/Users/uers/.claude/nightly-repo/.git/worktrees/wt-quota-sweep/index.lock': Read-only file system
exit=128; git commit -F was not reached
```

`git status --short`:

```text
M tools/lib/scheduled-task.mjs
 M tools/lib/scheduled-task.test.mjs
 M tools/setup-manifest.json
?? docs/quota-sweep.md
?? evidence/quota-sweep-20261021/
?? tools/install-makeloop.mjs
?? tools/install-makeloop.test.mjs
?? tools/lib/quota-sweep-host.mjs
?? tools/lib/quota-sweep-process.mjs
?? tools/lib/quota-sweep-watchdog.mjs
?? tools/lib/quota-windows.mjs
?? tools/lib/quota-windows.test.mjs
?? tools/quota-sweep-contract.tmpl.md
?? tools/quota-sweep.mjs
?? tools/quota-sweep.test.mjs
?? tools/register-quota-sweep.mjs
?? tools/register-quota-sweep.ps1
```

DECISIONS:
- dry-run は API/ファイル読取りだけ。子プロセス・通知・ロック・state 更新を行わない。
- 同時に有効な窓すべての残りを確認し、最も早いリセットの3分前を期限とする。観測不能なら停止する。
- 1窓8 tick の予約を起動前に永続化。新しいリセットでは前窓の状態を archive へ保存し、新しい試行を開始する。同じ窓の再試行では消費済みを引き継ぐ。
- FINAL は構造化出力の最終回答の独立行だけ採用し、引用されたプロンプトやツール出力は完了判定に使わない。
- 認証同期でアカウントが変わった場合は新しい Codex ログが観測されるまで候補から外す。
- 外部 rescue がブランチを切り替えた場合は処理を止め、誤った ref を push しない。
- テンプレートは kind=closed / runtime=manual、verify・state・停止条件・証跡に基づく適応判断を含む。

ISSUES:
- このセッションの書込み許可は作業ツリーと /tmp。worktree の Git 管理領域は ../nightly-repo/.git/worktrees/wt-quota-sweep にあり、read-only。実ホームやタスク登録もこの環境では完了できない。権限を迂回して実行していない。
- リセット後の新規モデル起動はしないが、送信済みリクエストのサーバー側計上や別PCの同時消費は制御できない。使用率ポーリング間の単一リクエストの増分も厳密には制限できない。実機の無人運転は未検証。
- Codex は最新ログの実測値だけを使う。最新ファイルに rate_limits がない、または必要な認証・使用率が取れない場合は実行しない。

LEARNING:
- Claude usage API の同じリセット時刻はミリ秒部分が .828→.971 と揺れた。窓IDを秒単位に揃え、deadlineは観測時刻から計算することで、同一窓の誤判定を防止。回帰テストあり。
- rate_limits は会話中の引用から抽出せず、構造化レコードだけ採用する。監督の既知の引用誤検知を再発させない。
- Windows の Claude プラグイン一覧と WSL の Codex cache は既存導入済み。WSL の ~/.claude と Windows の ~/.claude は同一ではない。

NEXT:
監督が書込み可能な Windows セッションで、同じ feat/quota-sweep の変更をレビューし、以下の3単位でコミットする。用意した commit-1.txt〜commit-3.txt を `git commit -F <msgfile> -- <paths>` に指定する。push はしない。

1. 枠判定・共通タスク設定: tools/lib/quota-windows.mjs、同test、tools/lib/scheduled-task.mjs、同test。
2. 実行制御: tools/quota-sweep.mjs、同test、tools/quota-sweep-contract.tmpl.md、tools/lib/quota-sweep-host.mjs、quota-sweep-process.mjs、quota-sweep-watchdog.mjs。
3. 配布・文書・証跡: tools/install-makeloop.mjs、同test、tools/register-quota-sweep.mjs/.ps1、tools/setup-manifest.json、docs/quota-sweep.md、evidence/quota-sweep-20261021/。

続けて Windows の Node で install-makeloop.mjs、register-quota-sweep.mjs、setup.mjs --json を実行し、マーカー・タスクの PT2H30M・setup 前2項目OKを読戻す。merge は kim/監督の HUMAN_GATE のまま。
