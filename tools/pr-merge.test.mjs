import test from 'node:test';
import assert from 'node:assert/strict';
import { mergePr, parseArgs } from './pr-merge.mjs';

function fixture({ view = {}, checks, readback, failAt } = {}) {
  const calls = [];
  const answers = [
    { state: 'OPEN', mergeable: 'MERGEABLE', reviewDecision: 'APPROVED', headRefOid: 'a'.repeat(40), statusCheckRollup: [
      { __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { __typename: 'StatusContext', context: 'legacy', state: 'SUCCESS' },
    ], ...view },
    checks ?? [{ name: 'test', bucket: 'pass', state: 'SUCCESS' }],
    '', readback ?? { state: 'MERGED', mergedAt: '2026-09-17T00:00:00Z' },
  ];
  return { calls, exec(file, args, options) {
    calls.push({ file, args, options });
    if (calls.length === failAt) throw new Error('gh failed');
    return JSON.stringify(answers[calls.length - 1]);
  } };
}
test('検査2経路→マージ→read-back、シェルを使わず指定repoで実行', () => {
  for (const method of ['squash', 'merge']) {
    const f = fixture();
    assert.equal(mergePr({ pr: 123, method }, f).state, 'MERGED');
    assert.equal(f.calls.length, 4);
    assert.deepEqual(f.calls[2].args, ['pr', 'merge', '123', `--${method}`, '--delete-branch', '--match-head-commit', 'a'.repeat(40)]);
    assert(f.calls.every(c => c.file === 'gh' && c.options.cwd === process.cwd() && !c.options.shell));
    assert.equal(f.calls[3].args.at(-1), 'state,mergedAt');
  }
});
test('拒否・未確定・失敗チェック・チェック欠落ならマージしない', () => {
  for (const view of [
    { state: 'CLOSED' }, { mergeable: 'CONFLICTING' }, { mergeable: 'UNKNOWN' },
    { reviewDecision: 'CHANGES_REQUESTED' }, { statusCheckRollup: [] }, { statusCheckRollup: null },
    { headRefOid: '' },
    ...['FAILURE', 'CANCELLED', 'NEUTRAL', 'SKIPPED', 'TIMED_OUT', 'ACTION_REQUIRED'].map(conclusion => ({ statusCheckRollup: [{ __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion }] })),
    { statusCheckRollup: [{ __typename: 'CheckRun', status: 'IN_PROGRESS', conclusion: null }] },
    { statusCheckRollup: [{ __typename: 'StatusContext', state: 'PENDING' }] },
  ]) {
    const f = fixture({ view });
    assert.throws(() => mergePr({ pr: 1 }, f));
    assert(!f.calls.some(c => c.args[1] === 'merge'));
  }
  for (const checks of [[], [{ bucket: 'pending' }], [{ bucket: 'fail' }], [{ bucket: 'skipping' }], [{ bucket: 'cancel' }]]) {
    const f = fixture({ checks });
    assert.throws(() => mergePr({ pr: 1 }, f));
    assert.equal(f.calls.length, 2);
  }
});
test('gh失敗とread-back不一致は成功扱いにしない', () => {
  for (const failAt of [1, 2, 3, 4]) assert.throws(() => mergePr({ pr: 1 }, fixture({ failAt })), /gh failed/);
  assert.throws(() => mergePr({ pr: 1 }, fixture({ readback: { state: 'OPEN', mergedAt: null } })), /read-back/);
});
test('CLI引数を検証する', () => {
  assert.equal(parseArgs(['2']).method, 'squash');
  for (const args of [[], ['0'], ['1;ls'], ['1', '--method', 'rebase'], ['1', '--repo'], ['1', '--bad', 'x'], ['1', '--method', 'merge', '--method', 'squash']]) assert.throws(() => parseArgs(args));
});
