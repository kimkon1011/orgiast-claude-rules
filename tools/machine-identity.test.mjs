import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { machineIdentity } from './machine-identity.mjs';

test('machineIdentity returns 未設定 without throwing when global git email is unset', (t) => {
  const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'machine-identity-'));
  t.after(() => fs.rmSync(emptyHome, { recursive: true, force: true }));
  const names = ['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME'];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  for (const name of names) process.env[name] = emptyHome;
  t.after(() => {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  });
  let identity;
  assert.doesNotThrow(() => { identity = machineIdentity(); });
  assert.equal(identity.gitEmail, '未設定');
  assert.equal(typeof identity.hostname, 'string');
  assert.equal(typeof identity.username, 'string');
});
