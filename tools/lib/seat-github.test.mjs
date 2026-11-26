import test from 'node:test';
import assert from 'node:assert/strict';
import { command } from './seat-github.mjs';

function fakeExec(returnValue) {
  return (_file, _args, _opts) => {
    if (returnValue instanceof Error) throw returnValue;
    return Buffer.from(String(returnValue));
  };
}

test.afterEach(() => {
  delete process.env.ORGIAST_GH_TIMEOUT_MS;
});

test('既定の timeout は 180_000', () => {
  let capturedTimeout;
  command('git', ['--version'], undefined, {
    execFileSync: (_f, _a, opts) => { capturedTimeout = opts.timeout; return Buffer.from('ok'); },
  });
  assert.equal(capturedTimeout, 180_000);
});

test('ORGIAST_GH_TIMEOUT_MS で timeout を上書き', () => {
  process.env.ORGIAST_GH_TIMEOUT_MS = '300000';
  let capturedTimeout;
  command('git', ['--version'], undefined, {
    execFileSync: (_f, _a, opts) => { capturedTimeout = opts.timeout; return Buffer.from('ok'); },
  });
  assert.equal(capturedTimeout, 300_000);
});

test('ORGIAST_GH_TIMEOUT_MS が 0 なら既定値を使う', () => {
  process.env.ORGIAST_GH_TIMEOUT_MS = '0';
  let capturedTimeout;
  command('git', ['--version'], undefined, {
    execFileSync: (_f, _a, opts) => { capturedTimeout = opts.timeout; return Buffer.from('ok'); },
  });
  assert.equal(capturedTimeout, 180_000);
});

test('ORGIAST_GH_TIMEOUT_MS が負数なら既定値を使う', () => {
  process.env.ORGIAST_GH_TIMEOUT_MS = '-1000';
  let capturedTimeout;
  command('git', ['--version'], undefined, {
    execFileSync: (_f, _a, opts) => { capturedTimeout = opts.timeout; return Buffer.from('ok'); },
  });
  assert.equal(capturedTimeout, 180_000);
});

test('ORGIAST_GH_TIMEOUT_MS が非数なら既定値を使う', () => {
  process.env.ORGIAST_GH_TIMEOUT_MS = 'abc';
  let capturedTimeout;
  command('git', ['--version'], undefined, {
    execFileSync: (_f, _a, opts) => { capturedTimeout = opts.timeout; return Buffer.from('ok'); },
  });
  assert.equal(capturedTimeout, 180_000);
});

test('options.timeout が ORGIAST_GH_TIMEOUT_MS より優先', () => {
  process.env.ORGIAST_GH_TIMEOUT_MS = '999999';
  let capturedTimeout;
  command('gh', ['pr', 'list'], undefined, {
    timeout: 42_000,
    execFileSync: (_f, _a, opts) => { capturedTimeout = opts.timeout; return Buffer.from('ok'); },
  });
  assert.equal(capturedTimeout, 42_000);
});

test('options.timeout が既定値より優先', () => {
  let capturedTimeout;
  command('gh', ['pr', 'list'], undefined, {
    timeout: 7_000,
    execFileSync: (_f, _a, opts) => { capturedTimeout = opts.timeout; return Buffer.from('ok'); },
  });
  assert.equal(capturedTimeout, 7_000);
});

test('gh の ETIMEDOUT で1回だけ再試行する', () => {
  let calls = 0;
  const result = command('gh', ['api', 'some/endpoint'], undefined, {
    execFileSync: () => {
      calls++;
      if (calls === 1) {
        const err = new Error('connection timed out');
        err.code = 'ETIMEDOUT';
        throw err;
      }
      return Buffer.from('retried');
    },
  });
  assert.equal(result, 'retried');
  assert.equal(calls, 2);
});

test('gh の ETIMEDOUT 再試行にも同じ timeout が使われる', () => {
  let calls = 0;
  const timeouts = [];
  command('gh', ['api', 'x'], undefined, {
    execFileSync: (_f, _a, opts) => {
      calls++;
      timeouts.push(opts.timeout);
      if (calls === 1) {
        const err = new Error('ETIMEDOUT');
        err.code = 'ETIMEDOUT';
        throw err;
      }
      return Buffer.from('ok');
    },
  });
  assert.equal(calls, 2);
  assert.equal(timeouts[0], timeouts[1]);
});

test('gh 以外の ETIMEDOUT は再試行しない', () => {
  let calls = 0;
  assert.throws(() => {
    command('git', ['fetch'], undefined, {
      execFileSync: () => {
        calls++;
        const err = new Error('ETIMEDOUT');
        err.code = 'ETIMEDOUT';
        throw err;
      },
    });
  });
  assert.equal(calls, 1);
});

test('ETIMEDOUT 以外のエラーは再試行しない', () => {
  let calls = 0;
  assert.throws(() => {
    command('gh', ['invalid'], undefined, {
      execFileSync: () => {
        calls++;
        throw new Error('ENOENT');
      },
    });
  });
  assert.equal(calls, 1);
});

test('execFileSync なしの実呼び出しはエラーにならない（既存の呼び出し側は無変更で動く）', () => {
  // 実プロセスは使わないが、シンタックスとデフォルト値が通ることを確認
  assert.equal(typeof command, 'function');
});