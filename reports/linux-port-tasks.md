# 定期タスク棚卸し（C④-1）

- register-*.ps1: 31
- 抽出したタスク名: 37
- 対応する .mjs がある ps1: 5/31
- タスク名を抽出できなかった ps1: 0
- Windows 専用呼び出し（ps1 内の文字列数）: schtasks=2 / taskkill=0 / registry=0

| ps1 | タスク名 | 時刻 | 繰り返し(分) | 対象 | .mjs |
| --- | --- | --- | --- | --- | --- |
| register-auto-progress-task.ps1 | OrgiastAutoProgressDigest, OrgiastAutoProgressWatch | 08:40, 09:00, 18:00 | - | tools/auto-progress-digest.mjs, tools/auto-progress-watch.mjs, tools/notify-kim.mjs | あり |
| register-auto-session-verify.ps1 | OrgiastAutoSessionVerify | 07:45 | - | tools/auto-session-verify.mjs | なし |
| register-auto-session.ps1 | OrgiastAutoSession | 00:30 | - | tools/auto-session-launcher.mjs | なし |
| register-autopilot-task.ps1 | OrgiastAutopilot | - | 30 | tools/autopilot-run.mjs | なし |
| register-booth-feedback-task.ps1 | OrgiastBoothFeedbackIntake | 00:05 | 10 | tools/booth-feedback-intake.mjs, tools/nightly-bootstrap.ps1 | なし |
| register-claude-backup-task.ps1 | ClaudeDailyDriveBackup | 03:40 | - | - | なし |
| register-cost-improve-task.ps1 | OrgiastCostImproveLoop, OrgiastCostWeeklyImprove | 07:20, 07:40 | - | tools/cost-improve-loop.mjs, tools/cost-weekly-improve.mjs, tools/nightly-bootstrap.ps1 | なし |
| register-decision-watch.ps1 | OrgiastDecisionWatch | 00:00 | 10 | tools/decision-watch.mjs, tools/nightly-bootstrap.ps1 | あり |
| register-discord-autoreply.ps1 | OrgiastDiscordAutoReply | - | 5 | tools/discord-autoreply.mjs | なし |
| register-discord-task-digest.ps1 | OrgiastDiscordTaskDigest | 06:30 | - | tools/discord-task-digest.mjs, tools/mail-task-digest.mjs | なし |
| register-evening-digest-task.ps1 | OrgiastEveningDigest | 18:00 | - | tools/evening-digest.mjs | なし |
| register-feedback-nag-task.ps1 | OrgiastFeedbackNag | 09:00 | - | tools/feedback-nag.mjs, tools/nightly-bootstrap.ps1 | なし |
| register-fleet-agent.ps1 | OrgiastFleetAgent | 00:00 | 15 | tools/fleet-agent.mjs, tools/nightly-bootstrap.ps1 | なし |
| register-fleet-mail.ps1 | OrgiastFleetMail, OrgiastFleetMailWatchdog | 00:00, 00:05 | 2 | tools/fleet-mail-watchdog.mjs, tools/fleet-mail.mjs, tools/nightly-bootstrap.ps1 | あり |
| register-fleet-poller.ps1 | OrgiastFleetPoller | 03:15 | - | tools/fleet-poller.ps1, tools/nightly-bootstrap.ps1 | なし |
| register-funnel-probe-task.ps1 | OrgiastFunnelProbe | 00:05 | - | tools/funnel-probe.mjs, tools/nightly-bootstrap.ps1 | なし |
| register-gtasks-plan-task.ps1 | OrgiastGoogleTasksPlan | 00:20 | - | tools/gtasks-loop.mjs, tools/nightly-bootstrap.ps1 | なし |
| register-hub-push-task.ps1 | OrgiastHubPush | 02:40 | - | tools/hub-push.mjs | なし |
| register-internal-audit-task.ps1 | OrgiastInternalAudit | 07:00 | - | tools/internal-audit.mjs | なし |
| register-ledger-nag-task.ps1 | OrgiastLedgerStaleNag | 09:13 | - | tools/ledger-stale-nag.mjs, tools/nightly-bootstrap.ps1 | なし |
| register-messenger-watch.ps1 | OrgiastMessengerWatch | 07:00 | 30 | tools/messenger-watch.mjs, tools/nightly-bootstrap.ps1 | なし |
| register-morning-batch-task.ps1 | OrgiastMorningBatch | 07:00 | - | tools/morning-batch.mjs | なし |
| register-nightly-kpi-task.ps1 | OrgiastNightlyKpi | 07:05 | - | tools/nightly-bootstrap.ps1, tools/nightly-kpi.mjs | なし |
| register-nightly-tools.ps1 | OrgiastMorningBatch, OrgiastNightlyBatch | - | - | tools/ai-news-triage.mjs, tools/drive-hub-mirror.mjs, tools/expense-leak-check.mjs, tools/next-actions.mjs, tools/nightly-health-remediate.mjs, tools/nightly-health.mjs, tools/open-work.mjs, tools/pricing-brief.mjs | なし |
| register-plaud-task.ps1 | OrgiastPlaudToTldv | - | - | tools/plaud-to-tldv.mjs | なし |
| register-role-sessions.ps1 | OrgiastRoleCost, OrgiastRoleReview, OrgiastRoleTester | 04:10, 04:30 | - | tools/auto-session.mjs | なし |
| register-rule-compliance-task.ps1 | ClaudeRuleComplianceAudit | 03:50 | - | - | なし |
| register-stall-sweeper.ps1 | OrgiastStallSweeper | 04:10 | - | tools/codex-do.mjs, tools/notify-kim.mjs, tools/stall-sweeper.mjs | あり |
| register-stalled-session-nightly.ps1 | OrgiastNightlyBatch | 03:00 | - | tools/nightly-batch.ps1, tools/nightly-bootstrap.ps1, tools/stalled-session-resume.mjs | あり |
| register-tetsuko-growth-task.ps1 | OrgiastTetsukoGrowth | 06:30 | - | tools/nightly-bootstrap.ps1, tools/tetsuko-growth-loop.mjs | なし |
| register-top3-catchup-task.ps1 | OrgiastTop3Catchup | 08:30 | - | tools/nightly-bootstrap.ps1, tools/top3-catchup.mjs | なし |
