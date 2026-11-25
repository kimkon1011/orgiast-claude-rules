import assert from 'node:assert/strict';
import test from 'node:test';
import { mergePrWithRetry } from '../tools/pr-merge.mjs';

const baseView = {
  state: 'OPEN',
  mergeable: 'UNKNOWN',
  mergeStateStatus: 'UNKNOWN',
  reviewDecision: 'APPROVED',
  statusCheckRollup: [{ __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }],
  headRefOid: 'a'.repeat(40),
  headRefName: 'fix/test',
};

function fakeExec(mergeableValues) {
  const calls = [];
  let viewIndex = 0;
  const exec = (_command, args) => {
    calls.push(args);
    if (args[0] === 'pr' && args[1] === 'view' && args.includes('number,mergeable,mergeStateStatus')) {
      return JSON.stringify({ number: 42, mergeable: mergeableValues[viewIndex++] || mergeableValues.at(-1), mergeStateStatus: 'CLEAN' });
    }
    if (args[0] === 'pr' && args[1] === 'view' && args.includes('state,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,headRefOid,headRefName')) {
      return JSON.stringify(baseView);
    }
    if (args[0] === 'repo' && args[1] === 'view') return JSON.stringify({ nameWithOwner: 'owner/repo' });
    if (args[0] === 'api' && args.includes('--paginate')) return JSON.stringify([[{ filename: 'tools/example.mjs' }]]);
    if (args[0] === 'pr' && args[1] === 'checks') return JSON.stringify([{ name: 'test', bucket: 'pass', state: 'SUCCESS' }]);
    if (args[0] === 'pr' && args[1] === 'merge') return '';
    if (args[0] === 'pr' && args[1] === 'view' && args.includes('state,mergedAt')) return JSON.stringify({ state: 'MERGED', mergedAt: '2026-11-23T00:00:00Z' });
    throw new Error(`unexpected gh call: ${args.join(' ')}`);
  };
  return { exec, calls };
}

const noWait = async () => {};

test('UNKNOWN が2回続いた後 MERGEABLE ならマージする', async () => {
  const fake = fakeExec(['UNKNOWN', 'UNKNOWN', 'MERGEABLE']);
  const result = await mergePrWithRetry({ pr: 42, repo: process.cwd() }, { exec: fake.exec, sleep: noWait });
  assert.equal(result.state, 'MERGED');
  assert.ok(fake.calls.some(args => args[0] === 'pr' && args[1] === 'merge'));
});

test('5回再照会しても UNKNOWN ならマージしない', async () => {
  const fake = fakeExec(['UNKNOWN', 'UNKNOWN', 'UNKNOWN', 'UNKNOWN', 'UNKNOWN', 'UNKNOWN']);
  await assert.rejects(
    mergePrWithRetry({ pr: 42, repo: process.cwd() }, { exec: fake.exec, sleep: noWait }),
    /mergeable 未確定/,
  );
  assert.equal(fake.calls.filter(args => args[0] === 'pr' && args[1] === 'view' && args.includes('number,mergeable,mergeStateStatus')).length, 6);
  assert.ok(!fake.calls.some(args => args[0] === 'pr' && args[1] === 'merge'));
});

test('CONFLICTING なら衝突として終了する', async () => {
  const fake = fakeExec(['CONFLICTING']);
  await assert.rejects(
    mergePrWithRetry({ pr: 42, repo: process.cwd() }, { exec: fake.exec, sleep: noWait }),
    /衝突/,
  );
  assert.ok(!fake.calls.some(args => args[0] === 'pr' && args[1] === 'merge'));
});
