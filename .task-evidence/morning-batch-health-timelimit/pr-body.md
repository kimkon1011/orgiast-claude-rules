OrgiastMorningBatch の合計15分制限で nightly-health が完了せず、remediate が古い健康入力を見続ける問題を修正します。11/05 の実測は 07:15:33 / LastTaskResult 267014、nightly-health.log 最終更新 07:15:32。`.nightly-health-last.json` は 11/04 07:02:47 JST から未更新でした。

方式Aを採用し、health を `OrgiastNightlyHealth`（毎日07:10、PT30M、run-hidden.vbs経由）へ分離します。MorningBatchのPrincipalとSettingsを継承し、時間制限だけ変更します。新タスクの登録・読み戻し成功後にMorningBatchのhealthアクションを外すため、登録失敗時は旧アクションが残ります。open-work は健康JSONを読まないためMorningBatchに残します。

通常登録のdry-runでは対象外NightlyBatchへの4アクション追加が予定されたため、限定適用用の `-HealthOnly` を追加しました。`-HealthOnly -Remove` は拒否します。

検証・適用結果:
- Windows `node --test tools/register-nightly-tools.test.mjs`: 8 pass / 0 fail。
- Windows `git diff --check`: pass。
- Windowsで `register-nightly-tools.ps1 -HealthOnly` を適用、読み戻し成功。
- MorningBatch: 07:00 / PT15M / IgnoreNew、morning-batch → next-actions → open-work。
- NightlyHealth: 07:10 / PT30M / IgnoreNew、nightly-healthのみ。実行先は同期対象のnightly-repo。
- XML比較でMorningBatchのSettings維持、healthのPrincipal・制限以外のSettings継承、NightlyBatch / DeadlineDetect / DeadlineWatch / NightlyRemediateの未変更を確認。

11/05ログ末尾30行には `getScheduledTaskInfo` → `spawnSync powershell.exe ETIMEDOUT` があり、最後の対象は `OrgiastDeadlineWatch` です。状態取得のPowerShellは1回20秒制限で、タスク照会の遅延が確認できます。ログに各処理の時刻がないため、全体の時間配分や07:15:33の強制終了時の正確な命令は断定していません。健康入力の更新再開は次回07:10の実行後に確認が必要です。

🤖 Generated with [Claude Code](https://claude.com/claude-code)
