import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { evaluateLaneClaimEvidence as evaluate } from './lane-claim-evidence-gate.mjs';
import { atomicJson, PROVIDERS } from './lane-doctor.mjs';
import { rolloutMode } from './gate-runtime.mjs';
const now = Date.parse('2026-11-17T08:00:00Z'), at = new Date(now).toISOString();
const marker = (lane = 'codex', time = at) => `[LANE-PROBE: lane=${lane} at=${time} direct=yes result=fail evidence=exit 1]`;
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claim-evidence-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const health = { lanes: { codex: { alive: false, reason: 'billing', probedAt: at, viaChain: false, probeResult: 'fail' } } };
  const save = () => atomicJson(path.join(home, '.claude/lane-health.json'), health);
  save();
  return { home, health, save, run: text => evaluate({ assistantText: text, sessionId: 'test' }, { home, now }) };
}
test('unsupported stop blocks and direct matching evidence passes', t => {
  const { run } = fixture(t);
  assert.equal(run('Codex は残高切れです。').decision, 'block');
  assert.equal(run(`Codex は残高切れです。\n${marker()}`).decision, 'pass');
});
for (const variant of ['alive', 'chain', 'stale', 'future', 'inconclusive', 'missing-direct', 'quota']) test(`rejects ${variant} evidence`, t => {
  const { run, health, save } = fixture(t), state = health.lanes.codex;
  if (variant === 'alive') { state.alive = true; state.probeResult = 'alive'; }
  if (variant === 'chain') state.viaChain = true;
  if (variant === 'stale') state.probedAt = new Date(now - 1800001).toISOString();
  if (variant === 'future') state.probedAt = new Date(now + 1).toISOString();
  if (variant === 'inconclusive') state.reason = 'probe_inconclusive';
  if (variant === 'missing-direct') delete state.viaChain;
  if (variant === 'quota') state.reason = 'quota_wait';
  save();
  assert.equal(run(`Codex は残高切れです。\n${marker('codex', state.probedAt)}`).decision, 'block');
});
test('quoted prose, both fences, open fence and explicitly unverified display pass', t => {
  const { run } = fixture(t);
  for (const text of ['> Codex は残高切れ', '```\nCodex は残高切れ\n```', '~~~\nCodex は残高切れ\n~~~', '```\nCodex は残高切れ', 'Gemini の残高が切れていると lane-watch が表示している（実測は未確認）']) assert.equal(run(text).decision, 'pass', text);
  assert.equal(run(`Codex は残高切れ\n> ${marker()}`).decision, 'block');
});
test('three block session cap survives new turns and CLI instances', t => {
  const { run, home } = fixture(t);
  for (let i = 0; i < 3; i++) assert.equal(run(`Codex は停止中 ${i}`).decision, 'block');
  assert.equal(run('Codex は停止中').decision, 'warn');
  assert.equal(evaluate({ assistantText: 'Codex は停止中', sessionId: 'another' }, { home, now }).decision, 'block');
});
test('all lanes need evidence, one alive lane contradicts total outage', t => {
  const { run, health, save } = fixture(t);
  for (const lane of PROVIDERS) health.lanes[lane] = { ...health.lanes.codex };
  save();
  assert.equal(run(`全レーン停止。\n${marker()}`).decision, 'block');
  const text = `全レーン停止。\n${PROVIDERS.map(l => marker(l)).join('\n')}`;
  assert.equal(run(text).decision, 'pass');
  health.lanes.deepseek.alive = true; save();
  assert.equal(run(text).decision, 'block');
});
test('Stop CLI consumes transcript and emits block JSON / silent pass', t => {
  const { home, health, save } = fixture(t);
  health.lanes.codex.probedAt = new Date().toISOString(); save();
  const transcript = path.join(home, 'transcript.jsonl');
  const run = text => {
    fs.writeFileSync(transcript, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } }));
    return spawnSync(process.execPath, ['tools/lane-claim-evidence-gate.mjs'], { encoding: 'utf8', env: { ...process.env, ORGIAST_HOME: home }, input: JSON.stringify({ session_id: 'cli', transcript_path: transcript }) });
  };
  const blocked = run('Codex は残高切れです');
  assert.equal(blocked.status, 0); assert.equal(JSON.parse(blocked.stdout).decision, 'block');
  const passed = run(`Codex は残高切れです\n${marker('codex', health.lanes.codex.probedAt)}`);
  assert.equal(passed.status, 0); assert.equal(passed.stdout, '');
});
test('registered in shared Stop runner, rollout and converge; tests auto-discovered', t => {
  const { home } = fixture(t);
  const name = 'lane-claim-evidence-gate';
  assert.ok(fs.readFileSync('tools/stop-gate-runner.mjs', 'utf8').includes(`[\'${name}\', () => evaluateLaneClaimEvidence`));
  const manifest = JSON.parse(fs.readFileSync('tools/gate-rollout-manifest.json'));
  assert.equal(rolloutMode(name, { home, manifest, hostname: 'new-PC' }), 'deny');
  const setup = JSON.parse(fs.readFileSync('tools/setup-manifest.json'));
  assert.ok(setup.items.some(item => item.id === `hook:${name}`));
});
