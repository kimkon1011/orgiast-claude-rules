import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { judge } from '../hooks/goal-pace-gate.mjs';
import { updateGoals, goalsPath, writeJson } from './lib/case-goals.mjs';
import { repositoryHooks, collapseHooks, effectiveHooks } from './hook-dispatch-registry.mjs';
import { rolloutMode } from './gate-runtime.mjs';
import { runHook } from './gate-hook-runner.mjs';
import { REQUIRED_HOOKS } from './hook-selfcheck.mjs';

const id = '260430EIG';
function fixture(deadline = '2026-12-12') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-pace-test-'));
  const data = updateGoals(null, id, 'set', { metric: '課題提供企業', target: 10, deadline, source: 'kim 2026-11-18（テスト）' });
  writeJson(goalsPath(id, home), data);
  writeJson(path.join(home, '.claude/case-binding/test-session.json'), { cases: [id] });
  const input = { session_id: 'test-session', hook_event_name: 'Stop', last_assistant_message: '' };
  const line = `【目標進捗】課題提供企業: 目標 10 / 現状 0 / 期日 ${deadline} / 必要ペース 1/日`;
  return { home, input, line, now: Date.parse('2026-11-18T04:00:00Z') };
}
test('goal without progress blocks; matching progress passes; unrelated/unbound session passes', () => {
  const f = fixture();
  assert.equal(judge(f.input, f).code, 'GOAL-PACE');
  assert.equal(judge({ ...f.input, last_assistant_message: f.line }, f).decision, 'pass');
  assert.equal(judge({ ...f.input, session_id: 'other' }, f).decision, 'pass');
});
test('incorrect target/current/deadline or example in fenced code does not pass', () => {
  const f = fixture();
  for (const text of [f.line.replace('目標 10', '目標 1'), f.line.replace('現状 0', '現状 1'), f.line.replace('12-12', '12-13'), '```\n' + f.line + '\n```', f.line.replace('1/日', '未定')]) {
    assert.equal(judge({ ...f.input, last_assistant_message: text }, f).decision, 'block');
  }
});
test('seven-day, today and overdue boundaries; delay and action must be in same paragraph', () => {
  for (const deadline of ['2026-11-25', '2026-11-18']) {
    const f = fixture(deadline);
    for (const suffix of ['', '\n遅れ', '\n10社へ送信する', '\n\n遅れ。10社へ送信する', '\n遅れ。別経路を検討']) assert.equal(judge({ ...f.input, last_assistant_message: f.line + suffix }, f).decision, 'block');
    for (const suffix of ['\n遅れ。明日10社へ送信する', '\n遅れ。別経路: 電話で追加打診する']) assert.equal(judge({ ...f.input, last_assistant_message: f.line + suffix }, f).decision, 'pass');
  }
  const expired = fixture('2026-11-17'); assert.equal(judge(expired.input, expired).decision, 'pass');
  const eight = fixture('2026-11-26'); assert.equal(judge({ ...eight.input, last_assistant_message: eight.line }, eight).decision, 'pass');
});
test('every metric is required; malformed ledger fails closed and stop_hook_active does not bypass', () => {
  const f = fixture();
  let data = JSON.parse(fs.readFileSync(goalsPath(id, f.home)));
  data = updateGoals(data, id, 'set', { metric: '参加者', target: 20, deadline: '2026-12-12', source: 'kim 20人' });
  writeJson(goalsPath(id, f.home), data);
  assert.equal(judge({ ...f.input, last_assistant_message: f.line, stop_hook_active: true }, f).decision, 'block');
  fs.writeFileSync(goalsPath(id, f.home), '{bad'); assert.equal(judge(f.input, f).decision, 'block');
});
test('actual hook process reads binding and transcript, and wrapped policy denies on a fresh non-pilot PC', async () => {
  const f = fixture('2099-12-12'), transcript = path.join(f.home, 'session.jsonl');
  fs.writeFileSync(transcript, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: f.line }] } }) + '\n');
  const env = { ...process.env, ORGIAST_HOME: f.home }, input = { session_id: 'test-session', hook_event_name: 'Stop', transcript_path: transcript };
  const pass = spawnSync(process.execPath, ['hooks/goal-pace-gate.mjs'], { env, input: JSON.stringify(input), encoding: 'utf8' });
  assert.equal(pass.status, 0, pass.stderr); assert.equal(pass.stdout, '');
  const blocked = await runHook('tools/goal-pace-gate.mjs', JSON.stringify({ ...input, last_assistant_message: '完了' }), { env, policyOptions: { home: f.home, hostname: 'new-seat', notify: async () => ({ delivered: 'test' }) } });
  assert.equal(JSON.parse(blocked.stdout).decision, 'block'); assert.match(blocked.stdout, /GOAL-PACE/);
});
test('converge registration, selfcheck and immediate all-seat rollout include the gate', () => {
  const repo = process.cwd(), home = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-registration-'));
  const hooks = repositoryHooks(repo, home), collapsed = collapseHooks(hooks, repo), effective = effectiveHooks({ hooks: collapsed.hooks }, collapsed.manifest);
  const registered = effective.Stop.flatMap(g => g.hooks).filter(h => h.command.includes('goal-pace-gate.mjs'));
  assert.equal(registered.length, 1); assert.equal(registered[0].timeout, 15); assert.equal(registered[0].critical, true);
  assert.ok(REQUIRED_HOOKS.some(([event, script]) => event === 'Stop' && script === 'goal-pace-gate.mjs'));
  assert.equal(rolloutMode('goal-pace-gate', { home, hostname: 'new-account-new-pc' }), 'deny');
  const setup = JSON.parse(fs.readFileSync('tools/setup-manifest.json'));
  assert.equal(setup.items.find(x => x.id === 'settings:goal-pace-gate').severity, 'required');
});
