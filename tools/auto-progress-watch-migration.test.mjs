import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { progressHome } from './test-helpers/auto-progress-home.mjs';
import { ledgerFile, writeLedger, readLedger, rowKey, OPEN_STATUSES } from './auto-progress-ledger.mjs';
import { legacyAddCheckMigrationRows, timeOnlyMigrationRows, migrationClobberRestorationRows, restoreMigrationClobbers, legacyAddCheckReservation, timeOnlyReservation } from './auto-progress-watch.mjs';
const now = Date.parse('2026-11-06T00:00:00Z');
const source = { pc: 'pc', user: 'user', sessionId: 'a644b252-test', ts: '2026-10-30T12:26:00Z', status: 'done', check: 'node check.mjs', nextClaude: 'continue', label: 'old' };
const live = { ...source, ts: '2026-11-02T06:29:00Z', status: 'open', label: 'R640 部品の自動入札4件', deadlineAt: '2026-11-05T00:00:00Z' };
test('both migrations only consider latest session row, including terminal successors and timestamp ties', () => {
  for (const [select, old] of [[legacyAddCheckMigrationRows, source], [timeOnlyMigrationRows, { ...source, check: 'node -e "process.exit(Date.now() >= Date.parse(\'2026-11-05T00:00:00Z\') ? 0 : 1)"' }]]) {
    assert.deepEqual(select([old]), [old]);
    for (const status of ['open', 'done', 'dropped']) assert.ok(!select([old, { ...live, status }]).includes(old));
    assert.deepEqual(select([live, old]), []);
    assert.deepEqual(select([old, { ...live, ts: old.ts }]), []);
    for (const field of ['pc', 'user', 'sessionId']) assert.deepEqual(select([old, { ...live, [field]: 'another' }]), [old]);
  }
});
test('restores once, preserves every open status, extends expired deadline, and emits one info', async t => {
  for (const status of OPEN_STATUSES) {
    const home = progressHome('migration-restore-');
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    const overwritten = { ...live, status: 'superseded', supersededFromStatus: status };
    const migrated = legacyAddCheckReservation(source, now - 3600000);
    const repaired = { ...source, ts: new Date(now - 1000).toISOString(), repairedFromLegacyReopen: true };
    writeLedger(ledgerFile(home), [source, overwritten, migrated, repaired]);
    const messages = [], io = { addKimInboxItem: async (_home, item) => messages.push(item) };
    const before = fs.readFileSync(ledgerFile(home), 'utf8');
    assert.equal((await restoreMigrationClobbers({ home, now, dryRun: true, io })).targets.length, 1);
    assert.equal(fs.readFileSync(ledgerFile(home), 'utf8'), before);
    assert.equal(messages.length, 0);
    assert.equal((await restoreMigrationClobbers({ home, now, io })).appended, 1);
    const restored = readLedger(ledgerFile(home)).at(-1);
    assert.equal(restored.status, status);
    assert.equal(restored.check, live.check);
    assert.equal(restored.restoredFromMigrationClobber, rowKey(live));
    assert.equal(restored.deadlineAt, new Date(now + 86400000).toISOString());
    assert.ok(restored.restoredFromMigrationClobberAt);
    assert.equal((await restoreMigrationClobbers({ home, now: now + 1, io })).appended, 0);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].source, 'auto-progress-migration-clobber-restore');
    assert.match(messages[0].text, /a644b252 R640 部品の自動入札4件/);
  }
});
test('legacy superseded fallback, time-only migration, and legitimate successors', () => {
  for (const reserve of [legacyAddCheckReservation, timeOnlyReservation]) {
    const migrated = reserve(source, now - 1000);
    const rows = [source, { ...live, status: 'superseded' }, migrated];
    assert.equal(migrationClobberRestorationRows(rows)[0].status, 'open');
    for (const status of ['open', 'done', 'superseded']) assert.deepEqual(migrationClobberRestorationRows([...rows, { ...live, ts: new Date(now).toISOString(), status }]), []);
    assert.deepEqual(migrationClobberRestorationRows([source, { ...live, status: 'done' }, migrated]), []);
    assert.deepEqual(migrationClobberRestorationRows([{ ...live, status: 'superseded' }, migrated]), []);
    assert.deepEqual(migrationClobberRestorationRows([source, { ...live, ts: '2026-10-29T00:00:00Z' }, migrated]), []);
  }
});

test('repair-only rows can identify an unambiguous original, but never guess an ambiguous one', () => {
  const repaired = { ...source, ts: new Date(now).toISOString(), repairedFromLegacyReopen: true };
  const overwritten = { ...live, status: 'superseded' };
  assert.equal(migrationClobberRestorationRows([source, overwritten, repaired]).length, 1);
  assert.deepEqual(migrationClobberRestorationRows([source, { ...source, ts: '2026-10-31T00:00:00Z' }, overwritten, repaired]), []);
});
test('future deadline is unchanged and failed ledger write never notifies', async t => {
  const home = progressHome('migration-deadline-');
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const future = new Date(now + 48 * 3600000).toISOString();
  writeLedger(ledgerFile(home), [source, { ...live, deadlineAt: future }, legacyAddCheckReservation(source, now - 1)]);
  await assert.rejects(restoreMigrationClobbers({ home, now, io: {
    writeLedger: () => { throw new Error('disk full'); }, addKimInboxItem: () => assert.fail('must not notify'),
  } }), /disk full/);
  await restoreMigrationClobbers({ home, now, io: { addKimInboxItem: async () => {} } });
  assert.equal(readLedger(ledgerFile(home)).at(-1).deadlineAt, future);
});
