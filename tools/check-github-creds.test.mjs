import test from 'node:test';
import assert from 'node:assert/strict';
import { checkGithubCreds } from './check-github-creds.mjs';

test('checkGithubCreds non-interactive spawn env', () => {
  let capturedArgs = null;
  let capturedOptions = null;
  const mockSpawn = (cmd, args, options) => {
    capturedArgs = args;
    capturedOptions = options;
    return {
      status: 0,
      stdout: 'username=testuser\npassword=ghp_1234567890123456\n',
    };
  };

  const res = checkGithubCreds({ home: '/tmp', spawnImpl: mockSpawn });
  assert.equal(res.ok, true);
  assert.equal(res.user, 'testuser');
  assert.equal(capturedOptions.env.GIT_TERMINAL_PROMPT, '0');
  assert.equal(capturedOptions.env.GIT_ASKPASS, '');
  assert.equal(capturedOptions.env.SSH_ASKPASS, '');
  assert.equal(capturedOptions.env.GCM_INTERACTIVE, 'never');
  assert.equal(capturedOptions.cwd, '/tmp');
  assert.ok(capturedArgs.includes('-c'));
  assert.ok(capturedArgs.includes('core.askPass='));
});
