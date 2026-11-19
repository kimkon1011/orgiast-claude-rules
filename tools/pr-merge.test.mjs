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
    if (args[0] === 'repo') return JSON.stringify({ nameWithOwner: 'owner/repo' });
    if (args.includes('--slurp')) return JSON.stringify([[{ filename: 'tools/example.mjs' }]]);
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

function restFixture({ error, deleteFails = false, restResult = { merged: true }, readback } = {}) {
  const base = fixture({ view: { headRefName: 'fix/rest-fallback' }, readback });
  const calls = [];
  return { calls, exec(file, args, options) {
    if (args[0] === 'repo') return JSON.stringify({ nameWithOwner: 'owner/repo' });
    if (args.includes('--slurp')) return JSON.stringify([[{ filename: 'tools/example.mjs' }]]);
    calls.push({ file, args, options });
    if (args[0] === 'pr' && args[1] === 'merge') throw error;
    if (args[0] === 'repo') return JSON.stringify({ nameWithOwner: 'owner/repo' });
    if (args[0] === 'api') {
      if (args[2] === 'DELETE' && deleteFails) throw new Error('delete denied');
      return JSON.stringify(restResult);
    }
    if (args.at(-1) === 'state,mergedAt') return JSON.stringify(readback ?? { state: 'MERGED', mergedAt: '2026-09-17T00:00:00Z' });
    return base.exec(file, args, options);
  } };
}

test('GraphQL権限エラーのみRESTで同じSHAをマージしread-backする', () => {
  for (const method of ['squash', 'merge']) {
    for (const field of ['stderr', 'message']) {
      const error = new Error('gh failed');
      error[field] = field === 'stderr'
        ? Buffer.from("GraphQL: does not have the correct permissions to execute 'MergePullRequest'")
        : "GraphQL: does not have the correct permissions to execute 'MergePullRequest'";
      const f = restFixture({ error });
      assert.equal(mergePr({ pr: 123, repo: process.cwd(), method }, f).state, 'MERGED');
      assert.deepEqual(f.calls[3].args, ['api', '-X', 'PUT', 'repos/owner/repo/pulls/123/merge', '-f', `merge_method=${method}`, '-f', `sha=${'a'.repeat(40)}`]);
      assert.deepEqual(f.calls[4].args, ['api', '-X', 'DELETE', 'repos/owner/repo/git/refs/heads/fix%2Frest-fallback']);
      assert.equal(f.calls[5].args.at(-1), 'state,mergedAt');
      assert(f.calls.every(call => call.options.cwd === process.cwd() && !call.options.shell));
      assert.match(f.calls[0].args.at(-1), /headRefName/);
    }
  }
});

test('REST後はkeepBranchを尊重し、削除失敗でもマージ後確認する', () => {
  const error = new Error('permission denied: MergePullRequest');
  const keep = restFixture({ error });
  assert.equal(mergePr({ pr: 1, keepBranch: true }, keep).state, 'MERGED');
  assert(!keep.calls.some(call => call.args.includes('DELETE')));
  const failedDelete = restFixture({ error, deleteFails: true });
  assert.equal(mergePr({ pr: 1 }, failedDelete).state, 'MERGED');
  const failedMerge = restFixture({ error, restResult: { merged: false, message: 'head changed' } });
  assert.throws(() => mergePr({ pr: 1 }, failedMerge), /REST マージ失敗/);
  assert(!failedMerge.calls.some(call => call.args.includes('DELETE')));
  assert.throws(() => mergePr({ pr: 1 }, restFixture({ error, readback: { state: 'OPEN', mergedAt: null } })), /read-back/);
});

test('別エラーはそのままthrowし、正常系ではRESTを呼ばない', () => {
  for (const message of ['network error', 'MergePullRequest failed: conflict', 'permission denied: other operation']) {
    const error = new Error(message);
    const f = restFixture({ error });
    assert.throws(() => mergePr({ pr: 1 }, f), value => value === error);
    assert.equal(f.calls.length, 3);
  }
  const normal = fixture();
  mergePr({ pr: 1 }, normal);
  assert(!normal.calls.some(call => ['api', 'repo'].includes(call.args[0])));
});

test('全ページのworkflow変更とパス取得失敗はマージを停止', () => {
  for (const response of [JSON.stringify([[{ filename: 'tools/a.mjs' }], [{ filename: '.github/workflows/x.yml' }]]),
    JSON.stringify([[{ filename: 'docs/old-workflow.yml', previous_filename: '.github/workflows/x.yml' }]]), '{}']) {
    const f = fixture();
    const exec = (file, args, options) => args.includes('--slurp') ? response : f.exec(file, args, options);
    assert.throws(() => mergePr({ pr: 1 }, { exec }), /停止|確認できません/);
    assert(!f.calls.some(c => c.args[1] === 'merge'));
  }
});

test('gh の timeout は既定値を使い、正の整数の環境変数で上書きできる', () => {
  const key = 'PR_MERGE_GH_TIMEOUT_MS';
  const original = process.env[key];
  try {
    for (const [value, expected] of [
      [undefined, 180_000], ['5000', 5_000], ['', 180_000], ['abc', 180_000],
      ['0', 180_000], ['-1', 180_000], ['1.5', 180_000], ['2147483648', 180_000],
    ]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
      const f = fixture();
      const timeouts = [];
      mergePr({ pr: 1 }, { exec(file, args, options) {
        timeouts.push(options.timeout);
        return f.exec(file, args, options);
      } });
      assert.deepEqual(timeouts, Array(6).fill(expected));
    }
  } finally {
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
});

function timeoutFixture(base, matches, failures = Infinity) {
  const attempts = [];
  const error = Object.assign(new Error('spawnSync gh ETIMEDOUT'), { code: 'ETIMEDOUT' });
  return { attempts, error, exec(file, args, options) {
    if (matches(args)) {
      attempts.push({ file, args, options });
      if (attempts.length <= failures) throw error;
    }
    return base.exec(file, args, options);
  } };
}

test('各読み取り系の ETIMEDOUT は同じ呼び出しを1回再試行して MERGED を返す', () => {
  for (const matches of [
    args => args[1] === 'view' && args.at(-1).includes('statusCheckRollup'),
    args => args[0] === 'repo' && args[1] === 'view',
    args => args[0] === 'api' && args.includes('--paginate'),
    args => args[1] === 'checks',
    args => args[1] === 'view' && args.at(-1) === 'state,mergedAt',
  ]) {
    const f = timeoutFixture(fixture(), matches, 1);
    assert.equal(mergePr({ pr: 1 }, f).state, 'MERGED');
    assert.equal(f.attempts.length, 2);
    assert.deepEqual(f.attempts[0], f.attempts[1]);
  }
});

test('読み取りが2回タイムアウトしたら延長方法を表示して停止する', () => {
  const base = fixture();
  const f = timeoutFixture(base, args => args[0] === 'pr' && args[1] === 'view');
  assert.throws(() => mergePr({ pr: 1 }, f), error => {
    assert.equal(error.message, `gh が ${f.attempts[0].options.timeout} ms 以内に応答しませんでした（PC 高負荷の可能性。PR_MERGE_GH_TIMEOUT_MS で延長可）`);
    return error.cause === f.error;
  });
  assert.equal(f.attempts.length, 2);
  assert.deepEqual(base.calls, []);
});

test('pr merge がタイムアウトしても再試行や REST マージを行わない', () => {
  const base = fixture();
  const f = timeoutFixture(base, args => args[1] === 'merge' || args.includes('PUT'));
  f.error.stderr = 'permission denied: MergePullRequest';
  assert.throws(() => mergePr({ pr: 1 }, f), /PR_MERGE_GH_TIMEOUT_MS/);
  assert.deepEqual(f.attempts.map(call => call.args.slice(0, 2)), [['pr', 'merge']]);
  assert.deepEqual(base.calls.map(call => call.args[1]), ['view', 'checks']);
});

test('REST PUT と DELETE のタイムアウトは再試行しない', () => {
  for (const method of ['PUT', 'DELETE']) {
    const base = restFixture({ error: new Error('permission denied: MergePullRequest') });
    const f = timeoutFixture(base, args => args[0] === 'api' && args[2] === method);
    if (method === 'PUT') assert.throws(() => mergePr({ pr: 1 }, f), /PR_MERGE_GH_TIMEOUT_MS/);
    else assert.equal(mergePr({ pr: 1 }, f).state, 'MERGED');
    assert.equal(f.attempts.length, 1);
  }
});
