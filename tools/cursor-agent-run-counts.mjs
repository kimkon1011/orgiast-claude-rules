#!/usr/bin/env node
// 各PCの朝の見回り用。executor-usage / fallback-backend-history から
// cursor-agent の実行件数を数え、reports に1行書き出す。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isEntry } from './is-entry.mjs';
import { countCursorAgentRuns, jstStamp } from './lib/cursor-usage-pace.mjs';

export function cursorAgentRunsTxtPath(home) {
  return path.join(home, '.claude', 'reports', 'cursor-agent-runs.txt');
}
export function cursorAgentRunsJsonlPath(home) {
  return path.join(home, '.claude', 'reports', 'cursor-agent-runs.jsonl');
}

function startOfJstDay(now) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(now));
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return Date.parse(`${get('year')}-${get('month')}-${get('day')}T00:00:00+09:00`);
}

export function formatRunCountsLine({ host, now, today, sinceReset, windowStart, windowEnd }) {
  return `${jstStamp(now)} host=${host} 今日 cursor-agent 試行${today.attempts} 成功${today.ok} タイムアウト${today.timeout} その他${today.other} / 集計開始(${windowStart})以降 試行${sinceReset.attempts} 成功${sinceReset.ok}`;
}

export function writeRunCounts(home, record) {
  const line = record.line;
  const txt = cursorAgentRunsTxtPath(home);
  const jsonl = cursorAgentRunsJsonlPath(home);
  fs.mkdirSync(path.dirname(txt), { recursive: true });
  fs.writeFileSync(txt, `${line}\n`, 'utf8');
  fs.appendFileSync(jsonl, `${JSON.stringify({ ...record, t: new Date(record.now || Date.now()).toISOString() })}\n`, 'utf8');
  return { line, txt, jsonl };
}

export function runCursorAgentRunCounts({
  home = process.env.ORGIAST_HOME || os.homedir(),
  now = Date.now(),
  sinceMs = Date.parse('2026-11-18T00:00:00+09:00'),
  host = process.env.COMPUTERNAME || os.hostname(),
} = {}) {
  const dayStart = startOfJstDay(now);
  const today = countCursorAgentRuns(home, { sinceMs: dayStart, untilMs: now });
  const sinceReset = countCursorAgentRuns(home, { sinceMs, untilMs: now });
  const windowStart = new Date(sinceMs).toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
  const windowEnd = new Date(now).toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
  const line = formatRunCountsLine({ host, now, today, sinceReset, windowStart, windowEnd });
  const written = writeRunCounts(home, {
    line, now, host, today, sinceReset, windowStart, windowEnd,
  });
  return { ...written, today, sinceReset };
}

export function main() {
  const result = runCursorAgentRunCounts();
  console.log(result.line);
  console.log(`書き出し: ${result.txt}`);
  return 0;
}

if (isEntry(import.meta.url)) process.exitCode = main();
