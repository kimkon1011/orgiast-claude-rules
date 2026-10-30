import test from 'node:test';
import { EventEmitter } from 'node:events';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DAY, collectMetrics, appendCsv, readCsv, tagMetrics, detectAnomalies, mapLimit, estimateDays } from './lib/l1-metrics.mjs';
import { parseArgs, acquireGuard, runCycle, main } from './l1-metrics-loop.mjs';
const now = Date.parse('2026-10-31T12:00:00Z');
const row = (changes = {}) => ({ ts: new Date(now).toISOString(), source: 'p', provider: 'p', ai: 'p', usedPercent: 50, spend: 3, depletedAt: 5, ...changes });
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'l1-metrics-'));
  fs.mkdirSync(path.join(home, '.claude'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}
test('CSV retains previous cycles, one header, nulls and quoted fields', t => {
  const file = path.join(fixture(t), 'metrics.csv');
  const first = row({ source: 'a,"b\nc', spend: null });
  appendCsv(file, first); appendCsv(file, [row()]);
  assert.deepEqual(readCsv(file), [{ ...first, ai: first.source }, row()]);
  assert.equal(fs.readFileSync(file, 'utf8').split('ts,source,used_percent').length, 2);
  assert.deepEqual(fs.readdirSync(path.dirname(file)).filter(f => f.endsWith('.tmp')), []);
});
test('collection tolerates corrupt lines, discovers providers and accounts for 24h spend', async t => {
  const home = fixture(t), dir = path.join(home, '.claude');
  fs.writeFileSync(path.join(dir, 'executor-usage.jsonl'), [
    '{broken', JSON.stringify({ t: new Date(now).toISOString(), provider: 'new-ai', in: 500000, out: 500000 }),
    JSON.stringify({ t: new Date(now - 2 * DAY).toISOString(), provider: 'old-ai', tokens: 9000000 }),
    JSON.stringify({ t: new Date(now + DAY).toISOString(), provider: 'new-ai', tokens: 9000000 }),
    JSON.stringify({ t: new Date(now).toISOString(), provider: 'billed', tokens: 1000000, usd: 0.4 }), 'null',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'quota-sweep.jsonl'), [
    JSON.stringify({ ts: new Date(now).toISOString(), provider: 'new-ai', beforeUsedPercent: 50 }),
    JSON.stringify({ ts: new Date(now - DAY).toISOString(), provider: 'new-ai', beforeUsedPercent: 10 }), '{',
  ].join('\n'));
  const metrics = await collectMetrics({ home, now, history: [row({ source: 'new-ai', provider: 'new-ai', usedPercent: 25, ts: new Date(now - DAY).toISOString() })],
    claudeReader: async () => { throw new Error('broken'); }, codexReader: () => [] });
  assert.equal(metrics.find(r => r.provider === 'new-ai').spend, 3);
  assert.equal(metrics.find(r => r.provider === 'new-ai').depletedAt, 2);
  assert.equal(metrics.find(r => r.provider === 'old-ai').spend, 0);
  assert.equal(metrics.find(r => r.provider === 'old-ai').usedPercent, null);
  assert.equal(metrics.find(r => r.provider === 'billed').spend, 0.4);
});
test('four independent windows share reader calls; pods=1 does not deadlock', async t => {
  let claudeCalls = 0, codexCalls = 0;
  const metrics = await collectMetrics({ home: fixture(t), now, pods: 1,
    claudeReader: async () => { claudeCalls++; return ['5h', '7d'].map(window => ({ window, usedPercent: 40 })); },
    codexReader: () => { codexCalls++; return ['primary', 'secondary'].map(window => ({ window, usedPercent: 70 })); } });
  assert.equal(claudeCalls, 1); assert.equal(codexCalls, 1);
  assert.deepEqual(metrics.map(r => r.source), ['claude-5h', 'claude-7d', 'codex-primary', 'codex-secondary']);
});
test('bounded asynchronous workers enforce parallelism', async () => {
  let active = 0, peak = 0;
  const results = await mapLimit(Array.from({ length: 9 }, (_, i) => async () => {
    active++; peak = Math.max(peak, active); await new Promise(r => setTimeout(r, 5)); active--; return i;
  }), 6);
  assert.equal(peak, 6); assert.deepEqual(results, [0, 1, 2, 3, 4, 5, 6, 7, 8]);
});
test('forecast requires observed consumption and rejects resets and zero spend', () => {
  const history = [row({ ts: new Date(now - DAY).toISOString(), usedPercent: 25 })];
  assert.equal(estimateDays(row(), history, now), 2);
  assert.equal(estimateDays(row(), [], now), null);
  assert.equal(estimateDays(row({ spend: 0 }), history, now), null);
  assert.equal(estimateDays(row({ usedPercent: 10 }), history, now), null);
  assert.equal(estimateDays(row({ usedPercent: 100 }), history, now), 0);
});
test('tags use full 24h, per-source range, severity and null handling', () => {
  const baseline = row({ ts: new Date(now - DAY).toISOString(), usedPercent: 50.5 });
  assert.equal(tagMetrics([row()], { now })[0].tag, 'normal');
  assert.equal(tagMetrics([baseline, row()], { now })[0].tag, 'converged');
  assert.equal(tagMetrics([baseline, row({ depletedAt: 0.49 })], { now })[0].tag, 'starving');
  assert.equal(tagMetrics([baseline, row({ depletedAt: 0.5 })], { now })[0].tag, 'warning');
  assert.equal(tagMetrics([row({ depletedAt: 3 })], { now })[0].tag, 'normal');
  assert.equal(tagMetrics([row({ usedPercent: null })], { now })[0].tag, 'unknown');
  assert.equal(tagMetrics([baseline, row({ ts: new Date(now - DAY / 2).toISOString(), usedPercent: 52 }), row()], { now })[0].tag, 'normal');
  assert.equal(tagMetrics([baseline, row({ source: 'other', ai: 'other' })], { now }).find(r => r.ai === 'other').tag, 'normal');
});
test('anomalies detect missing data, spikes and reset exceptions', () => {
  assert.deepEqual(detectAnomalies({ current: row() }), []);
  assert.equal(detectAnomalies({ previous: row(), current: null })[0].level, 'error');
  assert.equal(detectAnomalies({ previous: row(), current: row({ spend: 31 }) })[0].level, 'warn');
  assert.deepEqual(detectAnomalies({ previous: row(), current: row({ spend: 30 }) }), []);
  assert.equal(detectAnomalies({ previous: row(), current: row({ depletedAt: 11 }) })[0].level, 'warn');
  assert.deepEqual(detectAnomalies({ previous: row(), current: row({ depletedAt: 11, usedPercent: 1 }) }), []);
  assert.equal(detectAnomalies({ previous: row({ usedPercent: 1 }), current: row({ usedPercent: 90 }) })[0].level, 'error');
  assert.equal(detectAnomalies({ previous: row(), current: row({ spend: null }) })[0].level, 'error');
});
test('cycles save tags, deltas, anomalies and empty latest snapshots', async t => {
  const home = fixture(t);
  await runCycle({ home, now, collector: async () => [row()] });
  const second = await runCycle({ home, now: now + 1, collector: async () => [row({ ts: new Date(now + 1).toISOString(), spend: 31 })] });
  assert.equal(second.comparisons[0].spendDelta, 28);
  assert.equal(second.anomalies.length, 1);
  const third = await runCycle({ home, now: now + 2, collector: async () => [] });
  assert.equal(third.anomalies.length, 1); assert.deepEqual(third.ais, []);
  assert.deepEqual((await runCycle({ home, now: now + 3, collector: async () => [] })).anomalies, []);
  assert.equal(readCsv(path.join(home, '.claude/metrics/l1-metrics.csv')).length, 2);
  assert.equal(fs.readFileSync(path.join(home, '.claude/state/l1-metrics-anomalies.jsonl'), 'utf8').trim().split('\n').length, 2);
});
test('arguments and exclusive guard', t => {
  assert.deepEqual(parseArgs([]), { interval: 120, pods: 6, once: false, json: false });
  for (const args of [['--pods', '0'], ['--interval'], ['--pods', '1.5'], ['--wat'], ['--interval', 'Infinity']]) assert.throws(() => parseArgs(args));
  const file = path.join(fixture(t), '.loop/l1-metrics.guard');
  const release = acquireGuard(file); assert.throws(() => acquireGuard(file), /already exists/);
  release(); acquireGuard(file)();
});
test('main --once and signals during collection finish the cycle and clean guards', async t => {
  const home = fixture(t), guardFile = path.join(home, '.loop/l1-metrics.guard');
  const signals = new EventEmitter();
  for (const signal of [null, 'SIGINT', 'SIGTERM']) {
    let output = '', calls = 0;
    await main(['--json', ...(signal ? [] : ['--once'])], {
      guardFile, signals, stdout: { write: text => { output += text; } },
      cycle: async () => {
        calls++;
        if (signal) signals.emit(signal);
        await new Promise(resolve => setTimeout(resolve, 5));
        assert.equal(fs.existsSync(guardFile), true);
        return runCycle({ home, now, collector: async () => [row()] });
      },
    });
    assert.equal(calls, 1); assert.equal(JSON.parse(output).ais.length, 1);
    assert.equal(fs.existsSync(guardFile), false);
  }
});
test('signal wakes interval wait; failed cycles release ownership', async t => {
  const guardFile = path.join(fixture(t), '.loop/l1-metrics.guard');
  const signals = new EventEmitter();
  await main([], { guardFile, signals, cycle: async () => ({ updatedAt: '', ais: [], anomalies: [] }),
    stdout: { write: () => { setTimeout(() => signals.emit('SIGTERM'), 5); } } });
  assert.equal(fs.existsSync(guardFile), false);
  await assert.rejects(main(['--once'], { guardFile, cycle: async () => { throw new Error('disk failure'); } }), /disk failure/);
  assert.equal(fs.existsSync(guardFile), false);
});
