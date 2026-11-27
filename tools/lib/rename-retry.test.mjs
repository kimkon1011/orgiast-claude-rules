import assert from 'node:assert/strict';
import test from 'node:test';
import { renameWithRetry, writeFileWithRetry } from './rename-retry.mjs';

const from = 'next-session.md.123.456.tmp';
const to = 'next-session.md';

for (const [name, method, invoke, args] of [
  ['rename', 'renameSync', (options) => renameWithRetry(from, to, options), [from, to]],
  ['write', 'writeFileSync', (options) => writeFileWithRetry(to, 'handoff', options), [to, 'handoff']],
]) {
  for (const code of ['EPERM', 'EBUSY', 'EACCES']) {
    test(`${name} retries ${code} twice before success`, () => {
      let calls = 0;
      const waits = [];
      const fsImpl = { [method](...actual) {
        assert.deepEqual(actual, args);
        if (++calls < 3) throw Object.assign(new Error('busy'), { code });
      } };
      invoke({ fsImpl, sleep: (ms) => waits.push(ms) });
      assert.equal(calls, 3);
      assert.deepEqual(waits, [50, 100]);
    });
  }
  test(`${name} immediately throws ENOENT`, () => {
    let calls = 0;
    const error = Object.assign(new Error('missing'), { code: 'ENOENT' });
    const fsImpl = { [method]() { calls++; throw error; } };
    assert.throws(() => invoke({ fsImpl, sleep: () => assert.fail('unexpected sleep') }), (e) => e === error);
    assert.equal(calls, 1);
  });
  test(`${name} exhausts eight attempts with capped waits and preserves the error`, () => {
    let calls = 0;
    const waits = [];
    const error = Object.assign(new Error('busy'), { code: 'EPERM' });
    const fsImpl = { [method]() { calls++; throw error; } };
    assert.throws(() => invoke({ fsImpl, sleep: (ms) => waits.push(ms) }), (e) => {
      assert.equal(e, error);
      assert.ok(e.message.includes(args[0]));
      assert.match(e.message, /attempts: 8/);
      return true;
    });
    assert.equal(calls, 8);
    assert.deepEqual(waits, [50, 100, 200, 400, 800, 1000, 1000]);
  });
}
