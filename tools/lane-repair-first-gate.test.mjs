import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { evaluateRepairFirst, repairCommand } from './lane-repair-first-gate.mjs';
import { recordRepair } from './lane-repair-log.mjs';
import { repairContext, REPAIR_TTL, repairRows } from './lib/lane-repair-state.mjs';
import { runHook } from './gate-hook-runner.mjs';
import { rolloutMode } from './gate-runtime.mjs';
const now = Date.now(), fault = { alive: false, reason: 'real_fail_rate', error: 'HTTP 500 (9)' };
const script = fileURLToPath(new URL('./lane-repair-first-gate.mjs', import.meta.url));
function fixture(t, state = fault) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'repair-gate-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, '.claude'));
  const health = { lanes: { deepseek: state, groq: { alive: true, reason: 'probe_ok' } } };
  fs.writeFileSync(path.join(home, '.claude/lane-health.json'), JSON.stringify(health));
  return { home, health };
}
const input = (tool_name, command) => ({ tool_name, tool_input: { command }, permission_mode: 'bypassPermissions' });
test('unattended sessions block edits and nonrepair shell; reads pass', t => {
  const { home } = fixture(t);
  for (const name of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash', 'PowerShell']) assert.equal(evaluateRepairFirst(input(name, 'npm test'), { home, now }).decision, 'block', name);
  for (const name of ['Read', 'Grep', 'Glob']) assert.equal(evaluateRepairFirst(input(name), { home, now }).decision, 'pass');
});
test('log unlocks same fault for six hours; future, expired and unrelated records cannot', async t => {
  const { home } = fixture(t);
  await recordRepair({ home, lane: 'deepseek', tried: 'key and direct API checked: HTTP 500', result: 'unfixable', now });
  assert.equal(evaluateRepairFirst(input('Edit'), { home, now }).decision, 'pass');
  assert.equal(evaluateRepairFirst(input('Edit'), { home, now: now + REPAIR_TTL }).decision, 'block');
  assert.equal(evaluateRepairFirst(input('Edit'), { home, now: now - 1 }).decision, 'block');
  fs.writeFileSync(path.join(home, '.claude/lane-health.json'), JSON.stringify({ lanes: { deepseek: { ...fault, error: 'HTTP 401 (9)' } } }));
  assert.equal(evaluateRepairFirst(input('Edit'), { home, now }).decision, 'block');
  fs.writeFileSync(path.join(home, '.claude/lane-health.json'), JSON.stringify({ lanes: { deepseek: { alive: true, reason: 'probe_ok' } } }));
  assert.equal(evaluateRepairFirst(input('Edit'), { home, now }).decision, 'pass');
});
test('quota_wait never blocks and context names cheap alternatives', t => {
  const { home, health } = fixture(t, { alive: false, reason: 'quota_wait', until: now + 1000 });
  assert.equal(evaluateRepairFirst(input('Edit'), { home, now }).decision, 'pass');
  assert.match(repairContext(health, home, now), /代替の安いレーン: groq/);
});
test('diagnostic invocations pass; compound and disguised writes block', () => {
  for (const cmd of ['node tools/lane-doctor.mjs --probe', 'node tools/lane-repair-log.mjs --lane deepseek --tried "key checked; HTTP 500" --result unfixable', 'node tools/env-kv.mjs --help', 'git status --short', 'gh pr view 123', 'wsl -d Ubuntu -u root -- codex exec --skip-git-repo-check "ping"', 'wsl -l -q', 'wsl --install -d Ubuntu --no-launch', 'wsl -d Ubuntu -u root -- npm install -g @openai/codex', 'wsl -d Ubuntu -u root -- codex login status']) assert.equal(repairCommand(cmd), true, cmd);
  for (const cmd of ['node tools/lane-doctor.mjs; touch x', 'node tools/lane-doctor.mjs && npm install', 'echo lane-doctor.mjs', 'node /tmp/lane-doctor.mjs', 'node tools/lane-doctor.mjs > x', 'git push', 'git diff --output=x', 'wsl -- bash -c "touch x"', 'gh pr create', 'node -e "writeFiles()"', 'node tools/lane-doctor.mjs $(touch x)', 'node tools/lane-doctor.mjs @(Remove-Item x)', 'git log --out=x', 'git diff --textconv']) assert.equal(repairCommand(cmd), false, cmd);
});
test('notify once at three consecutive unfixable attempts; fixed resets episode', async t => {
  const { home } = fixture(t); let notifications = 0;
  const notify = async () => { notifications++; return { delivered: 'test' }; };
  for (let i = 0; i < 5; i++) await recordRepair({ home, lane: 'deepseek', tried: `attempt ${i}`, result: 'unfixable', now: now + i, notify });
  assert.equal(notifications, 1);
  await recordRepair({ home, lane: 'deepseek', tried: 'recovered', result: 'fixed', now: now + 6, notify });
  for (let i = 0; i < 3; i++) await recordRepair({ home, lane: 'deepseek', tried: 'again', result: 'unfixable', now: now + 7 + i, notify });
  assert.equal(notifications, 2); assert.ok(repairRows(home).some(r => r.notified));
});
test('CLI exits 2 on Edit; crash fails open with error ledger', t => {
  const { home } = fixture(t);
  const run = raw => spawnSync(process.execPath, [script], { encoding: 'utf8', input: raw, env: { ...process.env, ORGIAST_HOME: home } });
  let r = run(JSON.stringify(input('Edit'))); assert.equal(r.status, 2); assert.match(r.stderr, /LANE-REPAIR-FIRST/);
  r = run('{bad'); assert.equal(r.status, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, '.claude/gate-errors.jsonl'))).verdict, 'fail-open');
});
test('runner retains deny on nonpilot PCs; audit block promotes abandonment', async t => {
  const { home } = fixture(t);
  const r = await runHook(script, JSON.stringify(input('Edit')), { env: { ...process.env, ORGIAST_HOME: home }, policyOptions: { home, hostname: 'new-PC', notify: async () => ({ delivered: 'test' }) } });
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'deny');
  fs.writeFileSync(path.join(home, '.claude/rule-enforcement.json'), JSON.stringify({ 'repair-failed-lane-first': { mode: 'block' } }));
  assert.equal(rolloutMode('lane-abandonment-gate', { home, manifest: { gates: { 'lane-abandonment-gate': { rollout: 'warn' } } } }), 'deny');
});
test('invalid repair records fail without exemption', async t => {
  const { home } = fixture(t);
  await assert.rejects(recordRepair({ home, lane: 'deepseek', tried: '', result: 'unfixable' }));
  await assert.rejects(recordRepair({ home, lane: 'unknown', tried: 'check', result: 'fixed' }));
  assert.equal(evaluateRepairFirst(input('Edit'), { home, now }).decision, 'block');
});

test('stale writer lock is recovered, active writer lock prevents duplicate records', async t => {
  const { home } = fixture(t), lock = path.join(home, '.claude/lane-repair-log.lock');
  fs.writeFileSync(lock, '');
  await assert.rejects(recordRepair({ home, lane: 'deepseek', tried: 'check', result: 'unfixable' }), { code: 'EEXIST' });
  const old = new Date(Date.now() - 120000); fs.utimesSync(lock, old, old);
  await recordRepair({ home, lane: 'deepseek', tried: 'check', result: 'unfixable' });
  assert.equal(repairRows(home).length, 1); assert.ok(!fs.existsSync(lock));
});

test('cd prefix permits one diagnostic invocation and preserves chain blocking', t => {
  const { home } = fixture(t);
  const repo = fileURLToPath(new URL('../', import.meta.url));
  for (const separator of ['&&', ';']) {
    const command = `cd "${repo}" ${separator} node tools/lane-repair-log.mjs --lane glm --tried checked --result unfixable`;
    assert.equal(evaluateRepairFirst(input('Bash', command), { home, now }).decision, 'pass');
    assert.equal(repairCommand(`${command} && rm -rf X`), false);
  }
  assert.equal(repairCommand('node tools/lane-repair-log.mjs --lane glm && rm -rf X'), false);
  assert.equal(repairCommand('cd /tmp && node tools/lane-repair-log.mjs'), false);
  // 実機で通らなかったケース: cd 前置 + repo パスの複合コマンドが gate を通過
  assert.equal(repairCommand(`cd "${repo}" && node tools/lane-repair-log.mjs --lane deepseek --tried checked --result unfixable`), true);
  assert.equal(repairCommand(`cd "${repo}" && node tools/lane-doctor.mjs --probe`), true);
  assert.equal(repairCommand(`cd "${repo}"; node tools/lane-doctor.mjs --probe`), true);
  // cd 前置だが && の後ろが許可外（cd で全部 block）
  assert.equal(repairCommand(`cd "${repo}" && node tools/lane-doctor.mjs --probe && npm install`), false);
  assert.equal(repairCommand(`cd "${repo}" && node tools/lane-doctor.mjs --probe && rm -rf /`), false);
  // cd 前置の dir に特殊文字
  assert.equal(repairCommand('cd some;path && node tools/lane-doctor.mjs'), false);
});
