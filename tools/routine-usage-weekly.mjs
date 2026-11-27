#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchBeacons } from './fleet-beacon.mjs';
import { isEntry } from './is-entry.mjs';

const WEEK = 7 * 24 * 60 * 60 * 1000;
function rows(file) {
  try { return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } }); }
  catch { return []; }
}
function recent(row, since) { const t = Date.parse(row.t); return Number.isFinite(t) && t >= since; }
function keyOf(row, host) { return `${host}\0${row.job || row.caller || 'unknown'}`; }

export function aggregateRoutineUsage({ usageRows = [], runRows = [], remote = [], host = os.hostname(), now = Date.now(), limit = 20 } = {}) {
  const since = Number(now) - WEEK;
  const map = new Map();
  const get = (key, pc, job) => { if (!map.has(key)) map.set(key, { pc, job, llmCalls: 0, inputTokens: 0, outputTokens: 0, usd: 0, runs: 0, unchanged: 0 }); return map.get(key); };
  for (const row of usageRows.filter((item) => recent(item, since))) {
    const job = row.job || row.caller || 'unknown'; const item = get(keyOf(row, host), host, job);
    item.llmCalls += 1; item.inputTokens += Number(row.in ?? row.inputTokens ?? 0) || 0; item.outputTokens += Number(row.out ?? row.outputTokens ?? 0) || 0; item.usd += Number(row.usd ?? row.costUsd ?? 0) || 0;
  }
  for (const row of runRows.filter((item) => recent(item, since))) {
    const pc = row.host || host; const job = row.job || 'unknown'; const item = get(keyOf(row, pc), pc, job);
    item.runs += 1; if (row.changed === false) item.unchanged += 1;
  }
  for (const item of remote.flatMap((beacon) => Array.isArray(beacon?.routineUsage7d) ? beacon.routineUsage7d : [])) {
    const pc = item.pc || 'remote'; const job = item.job || 'unknown';
    if (pc === host) continue;
    const target = get(`${pc}\0${job}`, pc, job);
    for (const field of ['llmCalls', 'inputTokens', 'outputTokens', 'usd', 'runs', 'unchanged']) target[field] += Number(item[field]) || 0;
  }
  return [...map.values()].map((item) => ({ ...item, noChangeRate: item.runs ? item.unchanged / item.runs : 0 })).sort((a, b) => b.usd - a.usd || b.llmCalls - a.llmCalls).slice(0, limit);
}

export function markdown(data) {
  const lines = ['# 定期処理 AI 利用（直近7日）', '', '| PC | job/caller | LLM回数 | 入力tok | 出力tok | USD | 実行回数 | 何も無かった率 |', '|---|---|---:|---:|---:|---:|---:|---:|'];
  for (const row of data) lines.push(`| ${row.pc} | ${row.job} | ${row.llmCalls} | ${row.inputTokens} | ${row.outputTokens} | ${row.usd.toFixed(4)} | ${row.runs} | ${(row.noChangeRate * 100).toFixed(1)}% |`);
  return `${lines.join('\n')}\n`;
}

export async function collectRoutineUsage({ home = process.env.ORGIAST_HOME || os.homedir(), now = Date.now(), includeFleet = true, fetchImpl } = {}) {
  const base = path.join(home, '.claude');
  const fleet = includeFleet ? await fetchBeacons({ home, fetchImpl }).catch(() => ({ beacons: [] })) : { beacons: [] };
  return aggregateRoutineUsage({ usageRows: rows(path.join(base, 'executor-usage.jsonl')), runRows: rows(path.join(base, 'change-gate', 'runs.jsonl')), remote: fleet.beacons || [], now });
}

export async function writeRoutineUsage({ home = process.env.ORGIAST_HOME || os.homedir(), now = Date.now(), includeFleet = true, fetchImpl } = {}) {
  const data = await collectRoutineUsage({ home, now, includeFleet, fetchImpl });
  const file = path.join(home, '.claude', 'cost-improve', 'routine-usage-weekly.md');
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, markdown(data), 'utf8');
  return { file, data };
}

if (isEntry(import.meta.url)) {
  const result = await writeRoutineUsage();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result.data, null, 2)); else console.log(result.file);
}
