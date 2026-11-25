import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fetchMailTargets, TARGET_CACHE_MS, TARGET_FETCH_RETRIES, TARGET_FETCH_DELAY_MS, TARGET_FETCH_TIMEOUT_MS } from './fleet-mail-targets.mjs';
import { main, resolveMailTarget, createClient, COMMAND_LOCK_RETRIES, COMMAND_LOCK_DELAY_MS } from './fleet-mail.mjs';
import { buildFleetStatus } from './fleet-status.mjs';

const label = 'DESKTOP-BDOAK99';
const at = '2026-10-29T12:42:00.000Z';
const now = () => Date.parse(at);
const live = { ok: true, beacons: [{ label, hostname: 'new-host', pollAt: at }], serverPolls: { [label]: at } };
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-targets-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, '.claude'));
  const env = path.join(home, '.claude', 'fleet-sheet.env');
  fs.writeFileSync(env, 'FLEET_SHEET_URL=https://example.invalid\nFLEET_SHEET_TOKEN=private-token\n');
  const file = path.join(home, '.claude', 'fleet-mail-targets.json');
  const delays = [];
  const opts = { home, now, sleepImpl: async ms => delays.push(ms) };
  return { home, env, file, delays, opts };
}
const resolve = result => resolveMailTarget(label, {}, result.beacons, result.serverPolls);

test('failed/throwing lookups retry and a successful snapshot survives a new invocation', async t => {
  const f = fixture(t); let calls = 0;
  const first = await fetchMailTargets({ ...f.opts, fetchBeacons: async ({ home, timeoutMs }) => {
    assert.equal(home, f.home);
    assert.equal(timeoutMs, TARGET_FETCH_TIMEOUT_MS);
    assert.ok(timeoutMs > 20_000);
    calls++;
    if (calls === 1) throw new Error('timeout');
    return calls === 2 ? { ok: false, reason: 'HTTP 503' } : live;
  } });
  assert.equal(first.ok, true);
  assert.deepEqual(f.delays, Array(TARGET_FETCH_RETRIES).fill(TARGET_FETCH_DELAY_MS));
  assert.equal(calls, TARGET_FETCH_RETRIES + 1);
  const stored = fs.readFileSync(f.file, 'utf8');
  assert.ok(!stored.includes('private-token') && !stored.includes('example.invalid'));
  assert.equal(JSON.parse(stored).beacons[0].pollAt, undefined);
  const cached = await fetchMailTargets({ ...f.opts, fetchBeacons: async () => { throw new Error('offline'); } });
  assert.equal(resolve(cached).to, label);
  assert.equal(cached.cached, true);
  assert.equal(cached.ok, false); // Cached identities do not establish current liveness.
  assert.equal(cached.reason, 'offline');
  assert.equal(resolveMailTarget('new-host', {}, cached.beacons).to, label);
});

test('empty snapshots retry and neither overwrite nor renew the useful cache', async t => {
  const f = fixture(t);
  await fetchMailTargets({ ...f.opts, fetchBeacons: async () => live });
  const before = fs.readFileSync(f.file, 'utf8'); let calls = 0;
  const result = await fetchMailTargets({ ...f.opts, now: () => now() + 1000, fetchBeacons: async () => { calls++; return { ok: true, beacons: [], serverPolls: {} }; } });
  assert.equal(resolve(result).resolved, true);
  assert.equal(result.cached, true);
  assert.equal(result.ok, false);
  assert.equal(calls, TARGET_FETCH_RETRIES + 1);
  assert.equal(fs.readFileSync(f.file, 'utf8'), before);
});

for (const mode of ['expired', 'future', 'corrupt', 'different fleet']) {
  test(`cache is ignored when ${mode}`, async t => {
    const f = fixture(t);
    await fetchMailTargets({ ...f.opts, fetchBeacons: async () => live });
    if (mode === 'corrupt') fs.writeFileSync(f.file, '{broken');
    if (mode === 'different fleet') fs.appendFileSync(f.env, 'FLEET_SHEET_TOKEN=changed\n');
    const result = await fetchMailTargets({ ...f.opts,
      now: () => now() + (mode === 'expired' ? TARGET_CACHE_MS : mode === 'future' ? -1 : 0),
      fetchBeacons: async () => ({ ok: false, reason: 'HTTP 500' }) });
    assert.equal(resolve(result).resolved, false);
    assert.equal(result.cached, undefined);
  });
}

test('poll-only identities resolve, populate fleet status and can be cached', async t => {
  const f = fixture(t);
  const result = await fetchMailTargets({ ...f.opts, fetchBeacons: async () => ({ ok: true, beacons: [], serverPolls: { [label]: at, invalid: 'bad' } }) });
  assert.equal(resolve(result).resolved, true);
  assert.equal(resolveMailTarget('invalid', {}, [], result.serverPolls).resolved, false);
  assert.equal(resolveMailTarget('DESKTOP-BDO', {}, [], result.serverPolls).resolved, false);
  const rows = buildFleetStatus({ pcMap: {}, ...result, now: now() });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].label, label);
  assert.equal(rows[0].hasBeacon, false);
  assert.equal(rows[0].pollSource, 'server');
  const cached = await fetchMailTargets({ ...f.opts, fetchBeacons: async () => ({ ok: false }) });
  assert.equal(resolve(cached).resolved, true);
});

test('a corrupt or unwritable cache does not break successful resolution', async t => {
  const f = fixture(t);
  fs.mkdirSync(f.file); // rename cannot replace a directory, including on Windows.
  const result = await fetchMailTargets({ ...f.opts, fetchBeacons: async () => live });
  assert.equal(resolve(result).resolved, true);
  assert.equal(result.ok, true);
  assert.ok(!fs.readdirSync(path.dirname(f.file)).some(name => name.endsWith('.tmp')));
});

function cli(f, fetchBeacons, to = label) {
  const errors = [], output = [];
  const body = path.join(f.home, 'body.txt'); fs.writeFileSync(body, 'resolution test');
  const args = ['--send', '--dry-run', '--to', to, '--kind', 'note', '--body-file', body, '--why', 'test'];
  const deps = { home: f.home, now, pcMap: {}, fetchBeacons, sleep: f.opts.sleepImpl, identity: { hostname: 'kim-PC' },
    stderr: line => errors.push(line), stdout: line => output.push(line), request: async () => assert.fail('must not send') };
  return { args, deps, errors, output };
}

test('CLI shares a poll-only snapshot with delivery guard and freshness without sending', async t => {
  const f = fixture(t); let calls = 0;
  const c = cli(f, async () => { calls++; return { ok: true, beacons: [], serverPolls: { [label]: at } }; });
  assert.equal(await main(c.args, c.deps), 0);
  assert.equal(calls, 1);
  assert.equal(JSON.parse(c.output[0]).to, label);
  assert.match(c.errors.join('\n'), /最終poll .*0m前/);
});

test('CLI resolves cached target on failure but reports unknown freshness', async t => {
  const f = fixture(t);
  await fetchMailTargets({ ...f.opts, fetchBeacons: async () => live });
  const c = cli(f, async () => ({ ok: false, reason: 'HTTP 503' }));
  assert.equal(await main(c.args, c.deps), 0);
  assert.equal(JSON.parse(c.output[0]).to, label);
  assert.match(c.errors.join('\n'), /宛先キャッシュ/);
  assert.match(c.errors.join('\n'), /最終 poll 不明/);
  assert.ok(!c.errors.join('\n').includes('最終poll '));
});

test('CLI distinguishes acquisition failure from absence in a successfully fetched directory', async t => {
  const f = fixture(t);
  for (const [response, expected] of [
    [{ ok: false, reason: 'HTTP 503' }, /beacons 取得失敗.*HTTP 503/],
    [live, /取得済み.*該当なし/]
  ]) {
    const c = cli(f, async () => response, 'nonexistent');
    assert.equal(await main(c.args, c.deps), 4);
    assert.match(c.errors.join('\n'), expected);
    assert.equal(c.output.length, 0);
  }
});

test('offline dry-run can use cache without fetching or renewing it', async t => {
  const f = fixture(t);
  await fetchMailTargets({ ...f.opts, fetchBeacons: async () => live });
  const before = fs.readFileSync(f.file, 'utf8');
  const c = cli(f, undefined);
  assert.equal(await main(c.args, c.deps), 0);
  assert.equal(JSON.parse(c.output[0]).to, label);
  assert.equal(fs.readFileSync(f.file, 'utf8'), before);
});

test('mail-send retries only explicit busy using command lock constants and the same id', async () => {
  const calls = [], delays = [];
  const request = createClient({ url: 'https://example.invalid', token: 'x', sleepImpl: async ms => delays.push(ms),
    fetchImpl: async (_url, options) => {
      calls.push(JSON.parse(options.body));
      return { ok: true, json: async () => calls.length <= COMMAND_LOCK_RETRIES ? { ok: false, error: 'busy' } : { ok: true, mail: { id: 'mail-test' } } };
    } });
  assert.equal((await request('mail-send', { id: 'mail-test', to: label })).ok, true);
  assert.equal(calls.length, COMMAND_LOCK_RETRIES + 1);
  assert.deepEqual(delays, Array(COMMAND_LOCK_RETRIES).fill(COMMAND_LOCK_DELAY_MS));
  assert.ok(calls.every(call => call.id === 'mail-test' && call.to === label));
  let attempts = 0;
  const timeout = createClient({ url: 'https://example.invalid', token: 'x', fetchImpl: async () => { attempts++; throw new Error('timeout'); } });
  await assert.rejects(timeout('mail-send', { id: 'mail-test' }), /timeout/);
  assert.equal(attempts, 1); // Unknown write outcome must not be blindly replayed.
});
