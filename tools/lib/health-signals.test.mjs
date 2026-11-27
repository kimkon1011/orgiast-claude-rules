import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expectationLog, logIsStale } from './health-signals.mjs';

test('homeFile resolves ~/.claude ledger freshness outside logs/', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'health-signals-'));
  const claude = path.join(home, '.claude');
  fs.mkdirSync(claude);
  const file = path.join(claude, 'next-actions.md');
  fs.writeFileSync(file, '## 明日の推奨アクション\n', 'utf8');
  const hit = expectationLog(home, { homeFile: 'next-actions.md' });
  assert.equal(hit.file, file);
  assert.ok(Number.isFinite(hit.mtimeMs));
  assert.equal(expectationLog(home, { homeFile: 'missing.md' }), null);
  fs.rmSync(home, { recursive: true, force: true });
});

test('logIsStale uses maxAgeHours against mtime', () => {
  const now = Date.parse('2026-11-27T02:00:00Z');
  assert.equal(logIsStale(now - 29 * 3600000, 30, now), false);
  assert.equal(logIsStale(now - 31 * 3600000, 30, now), true);
});
