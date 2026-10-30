import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readClaudeWindows, readCodexWindows } from './quota-windows.mjs';

export const DAY = 86_400_000;
const finite = value => typeof value === 'number' && Number.isFinite(value);
const percent = value => finite(value) && value >= 0 && value <= 100 ? value : null;
const key = row => JSON.stringify([row.provider, row.source]);
export function defaultHome() {
  return process.env.L1_METRICS_HOME || (process.platform === 'linux' && fs.existsSync('/mnt/c/Users/user/.claude')
    ? '/mnt/c/Users/user' : os.homedir());
}
export function readJsonl(file) {
  try { return fs.readFileSync(file, 'utf8').split(/\r?\n/).flatMap(line => {
    try { const row = JSON.parse(line); return row && typeof row === 'object' && !Array.isArray(row) ? [row] : []; } catch { return []; }
  }); } catch { return []; }
}
export async function mapLimit(tasks, limit) {
  if (!Number.isInteger(limit) || limit < 1) throw new Error('pods must be a positive integer');
  const results = new Array(tasks.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (next < tasks.length) { const i = next++; results[i] = await tasks[i](); }
  }));
  return results;
}
// No monetary quota budget is available. Forecast using observed percentage/day,
// gated by positive spend; never assume that lifetime usage was consumed today.
export function estimateDays(current, history, now) {
  if (!(current.spend > 0) || !finite(current.usedPercent)) return null;
  if (current.usedPercent >= 100) return 0;
  const samples = history.filter(r => key(r) === key(current) && finite(r.usedPercent)
    && Date.parse(r.ts) >= now - DAY && Date.parse(r.ts) < now).sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  if (!samples.length) return null;
  const values = [...samples, current];
  if (values.some((r, i) => i > 0 && r.usedPercent < values[i - 1].usedPercent)) return null;
  const rate = (current.usedPercent - samples[0].usedPercent) / ((now - Date.parse(samples[0].ts)) / DAY);
  return rate > 0 ? (100 - current.usedPercent) / rate : null;
}
export async function collectMetrics({ home = defaultHome(), now = Date.now(), pods = 6, history = [],
  claudeReader = readClaudeWindows, codexReader = readCodexWindows } = {}) {
  const dir = path.join(home, '.claude');
  let claude, codex;
  const safe = fn => Promise.resolve().then(fn).catch(() => []);
  // Share each reader invocation between its two windows (one OAuth request).
  const windowTask = (provider, window) => async () => {
    const windows = provider === 'claude'
      ? await (claude ??= safe(() => claudeReader({ home, now: () => now })))
      : await (codex ??= safe(() => codexReader({ home, now })));
    return windows.find(w => w.window === window);
  };
  const [c5, c7, cp, cs, usage, sweep] = await mapLimit([
    windowTask('claude', '5h'), windowTask('claude', '7d'), windowTask('codex', 'primary'), windowTask('codex', 'secondary'),
    async () => readJsonl(path.join(dir, 'executor-usage.jsonl')),
    async () => readJsonl(path.join(dir, 'quota-sweep.jsonl')),
  ], pods);
  const providers = new Set(usage.map(r => r.provider).filter(p => typeof p === 'string' && p.length));
  const spends = new Map([...providers].map(p => [p, 0]));
  for (const row of usage) {
    const at = Date.parse(row.t);
    if (!providers.has(row.provider) || !(at >= now - DAY && at <= now)) continue;
    const input = row.tokensIn ?? row.in, output = row.tokensOut ?? row.out;
    const tokens = finite(input) || finite(output) ? Math.max(0, input || 0) + Math.max(0, output || 0) : row.tokens;
    // provider-routing.gatewayModel maps names only; it supplies no price table.
    const spend = finite(row.usd) && row.usd >= 0 ? row.usd : finite(tokens) && tokens >= 0 ? tokens * 3 / 1_000_000 : null;
    const prior = spends.get(row.provider);
    spends.set(row.provider, prior === null || spend === null ? null : prior + spend);
  }
  const ts = new Date(now).toISOString();
  const result = [];
  const add = (provider, source, usedPercent) => {
    const row = { ts, source, usedPercent: percent(usedPercent), spend: spends.get(provider) ?? null, depletedAt: null, provider, ai: source };
    row.depletedAt = estimateDays(row, history, now);
    result.push(row);
  };
  for (const [provider, window, value] of [['claude', '5h', c5], ['claude', '7d', c7], ['codex', 'primary', cp], ['codex', 'secondary', cs]]) {
    if (value) add(provider, `${provider}-${window}`, value.usedPercent);
  }
  for (const provider of providers) {
    if (result.some(r => r.provider === provider)) continue;
    const latest = sweep.filter(r => r.provider === provider && Date.parse(r.ts) <= now)
      .sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts))[0];
    add(provider, provider, latest?.beforeUsedPercent);
  }
  return result;
}
export function atomicWrite(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(tmp, data); fs.renameSync(tmp, file); }
  finally { fs.rmSync(tmp, { force: true }); }
}
const HEADER = 'ts,source,used_percent,spend,depleted_at,provider\n';
const csvCell = value => /[",\r\n]/.test(String(value ?? '')) ? `"${String(value).replaceAll('"', '""')}"` : String(value ?? '');
export function appendCsv(file, rows) {
  if (!Array.isArray(rows)) rows = [rows];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    // Copy bytes without parsing/loading old rows; rename publishes the whole snapshot.
    if (fs.existsSync(file) && fs.statSync(file).size) fs.copyFileSync(file, tmp);
    else fs.writeFileSync(tmp, HEADER);
    fs.appendFileSync(tmp, rows.map(r => [r.ts, r.source, r.usedPercent, r.spend, r.depletedAt, r.provider].map(csvCell).join(',') + '\n').join(''));
    fs.renameSync(tmp, file);
  } finally { fs.rmSync(tmp, { force: true }); }
}
export function readCsv(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const records = []; let cells = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (quoted && text[i + 1] === '"') { cell += '"'; i++; } else quoted = !quoted;
    } else if (!quoted && (ch === ',' || ch === '\n')) {
      cells.push(cell.replace(/\r$/, '')); cell = '';
      if (ch === '\n') { records.push(cells); cells = []; }
    } else cell += ch;
  }
  const number = v => v !== '' && Number.isFinite(Number(v)) ? Number(v) : null;
  return records.slice(1).filter(r => r.length === 6 && Number.isFinite(Date.parse(r[0]))).map(r => ({
    ts: r[0], source: r[1], ai: r[1], usedPercent: number(r[2]), spend: number(r[3]), depletedAt: number(r[4]), provider: r[5],
  }));
}
export function tagMetrics(rows, { now = Date.now() } = {}) {
  const groups = new Map();
  for (const row of rows) {
    if (!(Date.parse(row.ts) <= now)) continue;
    const id = key(row); if (!groups.has(id)) groups.set(id, []); groups.get(id).push(row);
  }
  return [...groups.values()].flatMap(group => {
    group.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
    const latest = group.at(-1);
    if (Date.parse(latest.ts) < now - DAY) return [];
    const start = Date.parse(latest.ts) - DAY;
    const baseline = group.filter(r => Date.parse(r.ts) <= start).at(-1);
    const recent = group.filter(r => Date.parse(r.ts) > start);
    const samples = baseline ? [baseline, ...recent] : recent;
    const values = samples.map(r => r.usedPercent);
    const converged = baseline && values.every(finite) && Math.max(...values) - Math.min(...values) < 1;
    const tag = !finite(latest.usedPercent) || !finite(latest.depletedAt) ? 'unknown'
      : latest.depletedAt < 0.5 ? 'starving' : latest.depletedAt < 3 ? 'warning' : converged ? 'converged' : 'normal';
    return [{ ai: latest.ai || latest.source, usedPercent: latest.usedPercent, depletedAtDays: latest.depletedAt, tag, spend24h: latest.spend }];
  });
}
export function detectAnomalies({ previous, current }) {
  if (!previous) return [];
  const result = [];
  const add = (level, message) => result.push({ level, message, provider: previous.provider, source: previous.source });
  if (!current) { add('error', 'Data disappeared: source missing'); return result; }
  for (const field of ['usedPercent', 'spend', 'depletedAt']) {
    if (finite(previous[field]) && !finite(current[field])) add('error', `Data disappeared: ${field}`);
  }
  if (previous.spend > 0 && current.spend > previous.spend * 10) add('warn', `Spend increased ${current.spend / previous.spend}x`);
  if (previous.depletedAt > 0 && current.depletedAt > previous.depletedAt * 2
    && !(finite(current.usedPercent) && finite(previous.usedPercent) && current.usedPercent < previous.usedPercent)) add('warn', `Remaining days increased ${current.depletedAt / previous.depletedAt}x`);
  if (finite(previous.usedPercent) && finite(current.usedPercent) && current.usedPercent - previous.usedPercent > 50) add('error', `Used percent increased ${current.usedPercent - previous.usedPercent} points`);
  return result;
}
export function metricKey(row) { return key(row); }
