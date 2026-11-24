import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decideExecutionPolicy,
  detectIrreversibleSideEffect,
  detectSideEffectRisk,
  isCheapFirstEnabled,
} from '../tools/codex-do.mjs';

const sideEffectCommands = [
  'node tools/kim-inbox.mjs --add info --body-file x.md',
  'node tools/urgent-blocker.mjs --add "..."',
  'node tools/fleet-mail.mjs --send --kind note',
  'node tools/gmail-draft.mjs --send',
  'gh pr create --title x',
  'gh pr merge 123',
  'node tools/pr-land.mjs --title x',
  'git push origin HEAD',
  'vercel --prod',
  'curl -X POST https://example.com/hook',
];

for (const command of sideEffectCommands) {
  test(`detectSideEffectRisk detects: ${command}`, () => {
    const result = detectSideEffectRisk(command);
    assert.equal(result.detected, true);
    assert(result.matches.some((match) => command.includes(match)), `matches: ${JSON.stringify(result.matches)}`);
    assert.equal(detectIrreversibleSideEffect(command), true);
  });
}

const safeCommands = [
  'node --test test/foo.test.js',
  'git status',
  'gh pr list',
  'curl -X POST http://localhost:3000/api',
  '',
  null,
  undefined,
];

for (const command of safeCommands) {
  test(`detectSideEffectRisk ignores: ${String(command)}`, () => {
    assert.deepEqual(detectSideEffectRisk(command), { detected: false, matches: [] });
    assert.equal(detectIrreversibleSideEffect(command), false);
  });
}

test('decideExecutionPolicy disables fallback and retries for side effects', () => {
  const policy = decideExecutionPolicy({ instruction: sideEffectCommands[0] });
  assert.equal(policy.irreversible, true);
  assert.equal(policy.noFallback, true);
  assert.equal(policy.cheapFirstAllowed, false);
  assert.equal(policy.maxAttempts, 1);
  assert.notDeepEqual(policy.sideEffectReasons, []);
});

test('decideExecutionPolicy allows cheap-first and two attempts without side effects', () => {
  const policy = decideExecutionPolicy({ instruction: 'node --test test/foo.test.js' });
  assert.equal(policy.irreversible, false);
  assert.equal(policy.cheapFirstAllowed, true);
  assert.equal(policy.maxAttempts, 2);
});

test('allowFallback overrides detected side effects', () => {
  const policy = decideExecutionPolicy({ instruction: sideEffectCommands[0], allowFallback: true });
  assert.equal(policy.irreversible, false);
  assert.equal(policy.cheapFirstAllowed, true);
  assert.equal(policy.maxAttempts, 2);
});

test('sideEffects flag marks an otherwise safe instruction irreversible', () => {
  const policy = decideExecutionPolicy({ instruction: 'git status', sideEffects: true });
  assert.equal(policy.irreversible, true);
  assert.equal(policy.maxAttempts, 1);
  assert(policy.sideEffectReasons.includes('--side-effects'));
});

test('noFallback is honored for an instruction without side effects', () => {
  const policy = decideExecutionPolicy({ instruction: 'git status', noFallback: true });
  assert.equal(policy.noFallback, true);
  assert.equal(policy.irreversible, false);
});

test('regression: kim-inbox --add implement instructions cannot use cheap-first', () => {
  const instruction = '実装後に node tools/kim-inbox.mjs --add info --body-file x.md を実行する';
  assert.equal(isCheapFirstEnabled({ kind: 'implement', instruction, env: {} }), true);
  assert.equal(decideExecutionPolicy({ instruction }).cheapFirstAllowed, false);
});
