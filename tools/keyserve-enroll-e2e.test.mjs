import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { main, parseArgs, resolveEndpoints } from './keyserve-enroll-e2e.mjs';

test('default is local with daily PC name and two-hour TTL', () => {
  const args = parseArgs([]);
  assert.equal(args.mode, 'local');
  assert.match(args.pc, /^AUTO-E2E-\d{8}$/);
  assert.equal(args.ttlHours, 2);
});

test('--prod selects production; PC and fractional TTL follow enroll CLI semantics', () => {
  assert.equal(parseArgs(['--prod']).mode, 'prod');
  assert.deepEqual(parseArgs(['--ttl-hours', '0.5', '--prod', '--pc', '日本語 PC']),
    { mode: 'prod', pc: '日本語 PC', ttlHours: 0.5 });
  assert.deepEqual(parseArgs(['--pc', 'PC', '--ttl-hours', '12']),
    { mode: 'local', pc: 'PC', ttlHours: 12 });
});

for (const argv of [
  ['--pc'], ['--ttl-hours'], ['--pc', '--prod'], ['--ttl-hours', '--pc', 'PC'],
  ['--pc', ''], ['--pc', '  '], ['--pc', 'a\nb'], ['--pc', 'a\rb'], ['--pc', 'a\0b'],
  ['--ttl-hours', '0'], ['--ttl-hours', '-1'], ['--ttl-hours', 'NaN'],
  ['--ttl-hours', 'Infinity'], ['--ttl-hours', 'no'], ['--ttl-hours', ' '],
]) {
  test(`invalid arguments throw: ${JSON.stringify(argv)}`, () => assert.throws(() => parseArgs(argv)));
}

test('unknown flags, including --help and --dm, return usage without echoing arguments', () => {
  for (const arg of ['--unknown', '--help', '--dm', 'ORG1.do-not-echo']) {
    assert.throws(() => parseArgs([arg]), { message: '使い方: node tools/keyserve-enroll-e2e.mjs [--prod] [--pc "PC名"] [--ttl-hours 2]' });
  }
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./keyserve-enroll-e2e.mjs', import.meta.url)), '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /^FAIL: 使い方: node tools\/keyserve-enroll-e2e\.mjs /);
});

test('endpoints default to production and respect independent environment overrides', () => {
  const defaults = { enrollUrl: 'https://orgiast-keyserve.vercel.app/api/enroll', keysUrl: 'https://orgiast-keyserve.vercel.app/api/keys' };
  assert.deepEqual(resolveEndpoints({}), defaults);
  assert.deepEqual(resolveEndpoints({ ORGIAST_KEYSERVE_ENROLL_URL: '', ORGIAST_KEYSERVE_URL: '' }), defaults);
  assert.deepEqual(resolveEndpoints({ ORGIAST_KEYSERVE_ENROLL_URL: 'https://enroll.invalid' }), { ...defaults, enrollUrl: 'https://enroll.invalid' });
  assert.deepEqual(resolveEndpoints({ ORGIAST_KEYSERVE_URL: 'https://keys.invalid' }), { ...defaults, keysUrl: 'https://keys.invalid' });
});

// Production orchestration is exercised with an injected child runner only:
// no server checkout, listener, fetch, real credentials, or notifications.
function fixture(t, fault) {
  const callerHome = fs.mkdtempSync(path.join(os.tmpdir(), 'keyserve-e2e-test-caller-'));
  t.after(() => fs.rmSync(callerHome, { recursive: true, force: true }));
  const token = 'ORG1.unit-test-token.signature';
  const env = {
    ORGIAST_HOME: callerHome, ORGIAST_KEYSERVE_SECRET: 'caller-primary',
    ORGIAST_KEYSERVE_ENROLL_URL: 'https://enroll.invalid', ORGIAST_KEYSERVE_URL: 'https://keys.invalid',
  };
  const f = { output: [], calls: [], home: undefined, token, env };
  f.dependencies = { env, stdout: (text) => f.output.push(text), run: async (script, args, childEnv, options) => {
    f.calls.push(script);
    const index = f.calls.length;
    assert.deepEqual(options, { includeOutput: false });
    assert.equal(childEnv.ORGIAST_KEYSERVE_ENROLL_URL, env.ORGIAST_KEYSERVE_ENROLL_URL);
    assert.equal(childEnv.ORGIAST_KEYSERVE_URL, env.ORGIAST_KEYSERVE_URL);
    if (index === 1) {
      assert.equal(script, 'keyserve-enroll.mjs');
      assert.deepEqual(args, ['--pc', 'TEST-PC', '--ttl-hours', '2', '--json']);
      assert.equal(childEnv.ORGIAST_HOME, callerHome);
      return { status: 0, stdout: JSON.stringify({ token }), stderr: '' };
    }
    f.home = childEnv.ORGIAST_HOME;
    assert.notEqual(f.home, callerHome);
    assert.equal(Object.hasOwn(childEnv, 'ORGIAST_KEYSERVE_SECRET'), false);
    assert.equal(env.ORGIAST_KEYSERVE_SECRET, 'caller-primary');
    const dir = path.join(f.home, '.claude');
    if (index === 2) {
      assert.deepEqual(fs.readdirSync(f.home), ['.claude']);
      assert.deepEqual(fs.readdirSync(dir), ['enroll.env']);
      assert.equal(fs.readFileSync(path.join(dir, 'enroll.env'), 'utf8'), `ORGIAST_ENROLL_TOKEN=${token}\n`);
      if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, 'enroll.env')).mode & 0o777, 0o600);
      fs.writeFileSync(path.join(dir, '.enroll-result.json'), JSON.stringify({ authVia: 'enroll', status: 200, kind: 'ok' }));
      fs.writeFileSync(path.join(dir, 'keyserve.env'), 'ORGIAST_KEYSERVE_SECRET=test-primary\n');
      fs.writeFileSync(path.join(dir, 'other.env'), 'DUMMY=test\n');
      fs.unlinkSync(path.join(dir, 'enroll.env'));
    }
    if (index < 4) {
      assert.equal(script, 'onboarding-sync.mjs');
      assert.deepEqual(args, ['--keys-only', '--force']);
    } else {
      assert.equal(script, 'keyserve-status.mjs');
      assert.deepEqual(args, ['--json']);
    }
    const result = { status: 0, stdout: index === 4 ? JSON.stringify({ auth: 'primary', status: 200 }) : '', stderr: '' };
    fault?.({ index, dir, result, token });
    return result;
  } };
  return f;
}

test('production completes without ORGIAST_KEYSERVE_REPO and removes isolated credentials', async (t) => {
  const f = fixture(t);
  assert.equal(Object.hasOwn(f.env, 'ORGIAST_KEYSERVE_REPO'), false);
  await main(['--prod', '--pc', 'TEST-PC'], f.dependencies);
  assert.equal(f.calls.length, 4);
  assert.equal(fs.existsSync(f.home), false);
  assert.deepEqual(fs.readdirSync(f.env.ORGIAST_HOME), []);
  assert.match(f.output.join('\n'), /OK: 認証経路: primary \/ HTTP 200/);
  assert.match(f.output.join('\n'), /接頭辞 ORG1\. \/ 長さ 30/);
  assert.ok(!f.output.join('\n').includes(f.token));
});

const failures = {
  'wrong enroll result': ({ index, dir }) => { if (index === 2) fs.writeFileSync(path.join(dir, '.enroll-result.json'), '{"authVia":"primary","status":200,"kind":"ok"}'); },
  'missing primary file': ({ index, dir }) => { if (index === 2) fs.unlinkSync(path.join(dir, 'keyserve.env')); },
  'empty primary file': ({ index, dir }) => { if (index === 2) fs.writeFileSync(path.join(dir, 'keyserve.env'), ' '); },
  'no other keys': ({ index, dir }) => { if (index === 2) fs.unlinkSync(path.join(dir, 'other.env')); },
  'enroll file not deleted': ({ index, dir, token }) => { if (index === 2) fs.writeFileSync(path.join(dir, 'enroll.env'), token); },
  'wrong status auth': ({ index, result }) => { if (index === 4) result.stdout = '{"auth":"legacy","status":200}'; },
  'wrong HTTP status': ({ index, result }) => { if (index === 4) result.stdout = '{"auth":"primary","status":401}'; },
  'nested binary token residue': ({ index, dir, token }) => {
    if (index === 4) {
      const nested = path.join(dir, 'nested');
      fs.mkdirSync(nested);
      fs.writeFileSync(path.join(nested, 'log.bin'), Buffer.concat([Buffer.from([0, 255]), Buffer.from(token)]));
    }
  },
  'malformed JSON containing token': ({ index, result, token }) => { if (index === 4) result.stdout = `invalid ${token}`; },
  'child exception containing token': ({ index, token }) => { if (index === 2) throw new Error(token); },
};
for (const index of [2, 3, 4]) {
  failures[`child ${index} fails`] = (f) => { if (f.index === index) f.result.status = 1; };
  for (const stream of ['stdout', 'stderr']) {
    failures[`child ${index} leaks to ${stream}`] = (f) => {
      if (f.index === index) f.result[stream] = stream === 'stdout' && index === 4
        ? JSON.stringify({ auth: 'primary', status: 200, leaked: f.token }) : f.token;
    };
  }
}
for (const [name, fault] of Object.entries(failures)) {
  test(`production rejects ${name}, suppresses secrets, and cleans up`, async (t) => {
    const f = fixture(t, fault);
    await assert.rejects(main(['--prod', '--pc', 'TEST-PC'], f.dependencies), (error) => {
      assert.match(error.message, /^本番 E2E 失敗: /);
      assert.ok(!String(error).includes(f.token));
      return true;
    });
    assert.ok(f.home);
    assert.equal(fs.existsSync(f.home), false);
    assert.deepEqual(f.output, []);
  });
}
