import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { geminiApiInvocation, isSafeInvocation, judge, readBudgetStatus } from './gemini-api-budget-gate.mjs';

const event = command => ({ tool_name: 'Bash', tool_input: { command } });
const stop = () => ({ level: 'stop', pct: 471.2 });

test('stop denies a billable generate call', () => {
  const result = judge(event('gemini-api generate "hello"'), { statusProvider: stop });
  assert.equal(result.decision, 'deny');
  assert.match(result.reason, /今月 471\.2%/);
  assert.match(result.reason, /--provider openrouter/);
});

for (const command of ['gemini-api generate ping --dry-run', 'gemini-api whoami -o json', 'gemini-api --help', 'gemini-api models', 'gemini-api explore topic']) {
  test(`stop allows safe invocation: ${command}`, () => assert.equal(judge(event(command), { statusProvider: stop }).decision, 'allow'));
}

test('ok allows a billable call', () => assert.equal(judge(event('gemini-api image cat'), { statusProvider: () => ({ level: 'ok', pct: 10 }) }).decision, 'allow'));

for (const command of ['grep gemini-api file', 'cat skills/gemini-api-cli/SKILL.md', 'git commit -m "gemini-api update"', 'echo "gemini-api generate cat"']) {
  test(`text occurrence is not treated as execution: ${command}`, () => assert.equal(geminiApiInvocation(command), null));
}

test('detects full path exe after a shell operator', () => {
  const found = geminiApiInvocation('echo ready && & "C:\\Tools\\gemini-api.exe" generate cat');
  assert.equal(found.args, 'generate cat');
  assert.equal(isSafeInvocation(found.args), false);
});

test('guard failure fails open with one warning', () => {
  const warnings = [];
  const result = judge(event('gemini-api generate hello'), { statusProvider: () => { throw new Error('timeout'); }, warn: value => warnings.push(value) });
  assert.equal(result.decision, 'allow');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /許可します/);
});

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-api-budget-gate-'));
  fs.mkdirSync(path.join(home, '.claude'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

const now = new Date('2026-11-25T09:00:00.000Z');
const month = '2026-11';

test('有効なキャッシュ命中時はガードを spawn しない', t => {
  const home = fixture(t);
  fs.writeFileSync(path.join(home, '.claude', 'gemini-api-budget-gate-cache.json'), JSON.stringify({ level: 'stop', pct: 471.2, month, checkedAt: '2026-11-25T08:30:00.000Z' }));
  let spawned = false;
  const status = readBudgetStatus({ home, now, spawnImpl: () => { spawned = true; } });
  assert.equal(status.level, 'stop');
  assert.equal(spawned, false);
});

test('期限切れキャッシュ時はガードを spawn してキャッシュを書く', t => {
  const home = fixture(t);
  const file = path.join(home, '.claude', 'gemini-api-budget-gate-cache.json');
  fs.writeFileSync(file, JSON.stringify({ level: 'ok', pct: 1, month, checkedAt: '2026-11-25T07:00:00.000Z' }));
  let options;
  const status = readBudgetStatus({ home, now, spawnImpl: (_exe, _args, value) => {
    options = value;
    return { status: 0, stdout: JSON.stringify({ level: 'stop', pct: 471.2, month, checkedAt: now.toISOString() }) };
  } });
  assert.equal(status.level, 'stop');
  assert.equal(options.timeout, 40000);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), status);
});

test('36時間以内の status ファイルを利用してキャッシュへ移す', t => {
  const home = fixture(t);
  const dir = path.join(home, '.claude');
  fs.writeFileSync(path.join(dir, 'gemini-budget-status.json'), JSON.stringify({ level: 'stop', pct: 471.2, month, checkedAt: '2026-11-24T12:00:00.000Z' }));
  let spawned = false;
  const status = readBudgetStatus({ home, now, spawnImpl: () => { spawned = true; } });
  assert.equal(status.level, 'stop');
  assert.equal(spawned, false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'gemini-api-budget-gate-cache.json'), 'utf8')).level, 'stop');
});

test('Gemini の billing cooldown を補助 stop 判定に使う', t => {
  const home = fixture(t);
  const dir = path.join(home, '.claude');
  fs.writeFileSync(path.join(dir, 'provider-cooldown.json'), JSON.stringify({ gemini: { until: now.getTime() + 60_000, reason: 'billing' } }));
  let spawned = false;
  const status = readBudgetStatus({ home, now, spawnImpl: () => { spawned = true; } });
  assert.equal(status.level, 'stop');
  assert.equal(spawned, false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'gemini-api-budget-gate-cache.json'), 'utf8')).month, month);
});
