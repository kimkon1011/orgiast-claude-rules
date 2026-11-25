import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { keyserveAuthHeaders, keyservePcId } from './keyserve-auth.mjs';

test('keyserveAuthHeaders optionally includes the PC identity without changing old calls', () => {
  assert.equal(keyserveAuthHeaders('secret', 1000, 'PC-A')['x-orgiast-pc'], 'PC-A');
  assert.equal('x-orgiast-pc' in keyserveAuthHeaders('secret', 1000), false);
});

test('keyservePcId resolves env, keyserve.env, then hostname', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'keyserve-auth-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, '.claude'));
  fs.writeFileSync(path.join(home, '.claude', 'keyserve.env'), 'ORGIAST_KEYSERVE_PC=file-pc\n');
  assert.equal(keyservePcId(home, { ORGIAST_KEYSERVE_PC: 'env-pc' }), 'env-pc');
  assert.equal(keyservePcId(home, {}), 'file-pc');
  fs.unlinkSync(path.join(home, '.claude', 'keyserve.env'));
  assert.equal(keyservePcId(home, {}), /^[A-Za-z0-9._-]{1,64}$/.test(os.hostname()) ? os.hostname() : '');
});

test('keyservePcId rejects symbols and values longer than 64 characters', () => {
  assert.equal(keyservePcId('/missing', { ORGIAST_KEYSERVE_PC: 'bad pc!' }), '');
  assert.equal(keyservePcId('/missing', { ORGIAST_KEYSERVE_PC: 'a'.repeat(65) }), '');
});

test('Japanese/empty hostname uses env, reporter, saved PC in order without ASCII conversion', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'keyserve-fallback-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, '.claude');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'cost-reporter.env'), 'REPORTER_LABEL=reporter-PC\n');
  fs.writeFileSync(path.join(dir, 'keyserve-pc.txt'), 'saved-PC\n');
  for (const hostname of ['作業用011', '']) {
    assert.equal(keyservePcId(home, { ORGIAST_KEYSERVE_PC: 'cr-PC' }, hostname), 'cr-PC');
    assert.equal(keyservePcId(home, {}, hostname), 'reporter-PC');
  }
  assert.equal(keyservePcId(home, {}, 'ascii-PC'), 'ascii-PC');
  fs.writeFileSync(path.join(dir, 'cost-reporter.env'), 'REPORTER_LABEL=作業用011\n');
  assert.equal(keyservePcId(home, {}, '作業用011'), 'saved-PC');
  fs.unlinkSync(path.join(dir, 'keyserve-pc.txt'));
  assert.equal(keyservePcId(home, {}, '作業用011'), '');
  assert.equal(keyservePcId(home, {}, ''), '');
});
