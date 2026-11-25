import test from 'node:test';
import assert from 'node:assert/strict';
import { wslInstalled } from './lib/wsl-present.mjs';
import { discoverWsl } from './lib/quota-sweep-host.mjs';

test('only Windows with a GUID distro registry subkey is installed', () => {
  const key = 'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss';
  for (const output of ['', key, `${key}\\not-a-guid`, `${key}\n DefaultDistribution REG_SZ {12345678-1234-1234-1234-123456789abc}`]) {
    assert.equal(wslInstalled({ platform: 'win32', regQuery: () => output }), false);
  }
  assert.equal(wslInstalled({ platform: 'win32', regQuery(file, args, options) {
    assert.equal(file, 'reg.exe'); assert.equal(args[0], 'query');
    assert.equal(options.windowsHide, true); assert.equal(options.timeout, 5000);
    return `${key}\\{12345678-1234-1234-1234-123456789abc}\r\n`;
  } }), true);
  assert.equal(wslInstalled({ platform: 'win32', regQuery() { throw Error(); } }), false);
  assert.equal(wslInstalled({ platform: 'linux', regQuery() { assert.fail(); } }), false);
});
test('quota discovery never spawns WSL when no distro is installed', () => {
  assert.equal(discoverWsl({ platform: 'win32', wslInstalled: () => false, spawnImpl() { assert.fail(); } }), null);
});
test('quota discovery still probes installed distro', () => {
  let count = 0;
  assert.equal(discoverWsl({ platform: 'win32', wslInstalled: () => true, spawnImpl() {
    return { status: 0, stdout: count++ ? '/home/user' : 'Ubuntu' };
  } }).unixHome, '/home/user');
  assert.equal(count, 2);
});
