import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runLlm, main } from './send-context-check.mjs';
import { updateGoals, writeJson, goalsPath, obviousGoalShrink } from './lib/case-goals.mjs';

const id = '260430EIG';
const ledger = () => updateGoals(null, id, 'set', { metric: '課題提供企業', target: 10, deadline: '2026-12-12', source: 'kim 10社（テスト）' });
const goals = () => ledger().goals.map(g => ({ ...g, caseId: id }));

test('promising 1 company triggers GOAL-SHRINK without any external call', () => {
  const result = runLlm([], '課題企業は1社で開催します。', { goals: goals(), spawn: () => { throw Error('must not call network'); } });
  assert.equal(result.ok, false); assert.match(result.reason, /GOAL-SHRINK/);
});
test('actual progress and unrelated counts are not deterministic shrink; negated shrink is not blocked', () => {
  for (const text of ['課題企業は現在1社確定、目標10社へ引き続き募集します', '受付スタッフは1名限定です', '課題企業は1社だけではなく10社を目指します']) assert.equal(obviousGoalShrink(text, goals()), null);
});
test('semantic count/alias check passes goals to non-Claude LLM, with no fallback and no intended-change exemption', () => {
  let calls = 0;
  const result = runLlm([], 'Cafe 212に加えてあと2社だけで実施します', { goals: goals(), intendedChanges: ['3社に縮小する'], spawn: (_node, args) => {
    calls++; assert.equal(args[args.indexOf('--provider') + 1], 'gemini'); assert.ok(args.includes('--no-fallback'));
    const prompt = fs.readFileSync(args[args.indexOf('--prompt-file') + 1], 'utf8');
    assert.match(prompt, /"target":10/); assert.match(prompt, /GOAL-SHRINK/); assert.match(prompt, /あと2社/);
    return { status: 0, stdout: JSON.stringify({ verdict: 'NG', reason: '公表枠が3社となり目標10社より少ない', warnings: [] }) };
  } });
  assert.equal(calls, 1); assert.equal(result.ok, false); assert.match(result.reason, /GOAL-SHRINK/);
});
test('semantic OK still runs the original context checker', () => {
  let calls = 0;
  const result = runLlm([], '現在1社確定です。目標10社を目指します。', { goals: goals(), spawn: () => {
    calls++; return { status: 0, stdout: JSON.stringify({ verdict: calls === 1 ? 'OK' : 'NG', reason: '履歴の未回答あり', warnings: [] }) };
  } });
  assert.equal(calls, 2); assert.equal(result.ok, false); assert.equal(result.reason, '履歴の未回答あり');
});
test('CLI binding finds goal, shrink creates no approval marker even with kim-approved', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-send-test-')), file = path.join(home, 'message.txt');
  writeJson(goalsPath(id, home), ledger()); writeJson(path.join(home, '.claude/case-binding/s1.json'), { cases: [id] });
  fs.writeFileSync(file, '課題企業は1社で開催します');
  const code = await main(['--channel', 'gmail', '--target', 'client@example.test', '--text-file', file, '--session', 's1', '--kim-approved', 'この本文の送信を承認'], { home, fetchHistory: () => { throw Error('must not fetch'); } });
  assert.equal(code, 2); assert.equal(fs.existsSync(path.join(home, '.claude/send-context-checks')), false);
});
