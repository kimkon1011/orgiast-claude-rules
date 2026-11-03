import test from 'node:test';
import assert from 'node:assert/strict';
import { commitLanded, main } from './commit-landed.mjs';

const ok = stdout => ({ status: 0, stdout });
test('ancestor returns immediately', () => {
  assert.deepEqual(commitLanded('abc', { run: (exe, args) => {
    assert.equal(exe, 'git'); assert.deepEqual(args, ['merge-base', '--is-ancestor', 'abc', 'origin/main']);
    return ok('');
  } }), { sha: 'abc', landed: true, via: 'ancestor', pr: null, mergeCommit: null });
});
test('merged PR containing the resolved commit returns number and squash commit', () => {
  assert.deepEqual(commitLanded('abc', { cwd: '/fixture', run: (exe, args, options) => {
    assert.equal(options.cwd, '/fixture');
    if (exe === 'git') {
      if (args[0] === 'rev-parse') {
        assert.deepEqual(args, ['rev-parse', '--verify', 'abc^{commit}']);
        return ok('abc' + '1'.repeat(37) + '\n');
      }
      return { status: 1 };
    }
    assert.deepEqual(args, ['pr', 'list', '--state', 'merged', '--search', 'abc', '--json', 'number,mergedAt,mergeCommit,commits']);
    return ok(JSON.stringify([{ number: 1129, mergedAt: '2026-10-26', mergeCommit: { oid: 'squash' }, commits: [{ oid: 'abc' + '1'.repeat(37) }] }]));
  } }), { sha: 'abc', landed: true, via: 'pr', pr: 1129, mergeCommit: 'squash' });
});

function fixture({ gh = 'empty', single = 'single-id', aggregate = 'aggregate-id', recent = 'other-id', count = 2, resolved = 'abc' + '1'.repeat(37) } = {}) {
  const calls = [];
  const run = (exe, args, options) => {
    calls.push([exe, args, options.input]);
    if (exe === 'gh') {
      if (gh === 'missing') throw new Error('ENOENT');
      return gh === 'failed' ? { status: 1 } : ok(JSON.stringify(Array.isArray(gh) ? gh : []));
    }
    if (args[0] === 'merge-base') return args[1] === '--is-ancestor' ? { status: 1 } : ok('fork');
    if (args[0] === 'rev-parse') return resolved ? ok(resolved + '\n') : { status: 1 };
    if (args[0] === 'show') return ok('single patch');
    if (args[0] === 'rev-list') return ok(String(count));
    if (args[0] === 'diff') { assert.equal(args[3], 'fork..abc'); return ok('aggregate patch'); }
    if (args[0] === 'log') { assert.equal(args[1], '-300'); return ok('recent patches'); }
    if (args[0] === 'patch-id') {
      assert.deepEqual(args, ['patch-id', '--stable']);
      const ids = { 'single patch': single, 'aggregate patch': aggregate, 'recent patches': recent };
      assert.ok(Object.hasOwn(ids, options.input));
      return ok(ids[options.input] ? `${ids[options.input]} commit\n` : '');
    }
    assert.fail(`Unexpected command: ${exe} ${args}`);
  };
  return { run, calls };
}
test('single commit patch-id matches recent history', () => {
  const { run, calls } = fixture({ count: 1, recent: 'single-id' });
  assert.equal(commitLanded('abc', { run }).via, 'patch-id');
  assert.equal(calls.some(([, args]) => args[0] === 'diff'), false);
});
for (const gh of ['empty', 'failed', 'missing']) {
  test(`aggregate patch-id finds multi-commit squash with gh ${gh}`, () => {
    const { run } = fixture({ gh, recent: 'aggregate-id' });
    assert.equal(commitLanded('abc', { run }).via, 'patch-id');
  });
}
test('all checks false returns not landed', () => {
  assert.deepEqual(commitLanded('abc', fixture()), { sha: 'abc', landed: false, via: null, pr: null, mergeCommit: null });
});
test('empty patches never match empty history', () => {
  assert.equal(commitLanded('abc', fixture({ single: '', aggregate: '', recent: '' })).landed, false);
});

test('CLI JSON, cwd/base options and exit codes', t => {
  const output = [];
  t.mock.method(console, 'log', value => output.push(value));
  assert.equal(main(['abc', '--base', 'custom', '--cwd', '/fixture', '--json'], { run: (_exe, args, options) => {
    assert.equal(options.cwd, '/fixture');
    assert.deepEqual(args, ['merge-base', '--is-ancestor', 'abc', 'custom']);
    return ok('');
  } }), 0);
  assert.deepEqual(JSON.parse(output[0]), { sha: 'abc', landed: true, via: 'ancestor', pr: null, mergeCommit: null });
  assert.equal(main(['abc', '--json'], fixture()), 1);
  assert.equal(JSON.parse(output[1]).landed, false);
});

test('SHA only in PR body does not land when patch IDs differ', () => {
  const { run, calls } = fixture({ gh: [{ number: 826, mergedAt: '2026-10-26', body: 'abc', commits: [{ oid: '55af03a' + '0'.repeat(33) }] }] });
  assert.deepEqual(commitLanded('abc', { run }), { sha: 'abc', landed: false, via: null, pr: null, mergeCommit: null });
  assert.ok(calls.some(([, args]) => args[0] === 'patch-id'));
});
test('resolved full SHA requires exact equality despite matching prefix', () => {
  assert.equal(commitLanded('abc', fixture({ gh: [{ number: 826, mergedAt: '2026-10-26', commits: [{ oid: 'abc' + '2'.repeat(37) }] }] })).landed, false);
});
test('unresolved short SHA matches a PR commit prefix', () => {
  assert.equal(commitLanded('abc', fixture({ resolved: null, gh: [{ number: 827, mergedAt: '2026-10-26', commits: [{ oid: 'abc' + '2'.repeat(37) }] }] })).via, 'pr');
});
