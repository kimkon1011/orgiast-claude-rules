import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkDomains, extractEmails, isInternalDomain } from './mail-domain-check.mjs';
const fail = code => async () => { throw Object.assign(new Error(code), { code }); };
const dns = (mx = fail('ENOTFOUND'), a = fail('ENOTFOUND'), aaaa = fail('ENOTFOUND')) => ({ resolveMx: mx, resolve4: a, resolve6: aaaa });
const check = (resolver, options = {}) => checkDomains(['example.com'], { resolver, cachePath: null, ...options });
test('emails normalize and deduplicate; internal subdomains only', () => {
  assert.deepEqual(extractEmails('A <A@Example.COM> a@example.com b@sub.orgiast.jp'), ['a@example.com', 'b@sub.orgiast.jp']);
  assert.ok(isInternalDomain('a.orgiast.jp')); assert.ok(isInternalDomain('orgiast.jp'));
  assert.ok(!isInternalDomain('notorgiast.jp')); assert.ok(!isInternalDomain('orgiast.jp.evil.com'));
});
test('MX succeeds', async () => assert.deepEqual((await check(dns(async () => [{ exchange: 'mx.example.com' }]))).ok, ['example.com']));
test('NXDOMAIN is bad with nonexistent reason', async () => assert.match((await check(dns())).bad[0].reason, /ドメインが存在しない/));
test('no records is bad with MX/A reason', async () => assert.match((await check(dns(fail('ENODATA'), async () => [], fail('ENODATA')))).bad[0].reason, /MX も A も無い/));
test('A or AAAA fallback succeeds', async () => {
  for (const resolver of [dns(fail('ENODATA'), async () => ['1.2.3.4']), dns(fail('ENOTFOUND'), fail('ENODATA'), async () => ['::1'])]) assert.equal((await check(resolver)).ok.length, 1);
});
test('transient errors stay unknown including fallback', async () => {
  for (const code of ['ETIMEOUT', 'ESERVFAIL', 'ECONNREFUSED']) assert.equal((await check(dns(fail(code)))).unknown.length, 1);
  assert.equal((await check(dns(fail('ENODATA'), fail('ESERVFAIL')))).unknown.length, 1);
});
test('deadline bounds a hanging resolver', async () => assert.equal((await check(dns(() => new Promise(() => {})), { timeoutMs: 15 })).unknown.length, 1));
test('only successes cached, hit skips DNS, expiry retries', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-cache-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cachePath = path.join(dir, 'cache.json'); let calls = 0;
  const resolver = dns(async () => { calls++; return [{}]; });
  await check(resolver, { cachePath, now: 100 });
  await check(resolver, { cachePath, now: 101 }); assert.equal(calls, 1);
  await check(resolver, { cachePath, now: 100 + 7 * 86400000 }); assert.equal(calls, 2);
  await checkDomains(['bad.example'], { resolver: dns(), cachePath, now: 101 });
  assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(cachePath)), 'bad.example'), false);
});
test('parallel domain limit is eight and internal domains skipped', async () => {
  let active = 0, peak = 0, calls = 0;
  const resolver = dns(async () => { calls++; peak = Math.max(peak, ++active); await new Promise(r => setTimeout(r, 5)); active--; return [{}]; });
  const domains = Array.from({ length: 19 }, (_, i) => `x${i}.com`);
  const result = await checkDomains([...domains, ...domains, 'orgiast.jp', 'x.orgiast.jp'], { resolver, cachePath: null });
  assert.equal(result.ok.length, 19); assert.equal(calls, 19); assert.equal(peak, 8);
});
