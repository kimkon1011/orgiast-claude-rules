import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { parseArgs } from '../../tools/quota-sweep.mjs';
import { decideSweep } from '../../tools/lib/quota-windows.mjs';

const now = Date.UTC(2026, 9, 21);
const minute = 60_000;

// ── parseArgs — real argument processing ─────────────────────────────────

test('parseArgs returns defaults with no args', () => {
  const o = parseArgs([]);
  assert.equal(o.provider, 'all');
  assert.equal(o.leadMinutes, 90);
  assert.equal(o.minRemainingPercent, 15);
  assert.equal(o['dry-run'], undefined);
  assert.equal(o['json'], undefined);
});

test('parseArgs parses --dry-run and --json flags', () => {
  const o = parseArgs(['--dry-run', '--json', '--home', os.tmpdir()]);
  assert.equal(o['dry-run'], true);
  assert.equal(o['json'], true);
  assert.ok(o.home);
});

test('parseArgs --provider accepts claude, codex, all', () => {
  assert.equal(parseArgs(['--provider', 'claude']).provider, 'claude');
  assert.equal(parseArgs(['--provider', 'codex']).provider, 'codex');
  assert.equal(parseArgs(['--provider', 'all']).provider, 'all');
});

test('parseArgs --resume only accepts claude or codex', () => {
  assert.equal(parseArgs(['--resume', 'claude']).resume, 'claude');
  assert.equal(parseArgs(['--resume', 'codex']).resume, 'codex');
  assert.throws(() => parseArgs(['--resume', 'gemini']), /Invalid resume provider/);
});

test('parseArgs rejects invalid provider', () => {
  assert.throws(() => parseArgs(['--provider', 'gemini']), /Invalid sweep options/);
});

test('parseArgs rejects negative lead minutes', () => {
  assert.throws(() => parseArgs(['--lead-min', '-1']), /Invalid sweep options/);
});

test('parseArgs rejects out-of-range min-remaining', () => {
  assert.throws(() => parseArgs(['--min-remaining', '101']), /Invalid sweep options/);
});

test('parseArgs rejects unknown flags', () => {
  assert.throws(() => parseArgs(['--unknown']), /Unknown argument/);
});

// ── Full pipeline: parseArgs → decideSweep equivalence ──────────────────

test('parseArgs outputs are compatible with decideSweep options', () => {
  const windows = [
    { provider: 'claude', window: '5h', usedPercent: 40, resetsAt: now + 60 * minute },
    { provider: 'claude', window: '7d', usedPercent: 20, resetsAt: now + 500 * minute },
  ];
  const opts = parseArgs(['--lead-min', '60', '--min-remaining', '20']);
  assert.equal(opts.leadMinutes, 60);
  assert.equal(opts.minRemainingPercent, 20);
  const decisions = decideSweep({ windows, now, leadMinutes: 60, minRemainingPercent: 20 });
  assert.ok(Array.isArray(decisions));
});