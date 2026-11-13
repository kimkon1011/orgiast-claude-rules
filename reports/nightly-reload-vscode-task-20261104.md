# VS Code 夜間再起動タスク — 2026-11-04 結果

状態: 実装・ローカル検証まで。Windows 実機登録と PR 作成は環境制約により未完了。

## 作業場所・基点

- 別 clone: `/tmp/nightly-reload-vscode-task`
- branch: `fix/nightly-reload-vscode-task`
- main 基点: `516d30f1613d103e88bc26722c9099ef4fc670b0`（GitHub 接続ツールの fetch_commit(main) とローカルオブジェクトを照合）。
- 元の `~/.claude/nightly-repo` は直接編集していない。
- GitHub への git fetch は DNS 解決失敗。接続ツールで確認した main SHA へ別 clone を fast-forward してから編集した。

## 登録処理が消えた経緯

**削除コミットは特定できなかった。追跡履歴には登録処理そのものが見つからず、意図的廃止の証拠も確認できなかった。** ローカルのタスク削除の時期・実行者までは git 履歴から復元できない。

- `3612d91d282057bd8b909467ad3e3d1d38a1cf95` / PR #272 (2026-09-06): 初めて `tools/nightly-reload-vscode.ps1` を追跡。コミット本文に “previously untracked, production-running script” と明記。追加は本体のみでタスク登録コードは含まれない。
- `07875c6a` / #284: SendKeys から URI と穏やかな再起動へ変更。
- `8e973840` / #338: スマホ用タブ補充関連。
- `2066c08f` / #453: 再起動後のスリープ抑止・復帰確認・再試行。
- `75a791c5` / #485: PowerShell 5.1 の UInt32 定数修正。
- setup/onboarding/manifest の `git log --all -G 'nightly-reload-vscode|NightlyReload'` は該当履歴を返さなかった。
- 全ファイルの同パターン検索で本体・テスト以外に出た #344/#513 は health 監視設定の変更。登録処理の削除ではなかった。

このため「ある PR で登録処理が消えた」とは断定せず、未追跡の運用を setup に収束させる修正として実装した。

## 変更点

- 通常の Windows `setup --converge` に `nightly-reload-vscode` ステップを追加。カスタム manifest / verify では実行しない。Windows 以外は NOTICE。
- 登録だけの入口: `node tools/setup-nightly-reload.mjs`。他の converge ステップや再起動を呼ばない。
- タスク名 `OrgiastNightlyReloadVSCode`。04:40 / 05:00 / 05:20 / 05:40 / 06:00 の daily trigger。
- Interactive / Limited、非表示 PowerShell、並列実行 IgnoreNew、実行上限19分、日中への追いかけ実行なし。
- アクション・実行ユーザー・トリガー・主要設定を比較。同じ定義なら Register-ScheduledTask を呼ばず、変更時は登録後に再取得して検証する。照会失敗を「タスクなし」と扱わない。
- JSONC のコメントを保持して `window.restoreWindows=all` を設定。不正な設定ファイルでは登録へ進まず NG。
- 稼働中で最古の Code プロセスの StartTime で経過時間を判定。URI reload で更新される既存 `.last` マーカーは再起動時刻として使用しない。
- 日付をまたいだ Code は更新待ちや退避セッションの有無に関係なく毎晩再起動。同日再起動後の後続 trigger は日次再起動を繰り返さない。
- 72時間以上なら busy を無視し、`FORCE-RESTART: Code age=... >= 72h; bypass busy and URI reload` を記録。URI のみで完了せず WM_CLOSE → 全 Code 終了確認 → code.cmd の経路を使用。強制終了は追加していない。
- 新たな LLM / 検索 API 呼び出しは追加していない。

## テスト

作業ディレクトリはいずれも `/tmp/nightly-reload-vscode-task`。

- `node --test tools/setup-nightly-reload.test.mjs tools/setup-task-hidden-actions.test.mjs`: exit 0、2ファイル成功。個別実行でも新規3ケース・既存6ケースが成功。
- `node --check tools/setup-nightly-reload.mjs` / `node --check tools/setup.mjs`: exit 0。
- `git diff --check`: exit 0。
- `node --test tools/setup-nightly-reload.test.mjs tools/setup.test.mjs tools/setup-task-hidden-actions.test.mjs`: setup.test.mjs が失敗。
- 詳細取得の `node tools/setup.test.mjs`: 31件中7成功、23失敗、1スキップ。
- 変更前 main を `/tmp/nightly-reload-baseline` に checkout して同じテストを実行: 同じ7成功、23失敗、1スキップ。
- 子プロセスの最小再現: `spawnSync /usr/bin/node EPERM`、status=1、stdout/stderr空。HTTP 待受テストも `listen EPERM ... 127.0.0.1`。よって既存テスト全通過の確認は未完了。
- PowerShell テストには72時間境界・最古プロセス・同日再試行抑制を追加。登録テストは実 CIM コンストラクタとメモリ内の scheduler mock で欠落登録・冪等性・無効化/パス/時刻の drift・照会エラーを検証する。下記の理由で実行未完了。

## 実機のタスク登録確認の出力

Windows PowerShell の起動自体がこの WSL 環境から失敗するため、converge 該当ステップによる実機登録と登録後照会は未完了。VS Code の再起動は実行していない。

実行試行:

```powershell
powershell.exe -NoProfile -File tools/nightly-reload-vscode.test.ps1
powershell.exe -NoProfile -File tools/register-nightly-reload-vscode.test.ps1
powershell.exe -NoProfile -Command 'Get-ScheduledTask | Where-Object TaskName -Match "reload|vscode" | Format-List TaskName,State,Actions,Triggers'
```

出力（順に各プロセス exit 1）:

```text
<3>WSL (10 - ) ERROR: UtilBindVsockAnyPort:317: socket failed 1
<3>WSL (11 - ) ERROR: UtilBindVsockAnyPort:317: socket failed 1
<3>WSL (12 - ) ERROR: UtilBindVsockAnyPort:317: socket failed 1
```

Windows 環境での残りの検証コマンド（登録だけ。Start-ScheduledTask は使用しない）:

```powershell
node tools/setup-nightly-reload.mjs
node tools/setup-nightly-reload.mjs # 2回目 repaired:false を確認
Get-ScheduledTask -TaskName OrgiastNightlyReloadVSCode | Format-List TaskName,State,Actions,Triggers,Principal,Settings
powershell.exe -NoProfile -File tools/nightly-reload-vscode.test.ps1
powershell.exe -NoProfile -File tools/register-nightly-reload-vscode.test.ps1
```

## PR URL

未作成。GitHub 接続ツールで branch 作成を試行した際、ツールの承認チェックが次を返した:

```text
MCP tool call requires approval, but approval policy is never
```

この拒否を迂回した外部書込みは行っていない。PR 作成と Windows 実機検証を残す。マージは実行していない。
