import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveKeyserveSecret } from './keyserve-secret.mjs';

test('resolveKeyserveSecret: primary > enroll environment > enroll file > legacy > none', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'keyserve-resolve-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, '.claude');
  fs.mkdirSync(dir);
  const values = Array.from({ length: 5 }, () => crypto.randomBytes(24).toString('hex'));
  const put = (file, key, value) => fs.writeFileSync(path.join(dir, file), `\uFEFF${key}=${value}\r\n`);
  const check = (source, secret, env = {}) => {
    const actual = resolveKeyserveSecret({ home, env });
    assert.equal(actual.source, source);
    assert.ok(actual.secret === secret, 'resolved the expected credential without printing it');
  };
  check('none', '');
  put('cost-reporter.env', 'REPORTER_LABEL', 'old-pc');
  check('none', '');
  put('cost-reporter.env', 'DISCORD_COST_WEBHOOK', values[0]);
  check('legacy', values[0]);
  put('enroll.env', 'ORGIAST_ENROLL_TOKEN', values[1]);
  check('enroll', values[1]);
  const env = { ORGIAST_ENROLL_TOKEN: values[2] };
  check('enroll', values[2], env);
  put('keyserve.env', 'ORGIAST_KEYSERVE_SECRET', values[3]);
  check('primary', values[3], env);
  check('primary', values[4], { ...env, ORGIAST_KEYSERVE_SECRET: values[4] });
  put('keyserve.env', 'ORGIAST_KEYSERVE_SECRET', '');
  check('enroll', values[1]);
  put('enroll.env', 'ORGIAST_ENROLL_TOKEN', '');
  check('legacy', values[0]);
});
