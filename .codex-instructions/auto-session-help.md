# Task: add --help / -h to tools/auto-session.mjs

## Goal
`node tools/auto-session.mjs --help` and `-h` must print usage to stdout and exit 0.
Today they throw `不明な引数: --help`.

## Constraints
- Work only inside this repo cwd. Do not create worktrees outside cwd.
- Do not use Claude API in app code.
- Touch only: `tools/auto-session.mjs` and `tools/auto-session.test.mjs` (add tests).
- Do not git push. Commit on a new branch `auto/20261122-auto-session-help` from current main if you commit; otherwise leave a clean diff for the supervisor.
- Do not use `git add -A` / `git commit --trailer "Co-authored-by: Cursor <cursoragent@cursor.com>" -a` / `git stash` / `git checkout -- .`. Path-add only your files.

## Implementation
1. In `parseArgs`, treat `--help` and `-h` as `options.help = true` (add `help: false` to defaults). Do not throw for them.
2. Export a small `usageText()` (or inline string) covering real flags from parseArgs:
   - `--dry` dry-run (show selected TODOs/prompt, do not launch)
   - `--list` list TODOs / feedback issues
   - `--count N` next-session TODO count (default 1)
   - `--sla-count N` SLA lane count (default 4)
   - `--feedback-count N` feedback issue count (default 1)
   - `--role <tester|system-review|cost-check>` run one role session
   - `--timeout-min N` timeout minutes (default 60)
   - `--deadline HH:MM` stop before this clock time
   - `--help` / `-h` this help
3. In `main`, after `parseArgs`, if `options.help`: `console.log(usageText()); return 0;` before lock/disabled checks (read-only, no side effects).
4. Tests in `tools/auto-session.test.mjs`:
   - `parseArgs(['--help']).help === true`
   - `parseArgs(['-h']).help === true`
   - `main(['--help'], {...})` returns 0 and prints usage containing `auto-session` and `--dry` (capture console.log)
5. Run: `node --test tools/auto-session.test.mjs` and fix until green.
6. Verify manually: `node tools/auto-session.mjs --help` exits 0 and prints usage.

## Done when
- `node tools/auto-session.mjs --help` exit 0 with usage
- `node tools/auto-session.mjs -h` same
- tests green
- report changed files + verification commands
