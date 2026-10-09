# Hook anchor and reconciliation

Without ORGIAST_REPO, register-hooks selects ~/.claude/nightly-repo,
then ~/orgiast-claude-rules (onboarding-sync's default). It requires a clean
main branch or detached HEAD at origin/main, or an ancestor whose commit is at
most 24 hours old. Exact matches remain eligible regardless of commit age.
Dirty trees, feature branches, local/divergent commits and older ancestors are
rejected. No eligible anchor prints an onboarding-sync --force repair command.
It never selects the invoking
session's checkout. No eligible anchor means failure before writing settings.
The selected checkout supplies both the registration definitions and runtime.
ORGIAST_REPO remains an explicit override for installation and isolated tests.
setup --converge also leaves this selection to the registrar.

Managed tools converge to the registrar's --expected-json definitions, including
command, wrapper, event, matcher, timeout and async. Obsolete orgiast tools and
duplicates are removed. Mixed groups keep custom hooks. A second run does not
write settings or create backups. Existing copied PowerShell hooks retain their
execution-policy repair. fleet receipts now include hookMissingNames, containing
only event and script names, never full commands or secrets.

## kim-PC read-only diagnosis (2026-10-10)

The 17 mismatches were reproduced by reading settings.json and comparing with
the expected set (normalizing only the diagnostic host's Windows path spelling).

| Event | Scripts | Cause |
| --- | --- | --- |
| SessionStart | onboarding-sync, cost-loop, hook-selfcheck, hook-budget-check, makimono-host-detect, session-claim-collision, session-relaunch | 7 commands wrapped in bg-launch |
| SessionStart | setup, tool-adoption-check | 2 bg-launch commands, also missing async=true |
| SessionStart | claude-cost-reporter | 1 missing async=true |
| UserPromptSubmit | automation-first-reminder, credentials-reminder | 2 absent |
| PreToolUse | pipe-stage-permissions | 1 absent |
| Stop | handoff-detail-guard, url-format-guard, check-e2e-before-stop | 3 absent |
| PreToolUse | pretooluse-serial-investigation | 1 matcher differs (restricted tool list versus all tools) |

All names above have the .mjs extension. Thus 10 SessionStart definition
mismatches + 6 absent registrations + 1 matcher mismatch = 17.
The gate-hook-runner wrapper is already in the expected set and is not a false
positive. bg-launch changes execution/context delivery (including hooks required
to run synchronously), so it must be replaced, not ignored in health checks.

After merge and nightly main refresh, the supervisor runs in PowerShell:

```powershell
node "$HOME/.claude/nightly-repo/tools/register-hooks.mjs" --hooks-only
```

No live settings or kim-PC working checkout were modified during development.
