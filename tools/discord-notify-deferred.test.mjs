import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { deferredPath, readDeferred, drainDeferred, appendDeferred, formatDeferredSection } from './discord-notify-deferred.mjs';
import { run } from './auto-progress-digest.mjs';

const homes = [];
const tmp = () => { const home = fs.mkdtempSync(path.join(os.tmpdir(), 'deferred-')); homes.push(home); fs.mkdirSync(path.join(home, '.claude'), { recursive: true }); return home; };
const write = (home, rows) => fs.writeFileSync(deferredPath(home), rows.map(row => typeof row === 'string' ? row : JSON.stringify(row)).join('\n') + '\n');
after(() => { for (const home of homes) fs.rmSync(home, { recursive: true, force: true }); });

test('readDeferred filters invalid and stale lines while preserving order', () => {
  const home = tmp(), now = Date.parse('2026-10-21T00:00:00Z');
  write(home, [{ at: now - 2000, text: 'first' }, '{broken', { at: now - 8 * 86400000, text: 'old' }, { at: now - 1000, text: 'second' }]);
  assert.deepEqual(readDeferred(home, { now }), [{ at: now - 2000, text: 'first' }, { at: now - 1000, text: 'second' }]);
});

test('drainDeferred consumes atomically and handles a missing file', () => {
  const home = tmp(), now = Date.now();
  write(home, [{ at: now - 2, text: 'a' }, { at: now - 1, text: 'b' }]);
  assert.deepEqual(drainDeferred(home, { now }), { entries: [{ at: now - 2, text: 'a' }, { at: now - 1, text: 'b' }], dropped: 0 });
  assert.deepEqual(readDeferred(home), []);
  assert.equal(fs.readdirSync(path.join(home, '.claude')).some(name => name.includes('.draining-')), false);
  assert.deepEqual(drainDeferred(home), { entries: [], dropped: 0 });
});

test('formatDeferredSection limits count and length and flattens bodies', () => {
  const now = Date.parse('2026-10-21T00:00:00Z');
  assert.equal(formatDeferredSection([]), '');
  const seven = Array.from({ length: 7 }, (_, i) => ({ at: now + i, text: `item-${i}` }));
  const result = formatDeferredSection(seven, { now });
  assert.match(result, /item-6/); assert.doesNotMatch(result, /item-1/); assert.match(result, /…他2件/);
  const long = formatDeferredSection([{ at: now, text: 'x'.repeat(1000) }], { now, maxChars: 80 });
  assert.ok(long.length <= 80); assert.match(long, /…$/);
  assert.match(formatDeferredSection([{ at: now, text: 'one\ntwo\r\nthree' }], { now }), /one two three/);
});

test('digest sends deferred entries without ledger rows and dry-run does not consume them', async () => {
  const now = Date.parse('2026-10-21T00:00:00Z');
  const home = tmp(); write(home, [{ at: now - 2, text: 'alpha' }, { at: now - 1, text: 'beta' }]);
  let sent = '';
  const result = await run({ home, now, dryRun: false, io: { localOwner: 'kim', readLedger: () => [], notify: async message => { sent = message; return { delivered: 'dm' }; } } });
  assert.equal(result.sent, true); assert.equal(result.deferred, 2); assert.match(sent, /【通知が混んでいて保留していたもの】/); assert.match(sent, /alpha/); assert.match(sent, /beta/); assert.deepEqual(readDeferred(home), []);

  write(home, [{ at: now, text: 'keep' }]);
  const preview = await run({ home, now: now + 1, dryRun: true, io: { localOwner: 'kim', readLedger: () => [] } });
  assert.equal(preview.deferred, 1); assert.equal(readDeferred(home, { now: now + 1 }).length, 1);
});

test('appendDeferred restores entries and a failed delivery re-queues them', async () => {
  const now = Date.parse('2026-10-21T00:00:00Z');
  const home = tmp(); write(home, [{ at: now - 1, text: 'not-lost' }]);
  const failed = await run({ home, now, dryRun: false, io: { localOwner: 'kim', readLedger: () => [], notify: async () => ({ delivered: 'none', reason: 'boom' }) } });
  assert.equal(failed.sent, false);
  assert.deepEqual(readDeferred(home, { now }), [{ at: now - 1, text: 'not-lost' }]);
  assert.equal(appendDeferred(home, [{ at: now, text: 'extra' }, null]), 1);
  assert.equal(readDeferred(home, { now }).length, 2);
});
