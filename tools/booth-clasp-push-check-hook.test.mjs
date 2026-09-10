import test from 'node:test';
import assert from 'node:assert/strict';
import { launchBoothClaspPushCheck } from './booth-clasp-push-check-hook.mjs';

const scriptPath = 'C:\\Users\\uers\\.claude\\hooks\\booth-clasp-push-check.mjs';

test('booth clasp push check を正しいコマンドとオプションで起動する', () => {
  let actual;
  const child = { unref() {} };
  const spawnImpl = (...args) => {
    actual = args;
    return child;
  };

  launchBoothClaspPushCheck({ spawnImpl });

  assert.deepEqual(actual, [
    process.execPath,
    [scriptPath],
    { detached: true, stdio: 'ignore', windowsHide: true },
  ]);
});

test('起動した子プロセスを unref して親をブロックしない', () => {
  let unrefCalled = false;
  const spawnImpl = () => ({
    unref() {
      unrefCalled = true;
    },
  });

  launchBoothClaspPushCheck({ spawnImpl });

  assert.equal(unrefCalled, true);
});

test('spawn が例外を投げてもフックへ伝播させない', () => {
  const error = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
  const spawnImpl = () => {
    throw error;
  };

  assert.doesNotThrow(() => launchBoothClaspPushCheck({ spawnImpl }));
});
