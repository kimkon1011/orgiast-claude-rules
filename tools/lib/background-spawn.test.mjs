import assert from 'node:assert/strict';
import test from 'node:test';
import { backgroundSpawnOptions } from './background-spawn.mjs';

test('Windows background root keeps a hidden console and is not detached', () => {
  assert.deepEqual(backgroundSpawnOptions('win32'), { windowsHide: true });
});

test('non-Windows background root remains detached', () => {
  assert.deepEqual(backgroundSpawnOptions('linux'), { detached: true });
  assert.deepEqual(backgroundSpawnOptions('darwin'), { detached: true });
});
