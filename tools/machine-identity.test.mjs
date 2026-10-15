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

test('getClaudeAccountEmail は oauthAccount を読み、失敗時は null', async (t) => {
  const { getClaudeAccountEmail, macSerial } = await import('./machine-identity.mjs');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'machine-identity-acct-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  assert.equal(getClaudeAccountEmail(home), null);
  fs.writeFileSync(path.join(home, '.claude.json'), '﻿' + JSON.stringify({ oauthAccount: { emailAddress: 'cr@orgiast.jp' } }));
  assert.equal(getClaudeAccountEmail(home), 'cr@orgiast.jp');
  fs.writeFileSync(path.join(home, '.claude.json'), '{broken');
  assert.equal(getClaudeAccountEmail(home), null);
  assert.equal(macSerial(() => ({ status: 0, stdout: '"IOPlatformSerialNumber" = "C02ABC"' }), 'darwin'), 'C02ABC');
  assert.equal(macSerial(() => { throw new Error('x'); }, 'darwin'), null);
  assert.equal(macSerial(undefined, 'win32'), null);
});
