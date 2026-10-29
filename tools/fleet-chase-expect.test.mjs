import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerExpectation, checkExpectations, classifyExpectation } from './lib/fleet-chase-expect.mjs';
import { HOUR, iso, loadLedger, saveJson, ledgerPath, parseArgs, runChase, control } from './fleet-chase.mjs';
import { selectContext } from './fleet-chase-context.mjs';
import { digest } from './lib/fleet-chase-actions.mjs';
import { buildBeacon, fetchBeacons } from './fleet-beacon.mjs';
import { buildFleetStatus, formatFleetTable } from './fleet-status.mjs';
const NOW = Date.parse('2026-10-29T00:00:00Z');
const options = { '--expect': 'selfcheck-008', '--match-why': '作業用008 引継ぎ自己点検', '--from': 'any', '--until': '+2h', '--reason': '結果待ち' };
const mail = (extra = {}) => ({ id: 'mail-report', from: 'unknown-PC', to: 'kim-PC', kind: 'note', why: options['--match-why'], createdAt: iso(NOW), ...extra });
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'expect-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, '.claude', 'fleet-inbox'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'cost-reporter.env'), 'REPORTER_LABEL=kim-PC\n');
  const ledger = { version: 1, items: {} };
  const item = registerExpectation(ledger, options, NOW);
  const sent = [];
  const health = { ok: true, capabilities: ['mail-trace-v1'], beacons: [{ label: 'unknown-PC', account: 'seisaku-team@orgiast.jp', reportedAt: iso(NOW), failing: [], pollAt: iso(NOW - HOUR) }], serverPolls: {} };
  const ctx = { home, now: NOW + 2 * HOUR, pcMap: { 'kim-PC': { hostname: 'KIMHOST' } }, fetchBeacons: async () => health,
    persist: () => saveJson(ledgerPath(home), ledger), request: async (kind, payload) => {
      if (kind === 'mail-trace') return { ok: true, mails: [] };
      if (kind === 'mail-get') return { ok: true, mail: { status: 'new' } };
      if (kind === 'mail-send') { sent.push(payload); return { ok: true }; }
      throw new Error(kind);
    } };
  return { home, ledger, item, ctx, health, sent };
}
test('CLI requires expectation fields, rejects mixed controls and supports relative minutes/hours/days', t => {
  const f = fixture(t);
  assert.deepEqual(parseArgs(Object.entries(options).flat()), options);
  for (const args of [['--expect', 'x'], ['--from', 'any'], ['--expect', 'x', '--chase'], ['--expect', 'x', '--cancel', 'y']]) assert.throws(() => parseArgs(args));
  assert.throws(() => registerExpectation(f.ledger, options, NOW), /already exists/);
  for (const until of ['+1m', '+2h', '+3d']) control(f.ledger, 'defer', f.item.id, { until, now: NOW, reason: 'wait' });
  assert.throws(() => registerExpectation({ items: {} }, { ...options, '--until': '+0h' }, NOW));
});
for (const source of ['inbox', 'received-log']) test(`matching ${source} completes without sending; old/wrong sender/wrong destination cannot complete`, async t => {
  const f = fixture(t);
  f.item.from = 'unknown-PC';
  const records = [mail({ id: 'mail-old', createdAt: iso(NOW - 24 * HOUR) }), mail({ id: 'mail-other', from: 'other-PC' }), mail({ id: 'mail-wrong', to: 'other-PC' })];
  const write = rows => {
    if (source === 'inbox') for (const m of rows) saveJson(path.join(f.home, '.claude', 'fleet-inbox', `${m.id}.json`), m);
    else fs.writeFileSync(path.join(f.home, '.claude', 'fleet-mail-received.jsonl'), rows.map(m => JSON.stringify(m)).join('\n'));
  };
  write(records); await checkExpectations(f.ledger, f.ctx); assert.notEqual(f.item.status, 'done');
  write([...records, mail()]); await checkExpectations(f.ledger, f.ctx, { repair: true });
  assert.equal(f.item.status, 'done'); assert.equal(f.item.evidence.mailId, 'mail-report'); assert.equal(f.sent.length, 0);
});
for (const cause of ['未着手', '送信失敗', '配布未収束', '宛先誤り', 'その他']) test(`overdue classification: ${cause}`, async t => {
  const f = fixture(t);
  if (cause !== '未着手') f.health.beacons[0].pollAt = iso(NOW + HOUR);
  if (cause === '配布未収束') f.health.beacons[0].failing = ['task:fleet-mail'];
  const trace = { ok: true, mails: cause === '送信失敗' ? [mail({ status: 'failed', failReason: 'delivery failed' })] : cause === '宛先誤り' ? [mail({ to: 'wrong-PC' })] : [] };
  const request = f.ctx.request;
  f.ctx.request = (kind, payload) => kind === 'mail-trace' ? trace : request(kind, payload);
  await checkExpectations(f.ledger, f.ctx, { repair: true });
  assert.equal(f.item.diagnosis.cause, cause);
  assert.equal(f.sent.length, ['未着手', '送信失敗', '配布未収束'].includes(cause) ? 1 : 0);
  if (f.sent.length) { assert.equal(f.sent[0].messageKind, 'prompt'); assert.match(f.sent[0].body, /kim-PC/); }
});
test('two unsuccessful repairs remain debt with route results; late arrival still completes', async t => {
  const f = fixture(t);
  await checkExpectations(f.ledger, f.ctx, { repair: true });
  await checkExpectations(f.ledger, f.ctx, { repair: true }); assert.equal(f.sent.length, 1);
  f.ctx.now += HOUR; await checkExpectations(f.ledger, f.ctx, { repair: true }); assert.equal(f.sent.length, 2);
  f.ctx.now += HOUR; await checkExpectations(f.ledger, f.ctx, { repair: true });
  assert.equal(f.item.status, 'blocked'); assert.equal(f.item.repairs.length, 2); assert.equal(f.sent.length, 2);
  assert.match(f.item.humanReason, /2回.*poll/);
  const context = selectContext(f.ledger, { home: f.home, now: f.ctx.now });
  assert.match(context, /受信待ち selfcheck-008/); assert.match(context, /prompt=new/); assert.match(context, /登録候補/);
  saveJson(path.join(f.home, '.claude', 'fleet-inbox', 'mail-report.json'), mail());
  await checkExpectations(f.ledger, f.ctx, { repair: true }); assert.equal(f.item.status, 'done');
  assert.match(selectContext(f.ledger, { home: f.home, now: f.ctx.now }), /受信証拠=mail-report/);
});
test('ambiguous transport failure persists and reuses IDs across reload; retries are bounded', async t => {
  const f = fixture(t); const ids = [];
  const original = f.ctx.request;
  f.ctx.request = async (kind, payload) => {
    if (kind === 'mail-send') { ids.push(payload.id); throw new Error('response lost'); }
    return original(kind, payload);
  };
  await checkExpectations(f.ledger, f.ctx, { repair: true });
  const stored = loadLedger(f.home); assert.equal(stored.items[f.item.id].pendingRepair.routes[0].payload.id, ids[0]);
  for (let i = 0; i < 5; i++) { f.ctx.now += HOUR; await checkExpectations(f.ledger, f.ctx, { repair: true }); }
  assert.equal(ids.length, 4); assert.equal(ids[0], ids[1]); assert.equal(ids[2], ids[3]); assert.notEqual(ids[0], ids[2]);
  assert.equal(f.item.status, 'blocked');
});
test('unknown backend is not evidence of no poll; transient failure can recover', async t => {
  const f = fixture(t);
  f.ctx.fetchBeacons = async () => ({ ok: false });
  const original = f.ctx.request;
  f.ctx.request = async () => ({ ok: true, action: 'updated' });
  await checkExpectations(f.ledger, f.ctx, { repair: true });
  assert.equal(f.item.diagnosis.cause, 'その他'); assert.equal(f.item.status, 'blocked'); assert.equal(f.sent.length, 0);
  f.ctx.now += HOUR; f.ctx.request = original; f.ctx.fetchBeacons = async () => f.health;
  await checkExpectations(f.ledger, f.ctx, { repair: true }); assert.equal(f.sent.length, 1);
});
test('any investigates unregistered PCs only; aliases are not mistaken for unregistered machines', t => {
  const f = fixture(t);
  f.health.beacons.push({ label: 'KIMHOST', failing: [], pollAt: '' });
  const d = classifyExpectation(f.item, { health: f.health, trace: { ok: true, mails: [] }, pcMap: f.ctx.pcMap, now: f.ctx.now });
  assert.deepEqual(d.targets.map(r => r.label), ['unknown-PC']);
});
test('future deadline, defer, cancellation and dry-run never send; read-only status does not poll', async t => {
  const f = fixture(t);
  f.ctx.now = NOW; await checkExpectations(f.ledger, f.ctx, { repair: true }); assert.equal(f.item.diagnosis, undefined);
  f.ctx.now += 3 * HOUR; f.item.deferredUntil = iso(f.ctx.now + HOUR);
  await checkExpectations(f.ledger, f.ctx, { repair: true }); assert.equal(f.item.diagnosis, undefined);
  f.item.deferredUntil = null; f.ctx.dryRun = true;
  const before = fs.readdirSync(path.join(f.home, '.claude'));
  await checkExpectations(f.ledger, { ...f.ctx, persist: () => assert.fail('dry-run write') }, { repair: true });
  assert.equal(f.sent.length, 0); assert.deepEqual(fs.readdirSync(path.join(f.home, '.claude')), before);
  f.ctx.persist();
  const result = await runChase({ '--status': true }, { home: f.home, fetchBeacons: () => assert.fail('status network') });
  assert.equal(result.counts.expect, 1);
  control(f.ledger, 'cancel', f.item.id, { now: NOW, reason: 'test cleanup' });
  await checkExpectations(f.ledger, f.ctx, { repair: true }); assert.equal(f.sent.length, 0);
});
test('CLI registration persists, check then chase repairs, and expectation-only digest never sends Discord', async t => {
  const f = fixture(t);
  await runChase(options, { home: f.home, now: () => NOW });
  assert.equal(loadLedger(f.home).items['expect-selfcheck-008'].status, 'waiting');
  const deps = { ...f.ctx, now: () => NOW + 2 * HOUR, collectRollout: async () => null };
  await runChase({ '--chase': true }, deps);
  assert.equal(loadLedger(f.home).items['expect-selfcheck-008'].repairs.length, 1);
  await digest(f.ledger, { home: f.home, now: NOW, notify: () => assert.fail('Discord prohibited') });
});
test('beacon only extracts self-reported email, label, hostname, never credentials; candidates do not guess PC numbers', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'seisaku-team@orgiast.jp', accessToken: 'secret-access', refreshToken: 'secret-refresh' }, apiKey: 'secret-key' }));
  const beacon = buildBeacon({ home: f.home, identity: { hostname: 'DESKTOP-UNKNOWN', gitEmail: 'unrelated@other.jp' }, label: 'unknown-PC' });
  assert.equal(beacon.account, 'seisaku-team@orgiast.jp'); assert.equal(beacon.reporterLabel, 'kim-PC'); assert.equal(beacon.hostname, 'DESKTOP-UNKNOWN');
  assert.doesNotMatch(JSON.stringify(beacon), /secret-|accessToken|refreshToken|apiKey/);
  fs.writeFileSync(path.join(f.home, '.claude', 'fleet-sheet.env'), 'FLEET_SHEET_URL=https://example.invalid\nFLEET_SHEET_TOKEN=transport-only\n');
  const result = await fetchBeacons({ home: f.home, fetchImpl: async () => ({ ok: true, json: async () => ({ ok: true, beacons: [beacon] }) }) });
  assert.equal(result.beacons[0].hostname, 'DESKTOP-UNKNOWN');
  const table = formatFleetTable(buildFleetStatus({ pcMap: {}, ...result }));
  assert.match(table, /登録候補/); assert.match(table, /seisaku-team@orgiast.jp/); assert.doesNotMatch(table, /作業用008/);
});


test('older GAS without advertised trace capability is never probed with an unknown action', async t => {
  const f = fixture(t); delete f.health.capabilities;
  const original = f.ctx.request;
  f.ctx.request = (kind, payload) => { assert.notEqual(kind, 'mail-trace'); return original(kind, payload); };
  await checkExpectations(f.ledger, f.ctx);
  assert.match(f.item.diagnosis.errors.join(' '), /サーバ未対応/);
});


test('configuration/hook failures count as unconverged; poll repair does not change consent', async t => {
  const f = fixture(t); f.health.beacons[0].failing = ['settings:outbound-claim-evidence-gate'];
  await checkExpectations(f.ledger, f.ctx, { repair: true });
  assert.equal(f.item.diagnosis.cause, '配布未収束'); assert.match(f.sent[0].body, /setup\.mjs --converge/);
  assert.match(f.sent[0].body, /オプトイン変更/);
});
