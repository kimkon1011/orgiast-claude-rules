// Read real scheduler metadata and copy only the relevant log to disposable homes.
// Never invokes remediation, sends notifications or mutates live health state.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runNightlyHealth } from '../../tools/nightly-health.mjs';
import { getScheduledTaskInfo } from '../../tools/lib/scheduled-task.mjs';
const expectations = JSON.parse(fs.readFileSync(new URL('../../tools/nightly-health-expectations.json', import.meta.url), 'utf8'));
const fixed = expectations.find((e) => e.log === 'booth-feedback-intake.log');
const output = [];
const quietLog = console.log;
for (const task of ['OrgiastBoothFeedback', fixed.task]) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'reapply-nightly-'));
  fs.mkdirSync(path.join(home, '.claude', 'logs'), { recursive: true });
  const liveLog = path.join('/mnt/c/Users/uers/.claude/logs', fixed.log);
  if (fs.existsSync(liveLog)) {
    const copy = path.join(home, '.claude/logs', fixed.log);
    fs.copyFileSync(liveLog, copy);
    const stat = fs.statSync(liveLog);
    fs.utimesSync(copy, stat.atime, stat.mtime);
  }
  let info = null, lookupError;
  try { info = await getScheduledTaskInfo(task); } catch (error) { lookupError = error; }
  console.log = () => {};
  let result, runError;
  try { result = await runNightlyHealth({ home, dryRun: true, expectations: [{ ...fixed, task }],
    runTests: async () => ({ status: 0, stdout: '# fail 0' }),
    scheduledTaskInfo: () => { if (lookupError) throw lookupError; return Promise.resolve(info); },
    notify: async () => { throw new Error('Notifications are forbidden in verification'); },
  }); } catch (error) { runError = error; }
  console.log = quietLog;
  output.push({ task, found: info !== null, schedulerState: info?.state ?? null,
    schedulerLookupError: lookupError ? 'CmdletizationQuery_NotFound_TaskName (Get-ScheduledTask)' : null,
    healthThrew: Boolean(runError), exitCode: result?.exitCode ?? 1,
    anomalies: result?.anomalies.map(({ type, label }) => ({ type, label })) ?? [] });
}
console.log(JSON.stringify(output, null, 2));
