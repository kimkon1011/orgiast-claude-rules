import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { laneDoctorQuick, laneDoctorProbe } from './lane-doctor.mjs';
import { evaluateRepairFirst } from './lane-repair-first-gate.mjs';
import { deadLanes } from './lib/lane-health.mjs';
import { keyserveTierState, tierIncludes } from './lib/keyserve-tier.mjs';

const now = Date.parse('2026-11-25T00:00:00Z');
const tools = path.dirname(fileURLToPath(import.meta.url));
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'minimal-lanes-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const put = (name, value) => {
    const file = path.join(home, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
  };
  put('.claude/.keys-sync-state.json', { tier: 'minimal' });
  put('.claude/deepseek.env', 'DEEPSEEK_API_KEY=dummy-test\n');
  put('.claude/openrouter.env', 'OPENROUTER_API_KEY=dummy-test\n');
  put('.claude/keyserve.env', 'ORGIAST_KEYSERVE_SECRET=dummy-pc\nORGIAST_KEYSERVE_PC=lahaina-office\n');
  put('.codex/auth.json', { tokens: { id_token: 'dummy-oauth' } });
  return { home, put };
}

test('minimal quick/probe ignores absent provider faults and never probes or notifies them', async t => {
  const f = fixture(t), called = [], notifications = [];
  const omitted = ['gemini', 'glm', 'groq'];
  f.put('.claude/lane-health.json', { lanes: Object.fromEntries(omitted.map(p => [p, { alive: false, reason: 'billing' }])) });
  f.put('.claude/executor-usage.jsonl', omitted.flatMap(provider => Array.from({ length: 6 }, (_, i) => JSON.stringify({
    t: now - 10000 - i, provider, status: 'error', reason: 'HTTP 401',
  }))).join('\n'));
  const quick = laneDoctorQuick({ home: f.home, now, platform: 'linux', save: false });
  assert.deepEqual(quick.implementOrder, ['codex', 'deepseek', 'openrouter']);
  assert.deepEqual(quick.askOrder, ['deepseek', 'openrouter']);
  assert.equal(quick.repairFirst.required, false);
  assert.deepEqual(deadLanes(quick), []);
  const health = await laneDoctorProbe({ home: f.home, now, platform: 'linux',
    probe: async provider => { called.push(provider); return { code: 0, text: 'PONG' }; },
    notify: async text => { notifications.push(text); return { delivered: 'test' }; },
  });
  assert.deepEqual([...new Set(called)].sort(), ['codex', 'deepseek', 'openrouter']);
  assert.deepEqual(notifications, []);
  assert.deepEqual(deadLanes(health), []);
  assert.equal(health.repairFirst.required, false);
  assert.equal(evaluateRepairFirst({ tool_name: 'Write' }, { home: f.home, now }).decision, 'pass');
  assert.equal(evaluateRepairFirst({ tool_name: 'PowerShell', tool_input: { command: 'node app.mjs' } }, { home: f.home, now }).decision, 'pass');
});

test('stale excluded faults cannot lock minimal hooks; permitted lanes remain callable above guard budget', t => {
  const f = fixture(t);
  f.put('.claude/lane-health.json', { lanes: { groq: { alive: false, reason: 'auth_invalid' }, gemini: { alive: false, reason: 'real_fail_rate' } } });
  assert.equal(evaluateRepairFirst({ tool_name: 'Write' }, { home: f.home, now }).decision, 'pass');
  f.put('.claude/session-lane/s.json', { lane: 'implement', toolCalls: 100 });
  for (const command of ['node tools/codex-do.mjs --prompt-file task.md', 'node tools/llm-ask.mjs --backend deepseek test', 'node tools/llm-ask.mjs --backend openrouter test']) {
    const input = { session_id: 's', tool_name: 'Bash', tool_input: { command } };
    assert.equal(evaluateRepairFirst(input, { home: f.home, now }).decision, 'pass');
    const result = spawnSync(process.execPath, [path.join(tools, 'pretooluse-lane-guard.mjs')], {
      input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, ORGIAST_HOME: f.home }, windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), '');
  }
  // Actual failures in an allowed lane still require repair.
  f.put('.claude/lane-health.json', { lanes: { deepseek: { alive: false, reason: 'auth_invalid' } } });
  assert.equal(evaluateRepairFirst({ tool_name: 'Write' }, { home: f.home, now }).decision, 'block');
});

test('legacy seats retain their tier expectations and failures', t => {
  const f = fixture(t);
  f.put('.claude/.keys-sync-state.json', {});
  assert.equal(keyserveTierState(f.home), 'ai');
  assert.equal(tierIncludes('ai', 'minimal'), true);
  assert.equal(tierIncludes('minimal', 'ai'), false);
  f.put('.claude/lane-health.json', { lanes: { groq: { alive: false, reason: 'auth_invalid' } } });
  assert.equal(evaluateRepairFirst({ tool_name: 'Write' }, { home: f.home, now }).decision, 'block');
});
