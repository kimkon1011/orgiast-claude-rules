import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cost-work-loop-'));
process.env.ORGIAST_HOME = isolatedHome;
const { decideEnforcement } = await import('./cost-work-loop.mjs');

const base = { claudeOut: 1_000_000, history: [], target: 0.5, previousMode: 'warn' };

test.after(() => fs.rmSync(isolatedHome, { recursive: true, force: true }));

test('non-pilot remains warn after 10 days at 0% delegation', () => {
  const result = decideEnforcement({ ...base, delegRatio: 0, daysObserved: 10, pilot: false });
  assert.equal(result.mode, 'warn');
  assert.match(result.reason, /cost-enforce-pilot が無い/);
});

test('non-pilot demotes a previous block to warn', () => {
  const result = decideEnforcement({ ...base, delegRatio: 0, daysObserved: 10, pilot: false, previousMode: 'block' });
  assert.equal(result.mode, 'warn');
  assert.match(result.reason, /降格/);
});

test('pilot blocks at 15% delegation after 3 days', () => {
  const result = decideEnforcement({ ...base, delegRatio: 0.15, daysObserved: 3, pilot: true });
  assert.equal(result.mode, 'block');
});

test('pilot remains warn at 60% delegation', () => {
  const result = decideEnforcement({ ...base, delegRatio: 0.6, daysObserved: 10, pilot: true });
  assert.equal(result.mode, 'warn');
});
