#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { isEntry } from './is-entry.mjs';
import { collectMetrics, appendCsv, readCsv, tagMetrics, detectAnomalies, atomicWrite, defaultHome, metricKey } from './lib/l1-metrics.mjs';

export function parseArgs(args) {
  const options = { interval: 120, pods: 6, once: false, json: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--once' || arg === '--json') options[arg.slice(2)] = true;
    else if (arg === '--interval' || arg === '--pods') {
      const value = Number(args[++i]);
      if (!Number.isFinite(value) || value <= 0 || (arg === '--pods' && !Number.isInteger(value))
        || (arg === '--interval' && (value * 60_000 > 2_147_483_647 || value * 60_000 < 1))) throw new Error(`Invalid ${arg}`);
      options[arg.slice(2)] = value;
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}
export function acquireGuard(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Exclusive creation also protects against simultaneous starts. Do not steal
  // an old guard: PID reuse and partially written ownership records are ambiguous.
  let fd;
  try { fd = fs.openSync(file, 'wx'); }
  catch (error) { if (error.code === 'EEXIST') throw new Error(`L1 guard already exists: ${file}`); throw error; }
  try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }) + '\n'); }
  catch (error) { fs.rmSync(file, { force: true }); throw error; }
  finally { fs.closeSync(fd); }
  return () => fs.rmSync(file, { force: true });
}
export async function runCycle({ home = defaultHome(), pods = 6, now = Date.now(), collector = collectMetrics } = {}) {
  const dir = path.join(home, '.claude');
  const csv = path.join(dir, 'metrics', 'l1-metrics.csv');
  const state = path.join(dir, 'state');
  const history = readCsv(csv);
  // Persist the complete latest snapshot, including an empty collection, so
  // disappearances are compared with the immediately preceding cycle only.
  let previous;
  try { previous = JSON.parse(fs.readFileSync(path.join(state, 'l1-metrics-latest.json'), 'utf8')).metrics; } catch {}
  if (!Array.isArray(previous)) {
    const latestTs = history.reduce((latest, row) => Math.max(latest, Date.parse(row.ts)), -Infinity);
    previous = history.filter(row => Date.parse(row.ts) === latestTs);
  }
  const metrics = await collector({ home, pods, now, history });
  appendCsv(csv, metrics);
  const present = new Map(metrics.map(row => [metricKey(row), row]));
  const ais = tagMetrics([...history, ...metrics], { now }).filter(tag => metrics.some(row => row.source === tag.ai));
  const anomalies = previous.flatMap(row => detectAnomalies({ previous: row, current: present.get(metricKey(row)) }));
  const updatedAt = new Date(now).toISOString();
  const comparisons = metrics.map(row => {
    const prev = previous.find(p => metricKey(p) === metricKey(row));
    const delta = field => typeof row[field] === 'number' && typeof prev?.[field] === 'number' ? row[field] - prev[field] : null;
    return { provider: row.provider, source: row.source, usedPercentDelta: delta('usedPercent'), spendDelta: delta('spend'), depletedAtDelta: delta('depletedAt') };
  });
  atomicWrite(path.join(state, 'l1-metrics-tags.json'), JSON.stringify({ updatedAt, ais }, null, 2) + '\n');
  if (anomalies.length) fs.appendFileSync(path.join(state, 'l1-metrics-anomalies.jsonl'), anomalies.map(a => JSON.stringify({ ts: updatedAt, ...a }) + '\n').join(''));
  atomicWrite(path.join(state, 'l1-metrics-latest.json'), JSON.stringify({ updatedAt, metrics, comparisons }, null, 2) + '\n');
  return { updatedAt, ais, comparisons, anomalies };
}
export async function main(args = process.argv.slice(2), {
  guardFile = path.resolve('.loop', 'l1-metrics.guard'), cycle = runCycle,
  stdout = process.stdout, stderr = process.stderr, signals = process,
} = {}) {
  const options = parseArgs(args);
  const release = acquireGuard(guardFile);
  let stopping = false, wake;
  const stop = () => { stopping = true; wake?.(); };
  signals.on('SIGINT', stop); signals.on('SIGTERM', stop);
  try {
    do {
      const started = Date.now();
      const result = await cycle(options);
      for (const anomaly of result.anomalies) stderr.write(`${JSON.stringify(anomaly)}\n`);
      stdout.write(options.json ? `${JSON.stringify(result)}\n` : `${result.updatedAt} ${result.ais.map(a => `${a.ai}: ${a.tag}`).join(', ')}\n`);
      if (options.once || stopping) break;
      await new Promise(resolve => {
        const timer = setTimeout(() => { wake = undefined; resolve(); }, Math.max(1, options.interval * 60_000 - (Date.now() - started)));
        wake = () => { clearTimeout(timer); wake = undefined; resolve(); };
      });
    } while (!stopping);
  } finally {
    signals.off('SIGINT', stop); signals.off('SIGTERM', stop); release();
  }
}
if (isEntry(import.meta.url)) {
  main().catch(error => { process.stderr.write(`l1-metrics: ${error.message}\n`); process.exitCode = 1; });
}
