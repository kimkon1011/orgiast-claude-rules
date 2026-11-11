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
      env: { ...process.env, UNREQUESTED_AUTOMATION_GATE: '', ...env },
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout ? JSON.parse(result.stdout).hookSpecificOutput?.permissionDecision : undefined;
  };
  return { cwd, run };
}

const REMINDER_BLOCK = `{
  "reminder": {
    "recipients": [
      { "name": "木下真弓", "discordUsername": "kinoshita.orgiast", "userId": "1382622863227621437" },
      { "name": "アブドゥルラティフ智望", "discordUsername": "tomomi.nishi", "userId": "1406986143106470059" }
    ],
    "appUrl": "https://keiri-hub.vercel.app/shikin",
    "cycles": [
      { "id": "early", "startDay": 5, "dailyFrom": 5, "dailyTo": 10, "title": "資金状況の確認をお願いします" },
      { "id": "late", "startDay": 18, "dailyFrom": 18, "dailyTo": 31, "note": "18日から月末まで毎日送る(user 指定 2026-10-22)" }
    ]
  }
}`;

const BALANCE_BLOCK = `{
  "balanceReminder": {
    "enabled": true,
    "day": 10,
    "title": "銀行残高の同期リマインド",
    "body": "本日は残高共有の日です。freee で口座を同期してください。",
    "recipients": ["@木下真弓", "@アブドゥルラティフ智望"],
    "note": "残高そのものは自動送信しない。10日に1回だけ同期と送信を促す。"
  }
}`;

test('テスト1（実データ・通る）', (t) => {
  const { run } = fixture(t);
  const decision = run('Write', {
    file_path: 'src/data/cashRecurring.json',
    content: REMINDER_BLOCK,
  });
  assert.equal(decision, undefined);
});

test('テスト1b（実ファイル照合）', (t) => {
  const targetPath = 'C:\\Users\\test\\Desktop\\ClaudeCode\\keiri-hub\\src\\data\\cashRecurring.json';
  if (fs.existsSync(targetPath)) {
    const content = fs.readFileSync(targetPath, 'utf8');
    assert.ok(content.includes('user 指定 2026-10-22'));
  } else {
    t.skip('cashRecurring.json not found');
  }
});

test('テスト2（実データ・止まる）', (t) => {
  const { run } = fixture(t);
  const decision = run('Write', {
    file_path: 'src/data/cashRecurring.json',
    content: BALANCE_BLOCK,
  });
  assert.equal(decision, 'deny');
});

test('テスト3（vercel.json の cron + DISCORD_WEBHOOK）', (t) => {
  const { run } = fixture(t);
  const unrequestedContent = `{
    "crons": [{ "path": "/api/cron/notify", "schedule": "0 1 10 * *" }],
    "env": { "DISCORD_WEBHOOK": "https://discord.com/api/webhooks/xxx" }
  }`;
  assert.equal(run('Write', { file_path: 'vercel.json', content: unrequestedContent }), 'deny');

  const requestedContent = `// REQUESTED-BY: kim 2026-11-11
  {
    "crons": [{ "path": "/api/cron/notify", "schedule": "0 1 10 * *" }],
    "env": { "DISCORD_WEBHOOK": "https://discord.com/api/webhooks/xxx" }
  }`;
  assert.equal(run('Write', { file_path: 'vercel.json', content: requestedContent }), undefined);
});

test('テスト4（誤検知しない）', (t) => {
  const { run } = fixture(t);
  // ① cron + console.log だけ（配達シグナル無し）
  const cronOnly = `const cron = require('node-cron'); cron.schedule('0 0 * * *', () => console.log('check'));`;
  assert.equal(run('Write', { file_path: 'src/job.js', content: cronOnly }), undefined);

  // ② DISCORD_WEBHOOK で手動送信するだけ（定期実行シグナル無し）
  const webhookOnly = `const webhook = process.env.DISCORD_WEBHOOK; sendDiscord(webhook, "manual message");`;
  assert.equal(run('Write', { file_path: 'src/notify.js', content: webhookOnly }), undefined);
});

test('テスト5（除外パス）', (t) => {
  const { run } = fixture(t);
  assert.equal(run('Write', { file_path: 'orgiast-claude-rules/tools/x.mjs', content: BALANCE_BLOCK }), undefined);
  assert.equal(run('Write', { file_path: '.claude/x.js', content: BALANCE_BLOCK }), undefined);
  assert.equal(run('Write', { file_path: 'x.test.ts', content: BALANCE_BLOCK }), undefined);
  assert.equal(run('Write', { file_path: 'README.md', content: BALANCE_BLOCK }), undefined);
});

test('テスト6（既存ファイルに REQUESTED-BY あり）', (t) => {
  const { cwd, run } = fixture(t);
  const targetFile = path.join(cwd, 'src/config.json');
  fs.mkdirSync(path.dirname(targetFile), { recursive: true });
  fs.writeFileSync(targetFile, '// REQUESTED-BY: kim 2026-11-11\n{"existing": true}');

  const decision = run('Edit', {
    file_path: 'src/config.json',
    old_string: '{"existing": true}',
    new_string: BALANCE_BLOCK,
  });
  assert.equal(decision, undefined);
});

test('テスト7（old_string に既に同じ配達・定期実行シグナルあり）', (t) => {
  const { cwd, run } = fixture(t);
  const targetFile = path.join(cwd, 'src/config.json');
  fs.mkdirSync(path.dirname(targetFile), { recursive: true });
  fs.writeFileSync(targetFile, BALANCE_BLOCK);

  const decision = run('Edit', {
    file_path: 'src/config.json',
    old_string: BALANCE_BLOCK,
    new_string: BALANCE_BLOCK.replace('銀行残高の同期リマインド', '残高リマインド（改定）'),
  });
  assert.equal(decision, undefined);
});

test('テスト8（UNREQUESTED_AUTOMATION_GATE=off）', (t) => {
  const { run } = fixture(t);
  const decision = run(
    'Write',
    { file_path: 'src/data/cashRecurring.json', content: BALANCE_BLOCK },
    { UNREQUESTED_AUTOMATION_GATE: 'off' }
  );
  assert.equal(decision, undefined);
});

test('テスト9（Bash）', (t) => {
  const { run } = fixture(t);
  assert.equal(
    run('Bash', { command: 'schtasks /create /tn X /tr "node discord-notify.mjs" /sc monthly' }),
    'deny'
  );
  assert.equal(
    run('Bash', { command: 'schtasks /create /tn X /tr "node log-rotate.mjs" /sc daily' }),
    undefined
  );
  assert.equal(
    run('Bash', { command: 'node tools/register-stuck-dialog-task.mjs' }),
    undefined
  );
});
