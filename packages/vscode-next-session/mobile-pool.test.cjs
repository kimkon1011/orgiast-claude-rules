const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPool, createOwnershipLease, readConfig, readSnapshot } = require('./mobile-pool');

test('concurrent refill opens one; first prompt title change replenishes one', async () => {
  const tabs = [];
  let opens = 0;
  const states = [];
  const pool = createPool({ tabs: () => tabs, publish: (...args) => states.push(args), async open() {
    opens++;
    await new Promise((resolve) => setImmediate(resolve));
    tabs.push({ label: 'Claude Code' }); return true;
  } });
  await Promise.all([pool.ensure(1), pool.ensure(1), pool.ensure(1)]);
  assert.equal(opens, 1);
  tabs[0].label = '実際の仕事';
  await pool.ensure(1);
  assert.equal(opens, 2);
  await pool.ensure(1);
  assert.equal(opens, 2);
  assert.deepEqual(states.at(-1), [1, 1]);
});
test('excess tabs and used tabs are preserved; failure does not spawn in a loop', async () => {
  const tabs = [{ label: 'Claude Code' }, { label: 'Claude Code' }];
  let opens = 0;
  const pool = createPool({ tabs: () => tabs, publish() {}, async open() { opens++; return false; } });
  await pool.ensure(1);
  assert.equal(opens, 0);
  tabs.length = 0;
  await pool.ensure(1);
  assert.equal(opens, 1);
});
test('unacknowledged creation stops; non-owner never opens', async () => {
  let opens = 0;
  for (const owner of [false, true]) {
    const pool = createPool({ tabs: () => [], own: async () => owner, publish() {}, async open() { opens++; return true; } });
    await pool.ensure(3);
    assert.equal(opens, owner ? 1 : 0);
  }
});
test('socket ownership serializes windows and releases on close', async (t) => {
  const first = createOwnershipLease(0);
  t.after(() => first.release());
  assert.equal(await first.acquire(), true);
  const other = createOwnershipLease(first.port());
  t.after(() => other.release());
  assert.equal(await other.acquire(), false);
  first.release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await other.acquire(), true);
});
test('JSON/env configuration and stale snapshot are validated', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-config-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, '.claude'));
  assert.equal(readConfig(home, {}), 1);
  fs.writeFileSync(path.join(home, '.claude', 'mobile-sessions.json'), '{"count":2}');
  assert.equal(readConfig(home, {}), 2);
  assert.equal(readConfig(home, { CLAUDE_MOBILE_STANDBY: '3' }), 3);
  assert.throws(() => readConfig(home, { CLAUDE_MOBILE_STANDBY: '1junk' }));
  const file = path.join(home, '.claude', 'mobile-sessions-state.json');
  fs.writeFileSync(file, '{"waiting":1,"updatedAt":1000}');
  assert.equal(readSnapshot(home, 1001).waiting, 1);
  assert.equal(readSnapshot(home, 32000), null);
});
