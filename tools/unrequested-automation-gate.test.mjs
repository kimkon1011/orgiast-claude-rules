import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const hook = path.resolve('tools/unrequested-automation-gate.mjs');

function fixture(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'unreq-auto-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));

  const run = (tool_name, tool_input, env = {}) => {
    const result = spawnSync(process.execPath, [hook], {
      cwd,
      input: JSON.stringify({ tool_name, tool_input, cwd }),
      encoding: 'utf8',
      env: { ...process.env, UNREQUESTED_AUTOMATION_GATE: '', ...env }
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout ? JSON.parse(result.stdout).hookSpecificOutput.permissionDecision : undefined;
  };
  return { cwd, run };
}

const PASSED_REMINDER_SNIPPET = JSON.stringify({
  recipients: ["user1", "user2"],
  cycles: [
    {
      day: 18,
      note: "18日から月末まで毎日送る(user 指定 2026-10-22)"
    }
  ]
}, null, 2);

const BLOCKED_BALANCE_REMINDER_SNIPPET = JSON.stringify({
  title: "銀行残高の同期リマインド",
  day: 10,
  enabled: true,
  recipients: ["user1", "user2"],
  note: "毎月10日の10時にリマインドを送る"
}, null, 2);

test('1. real data - passed reminder block with user specification marker passes', t => {
  const f = fixture(t);
  const realPath = 'C:\\Users\\test\\Desktop\\ClaudeCode\\keiri-hub\\src\\data\\cashRecurring.json';
  if (fs.existsSync(realPath)) {
    const realContent = fs.readFileSync(realPath, 'utf8');
    assert.ok(realContent.includes('user 指定 2026-10-22'));
  }
  const result = f.run('Write', { file_path: 'src/data/cashRecurring.json', content: PASSED_REMINDER_SNIPPET });
  assert.equal(result, undefined);
});

test('2. real data - unrequested balanceReminder block without marker is blocked', t => {
  const f = fixture(t);
  const result = f.run('Write', { file_path: 'src/data/cashRecurring.json', content: BLOCKED_BALANCE_REMINDER_SNIPPET });
  assert.equal(result, 'deny');
});

test('3. vercel.json crons + discord route blocked, passes with REQUESTED-BY marker', t => {
  const f = fixture(t);
  const vercelCronContent = JSON.stringify({
    crons: [
      {
        path: "/api/discord/notify",
        schedule: "0 10 10 * *"
      }
    ]
  }, null, 2);

  assert.equal(f.run('Write', { file_path: 'vercel.json', content: vercelCronContent }), 'deny');

  const vercelCronWithMarker = `// REQUESTED-BY: kim 2026-11-11\n` + vercelCronContent;
  assert.equal(f.run('Write', { file_path: 'vercel.json', content: vercelCronWithMarker }), undefined);
});

test('4. no false positives: log output cron passes, manual discord send passes', t => {
  const f = fixture(t);
  const logCronCode = `
    const cron = require('node-cron');
    cron.schedule('0 * * * *', () => {
      console.log('Periodic log cleanup');
    });
  `;
  assert.equal(f.run('Write', { file_path: 'src/logger.js', content: logCronCode }), undefined);

  const manualDiscordSend = `
    async function handleClick() {
      await sendDiscord({ content: 'Button clicked!' });
    }
  `;
  assert.equal(f.run('Write', { file_path: 'src/components/Button.jsx', content: manualDiscordSend }), undefined);
});

test('5. excluded paths pass regardless of content', t => {
  const f = fixture(t);
  const badContent = BLOCKED_BALANCE_REMINDER_SNIPPET;
  for (const file_path of ['orgiast-claude-rules/tools/x.mjs', '.claude/x.js', 'x.test.ts', 'README.md']) {
    assert.equal(f.run('Write', { file_path, content: badContent }), undefined);
  }
});

test('6. existing file with requester marker passes edits', t => {
  const f = fixture(t);
  const existingFile = path.join(f.cwd, 'config.json');
  fs.writeFileSync(existingFile, '// REQUESTED-BY: kim 2026-11-11\n{"enabled": true}');

  const editInput = {
    file_path: 'config.json',
    old_string: '{"enabled": true}',
    new_string: BLOCKED_BALANCE_REMINDER_SNIPPET
  };
  assert.equal(f.run('Edit', editInput), undefined);
});

test('7. modifying existing automated notification (not adding new) passes', t => {
  const f = fixture(t);
  const existingFile = path.join(f.cwd, 'cronJob.js');
  const oldCode = `
    // Existing cron job
    cron.schedule("0 10 * * *", () => {
      sendDiscord("Daily report");
    });
  `;
  fs.writeFileSync(existingFile, oldCode);

  const newCode = `
    // Existing cron job updated
    cron.schedule("0 12 * * *", () => {
      sendDiscord("Daily report at noon");
    });
  `;

  const editInput = {
    file_path: 'cronJob.js',
    old_string: oldCode,
    new_string: newCode
  };
  assert.equal(f.run('Edit', editInput), undefined);
});

test('8. UNREQUESTED_AUTOMATION_GATE=off bypasses gate', t => {
  const f = fixture(t);
  assert.equal(f.run('Write', { file_path: 'src/data/cashRecurring.json', content: BLOCKED_BALANCE_REMINDER_SNIPPET }, { UNREQUESTED_AUTOMATION_GATE: 'off' }), undefined);
});

test('9. Bash scheduled task checks', t => {
  const f = fixture(t);
  assert.equal(f.run('Bash', { command: 'schtasks /create /tn "DiscordNotify" /tr "node discord-notify.mjs"' }), 'deny');
  assert.equal(f.run('Bash', { command: 'schtasks /create /tn "LogRotate" /tr "node log-rotate.mjs"' }), undefined);
  assert.equal(f.run('Bash', { command: 'node tools/register-stuck-dialog-task.mjs' }), undefined);
});

test('10. malformed input fails open', () => {
  const result = spawnSync(process.execPath, [hook], { input: '{malformed', encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
});
