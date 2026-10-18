import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import * as platform from './platform.mjs';

test('platform overrides and restoration', () => {
  const saved = process.env.ORGIAST_PLATFORM;
  try {
    for (const name of ['linux', 'win32', 'darwin']) {
      process.env.ORGIAST_PLATFORM = name;
      assert.equal(platform.platformName(), name);
      assert.equal(platform.isLinux(), name === 'linux');
      assert.equal(platform.isWindows(), name === 'win32');
      assert.equal(platform.isMac(), name === 'darwin');
    }
    delete process.env.ORGIAST_PLATFORM;
    assert.equal(platform.platformName(), process.platform);
  } finally {
    if (saved === undefined) delete process.env.ORGIAST_PLATFORM;
    else process.env.ORGIAST_PLATFORM = saved;
  }
});
test('host directory helpers', () => {
  assert.equal(platform.homeDir(), os.homedir());
  assert.equal(platform.tempDir(), os.tmpdir());
  assert.equal(platform.claudeDir(), platform.pathJoin(platform.homeDir(), '.claude'));
});
