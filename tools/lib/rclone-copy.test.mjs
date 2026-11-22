import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCliArgs } from './rclone-copy.mjs';

test('CLI timeout defaults to six hours and preserves rclone arguments', () => {
  assert.deepEqual(parseCliArgs(['rclone.exe', 'source.zip', 'remote:file.zip', '--dry-run']), {
    executable: 'rclone.exe', source: 'source.zip', destination: 'remote:file.zip',
    extraArgs: ['--dry-run'], timeout: 6 * 60 * 60 * 1000,
  });
});

test('CLI timeout can be overridden by the caller', () => {
  assert.deepEqual(parseCliArgs(['--timeout-ms', '64800000', 'rclone.exe', 'source.zip', 'remote:file.zip']), {
    executable: 'rclone.exe', source: 'source.zip', destination: 'remote:file.zip',
    extraArgs: [], timeout: 18 * 60 * 60 * 1000,
  });
});

test('CLI timeout rejects missing, non-numeric, zero, and unsafe values', () => {
  for (const value of [undefined, 'nope', '0', '-1', String(Number.MAX_SAFE_INTEGER + 1)]) {
    const args = value === undefined ? ['--timeout-ms'] : ['--timeout-ms', value];
    assert.throws(() => parseCliArgs(args), /positive safe integer/);
  }
});
