import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { aggregate } from './makimono-impact.mjs';
import { appendUsage } from './makimono-search.mjs';

const NOW = new Date('2026-09-10T12:00:00.000Z');

function tempHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'makimono-impact-test-'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  return home;
}

function withHome(home, fn) {
  const original = process.env.ORGIAST_HOME;
  process.env.ORGIAST_HOME = home;
  try { return fn(); } finally { if (original === undefined) delete process.env.ORGIAST_HOME; else process.env.ORGIAST_HOME = original; fs.rmSync(home, { recursive: true, force: true }); }
}

test('7日窓は境界を含み、窓内と総数を正しく集計する', () => withHome(tempHome(), () => {
  const dir = path.join(process.env.ORGIAST_HOME, '.claude');
  fs.writeFileSync(path.join(dir, '.makimono-gate-state.json'), JSON.stringify({
    a: { at: '2026-09-03T12:00:00.000Z', count: 3, slugs: ['alpha'] },
    b: { at: '2026-09-03T11:59:59.999Z', count: 5, slugs: ['old'] },
    c: { at: '2026-09-10T11:00:00.000Z', count: 2, slugs: ['beta'] },
  }));
  const rows = [
    { t: 'read', slug: 'alpha', chars: 10, at: '2026-09-03T12:00:00.000Z' },
    { t: 'read', slug: 'alpha', chars: 20, at: '2026-09-09T12:00:00.000Z' },
    { t: 'read', slug: 'beta', chars: 30, at: '2026-09-10T12:00:00.000Z' },
    { t: 'read', slug: 'old', chars: 40, at: '2026-09-03T11:59:59.999Z' },
    { t: 'report', slug: 'alpha', saved: 100, at: '2026-09-03T12:00:00.000Z' },
    { t: 'report', slug: 'beta', saved: 250, at: '2026-09-10T11:00:00.000Z' },
    { t: 'report', slug: 'old', saved: 999, at: '2026-09-03T11:59:59.999Z' },
  ];
  fs.writeFileSync(path.join(dir, 'makimono-usage-ledger.jsonl'), `${rows.map(JSON.stringify).join('\n')}\n`);

  const result = aggregate({ days: 7, now: NOW });
  assert.deepEqual(result.fires, { window: 5, total: 10 });
  assert.equal(result.sessions, 2);
  assert.equal(result.sessions_total, 3);
  assert.equal(result.last_fire_at, '2026-09-10T11:00:00.000Z');
  assert.deepEqual(result.reads, { window: 3, total: 4 });
  assert.equal(result.rate, 3 / 5);
  assert.equal(result.reports, 2);
  assert.equal(result.saved_sum, 350);
  assert.deepEqual(result.unique_slugs, [{ slug: 'alpha', count: 2 }, { slug: 'beta', count: 1 }]);
}));

test('gate状態と台帳が無ければ全項目をゼロ埋めする', () => withHome(tempHome(), () => {
  const result = aggregate({ days: 7, now: NOW });
  assert.deepEqual(result.fires, { window: 0, total: 0 });
  assert.deepEqual(result.reads, { window: 0, total: 0 });
  assert.equal(result.sessions, 0);
  assert.equal(result.reports, 0);
  assert.equal(result.saved_sum, 0);
  assert.equal(result.rate, null);
  assert.deepEqual(result.unique_slugs, []);
}));

test('appendUsageは親とファイルを作り、複数行追記してatを補完する', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'makimono-append-test-'));
  return withHome(home, () => {
    appendUsage({ t: 'read', slug: 'alpha', chars: 12 });
    appendUsage({ t: 'report', slug: 'alpha', saved: 34, at: '2026-09-10T00:00:00.000Z' });
    const file = path.join(home, '.claude', 'makimono-usage-ledger.jsonl');
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(lines.length, 2);
    assert.equal(lines[0].t, 'read');
    assert.match(lines[0].at, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(lines[1].at, '2026-09-10T00:00:00.000Z');
  });
});
