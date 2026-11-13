import test from 'node:test';
import assert from 'node:assert/strict';
import { main } from './register-external-waiting.mjs';

for (const key of ['PSModulePath', 'PSMODULEPATH', 'psmodulepath']) {
  test(`Windows PowerShell does not inherit ${key} from pwsh`, () => {
    const env = Object.freeze({ [key]: 'C:\\Program Files\\PowerShell\\7\\Modules', PATH: 'keep-path', ORGIAST_HOME: 'keep-home' });
    let calls = 0;
    assert.equal(main({ platform: 'win32', env, spawnImpl(command, args, options) {
      calls++;
      assert.equal(command, 'powershell.exe');
      assert.ok(args.includes('-File'));
      assert.deepEqual(options.env, { PATH: 'keep-path', ORGIAST_HOME: 'keep-home' });
      assert.notEqual(options.env, env);
      return { status: 0, stdout: 'registered' };
    } }), 0);
    assert.equal(calls, 1);
    assert.ok(env[key].includes('PowerShell'));
  });
}

test('preserves an environment without PSModulePath', () => {
  main({ platform: 'win32', env: { PATH: 'keep-path' }, spawnImpl(command, args, options) {
    assert.deepEqual(options.env, { PATH: 'keep-path' });
    return { status: 0 };
  } });
});

test('does not spawn on non-Windows platforms', () => {
  assert.equal(main({ platform: 'linux', spawnImpl() { assert.fail('unexpected spawn'); } }), 0);
});
