import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { summarizeLedger, summarizeAsks, readWatches } from '../lib/watches.mjs';

const now = Date.parse('2026-11-13T08:00:00Z');
const row = { sessionId: '4ee33e10', check: ['node', 'check.mjs'], label: '東邦2階HP 使用量把握', status: 'open', ts: '2026-11-12T00:00:00Z', deadlineAt: '2026-11-15T00:00:00Z' };
test('reads all ledger rows, keeps distinct labels and latest verdict, closes completed watches', () => {
  const result = summarizeLedger([row, ...Array.from({ length: 101 }, (_, i) => ({ sessionId: `old-${i}`, status: 'done', ts: '2026-01-01' })),
    { ...row, label: '別の見張り', verdict: 'unmet', lastCheckedAt: '2026-11-13T07:00:00Z', lastCheckOutput: '未達' },
    { ...row, status: 'done', verdict: 'done', ts: '2026-11-13T07:00:00Z' }], now);
  assert.equal(result.watches.length, 1);
  assert.equal(result.watches[0].label, '別の見張り');
  assert.equal(result.watches[0].detail, '未達');
  assert.equal(result.watches[0].deadline, row.deadlineAt);
  assert.equal(result.recentCompleted[0].label, row.label);
});
test('superseded, closed, answered and seen asks do not reappear', () => {
  assert.equal(summarizeLedger([row, { ...row, status: 'superseded' }], now).watches.length, 0);
  const ask = { id: 'a', kind: 'ask', status: 'open', text: '確認', createdAt: '2026-11-13' };
  assert.deepEqual(summarizeAsks([ask, { ...ask, id: 'b', kind: 'info' }, { ...ask, id: 'c', answeredAt: '2026-11-13' }, { ...ask, id: 'd', status: 'answered' }]).map(x => x.id), ['a']);
});
test('actual JSON inbox format, malformed ledger lines and missing data are visible', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'secretary-watches-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const dir = path.join(home, '.claude');
  await fs.mkdir(path.join(dir, 'kim-inbox'), { recursive: true });
  await fs.writeFile(path.join(dir, 'auto-progress-ledger.jsonl'), `${JSON.stringify(row)}\ninvalid\n`);
  await fs.writeFile(path.join(dir, 'kim-inbox', 'ki-20261113080000-abcd.json'), JSON.stringify({ id: 'ask', kind: 'ask', status: 'open', text: '判断をお願いします' }));
  const result = await readWatches(home, now);
  assert.equal(result.watches[0].label, row.label);
  assert.equal(result.inboxAsks[0].text, '判断をお願いします');
  assert.equal(result.warnings.length, 1);
  assert.equal((await readWatches(path.join(home, 'missing'), now)).warnings.length, 2);
});
