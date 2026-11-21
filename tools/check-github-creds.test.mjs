import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { checkGithubCreds } from './check-github-creds.mjs';

test('checkGithubCreds non-interactive spawn env', () => {
  let capturedArgs = null;
  let capturedOptions = null;
  const mockSpawn = (cmd, args, options) => {
    capturedArgs = args;
    capturedOptions = options;
    return {
      status: 0,
      stdout: 'username=testuser\npassword=fixture-password\n',
    };
  };

  const res = checkGithubCreds({ home: os.tmpdir(), spawnImpl: mockSpawn });
  assert.equal(res.ok, true);
  assert.equal(res.user, 'testuser');
  assert.equal(capturedOptions.env.GIT_TERMINAL_PROMPT, '0');
  assert.equal(capturedOptions.env.GIT_ASKPASS, '');
  assert.equal(capturedOptions.env.SSH_ASKPASS, '');
  assert.equal(capturedOptions.env.GCM_INTERACTIVE, 'never');
  assert.equal(capturedOptions.cwd, os.tmpdir());
  assert.ok(capturedArgs.includes('-c'));
  assert.ok(capturedArgs.includes('core.askPass='));
});

test('checkGithubCreds reports HTTP 401 without printing helper output', () => {
  const result = checkGithubCreds({
    spawnImpl: () => ({ status: 1, stderr: 'HTTP 401 Unauthorized: fixture-password' }),
  });
  assert.deepEqual(result, { ok: false, message: 'credential fill 失敗: HTTP 401' });
});
