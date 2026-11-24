import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { publishSeatPr, landingRoute, waitForCi } from './pr-land.mjs';

const isAutomergeRestCall = call => call[0] === 'gh'
  && call[1] === 'api'
  && call.at(-1) === 'labels[]=automerge';
const isAutomergeRestDeleteCall = call => call[0] === 'gh'
  && call[1] === 'api'
  && call[2] === '-X'
  && call[3] === 'DELETE'
  && call[4] === 'repos/kimkon1011/repo/issues/123/labels/automerge';

function fixture(t, { files = ['tools/a.mjs'], push = true, account = 'nishi@orgiast.jp', existing = false } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'seat-pr-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: account } }));
  const base = { owner: { login: 'kimkon1011' }, full_name: 'kimkon1011/repo', permissions: { push }, default_branch: 'main' };
  const calls = [], url = 'https://github.com/kimkon1011/repo/pull/123';
  const run = (file, args) => {
    calls.push([file, ...args]);
    if (file === 'git') {
      if (args[0] === 'remote') return 'https://github.com/cr568/repo.git';
      if (args[0] === 'rev-parse') return 'a'.repeat(40);
      if (args[0] === 'diff') return files.join('\0');
      return '';
    }
    if (args[0] === 'api') {
      if (args.includes('--slurp')) return JSON.stringify([files.map(filename => ({ filename }))]);
      return JSON.stringify(args[1] === 'repos/cr568/repo' ? { fork: true, owner: { login: 'cr568' }, parent: base } : base);
    }
    if (args[1] === 'list') return JSON.stringify(existing ? [{ number: 123, url }] : []);
    if (args[1] === 'create') return url;
    if (args[1] === 'view') {
      if (args.includes('labels')) return JSON.stringify({ labels: [{ name: 'automerge' }] });
      if (args.includes('state,mergedAt')) return JSON.stringify({ state: 'MERGED', mergedAt: '2026-11-04' });
      return JSON.stringify({ state: 'OPEN', mergeable: 'MERGEABLE', reviewDecision: 'APPROVED', headRefOid: 'a'.repeat(40), statusCheckRollup: [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' }] });
    }
    if (args[1] === 'checks') return args.includes('--watch') ? '' : '[{"bucket":"pass"}]';
    return '';
  };
  return { home, calls, run, branch: 'feat/seat', title: 'seat', body: 'test', out() {} };
}
test('fork起点でもbaseへpush→PR→automergeラベル→read-back', t => {
  const f = fixture(t), result = publishSeatPr(f);
  assert.equal(result.route, 'automerge');
  assert(f.calls.find(c => c[1] === 'diff').includes('--no-renames'));
  assert.deepEqual(f.calls.find(c => c[1] === 'push'), ['git', 'push', 'https://seisaku-team-org@github.com/kimkon1011/repo.git', `${'a'.repeat(40)}:refs/heads/feat/seat`]);
  const create = f.calls.findIndex(c => c[2] === 'create'), label = f.calls.findIndex(isAutomergeRestCall);
  assert(create >= 0 && label > create);
  assert(!f.calls.some(c => c[2] === 'merge'));
});
test('automergeラベルはread:org不要のREST APIで付与する', t => {
  const f = fixture(t); publishSeatPr(f);
  assert.deepEqual(f.calls.find(isAutomergeRestCall), [
    'gh', 'api', '-X', 'POST', 'repos/kimkon1011/repo/issues/123/labels', '-f', 'labels[]=automerge',
  ]);
  assert(!f.calls.some(c => c.includes('--add-label')));
});
test('鍵関連はラベルを外しCIを待ち既存pr-mergeの検証とSHA固定を通す', t => {
  for (const file of ['tools/keyserve-auth.mjs', 'data/secrets.json', '.env.example']) {
    const f = fixture(t, { files: [file] });
    assert.equal(publishSeatPr(f).route, 'self-merge');
    assert(!f.calls.some(isAutomergeRestCall));
    assert(f.calls.some(isAutomergeRestDeleteCall));
    assert(f.calls.some(c => c.includes('statusCheckRollup')));
    const merge = f.calls.find(c => c[2] === 'merge');
    assert(merge.includes('--squash')); assert(merge.includes('--match-head-commit')); assert(merge.includes('kimkon1011/repo'));
    assert(f.calls.some(c => c.includes('state,mergedAt')));
  }
});
test('automergeラベルがない404でもself-mergeを続行する', t => {
  const f = fixture(t, { files: ['.env.example'] }), run = f.run;
  f.run = (file, args) => {
    if (isAutomergeRestDeleteCall([file, ...args])) {
      f.calls.push([file, ...args]);
      throw new Error('HTTP 404: Label does not exist');
    }
    return run(file, args);
  };
  assert.equal(publishSeatPr(f).route, 'self-merge');
  assert(f.calls.some(isAutomergeRestDeleteCall));
  assert(f.calls.some(c => c[2] === 'merge'));
});
test('workflow変更・権限なしはpush前に停止、非kim席は副作用なし', t => {
  for (const options of [{ files: ['.github/workflows/x.yml'] }, { push: false }]) {
    const f = fixture(t, options); assert.throws(() => publishSeatPr(f));
    assert(!f.calls.some(c => c[1] === 'push' || c[2] === 'create'));
  }
  const f = fixture(t, { account: 'employee@example.com' });
  assert.equal(publishSeatPr(f), null); assert.equal(f.calls.length, 0);
  assert.equal(landingRoute(['tools/keyserve.mjs', '.github/workflows/test.yml']), 'workflow-stop');
});
test('再実行は既存PRにラベルを補い、CI失敗・レビュー拒否時はmergeしない', t => {
  const f = fixture(t, { existing: true }); publishSeatPr(f);
  assert(!f.calls.some(c => c[2] === 'create')); assert(f.calls.some(isAutomergeRestCall));
  for (const failedStage of ['watch', 'review']) {
    const g = fixture(t, { files: ['.env.example'] }), run = g.run;
    g.run = (file, args) => {
      if (failedStage === 'watch' && args.includes('statusCheckRollup')) throw new Error('CI failed');
      const value = run(file, args);
      if (failedStage === 'review' && args.some(arg => arg.includes('reviewDecision'))) return JSON.stringify({ ...JSON.parse(value), reviewDecision: 'CHANGES_REQUESTED' });
      return value;
    };
    assert.throws(() => publishSeatPr(g)); assert(!g.calls.some(c => c[2] === 'merge'));
  }
});

test('CI未登録とpendingを待つ。失敗・期限切れはマージへ進めない', () => {
  let clock = 0, calls = 0;
  const pending = { __typename: 'CheckRun', status: 'IN_PROGRESS' };
  const pass = { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' };
  const run = () => JSON.stringify({ statusCheckRollup: [[], [pending], [pass]][calls++] });
  waitForCi(1, 'kimkon1011/repo', { run, now: () => clock, sleep: ms => { clock += ms; } });
  assert.equal(calls, 3);
  assert.equal(clock, 10000);
  assert.throws(() => waitForCi(1, 'kimkon1011/repo', { run: () => JSON.stringify({ statusCheckRollup: [{ ...pass, conclusion: 'FAILURE' }] }) }), /CI 失敗/);
  assert.throws(() => waitForCi(1, 'kimkon1011/repo', { run: () => '{"statusCheckRollup":[]}', now: () => clock, sleep: ms => { clock += ms; }, timeoutMs: 10 }), /上限/);
});
