#!/usr/bin/env node
// kim-PC のみ・朝08:40。共有 Sheet の直近24hの stalled/resumed 行を1通の Discord DM にまとめる。0件なら送らない。
import os from 'node:os';
import { isEntry } from './is-entry.mjs';
import { notifyKim } from './notify-kim.mjs';
import { resolveFleetLabel } from './lib/fleet-label.mjs';
import { sheetConfig, postSheet } from './auto-progress-watch.mjs';

export const WINDOW_MS = 24 * 3600 * 1000;

export function selectRows(rows, now = Date.now()) {
  const seen = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const reported = Date.parse(row?.reportedAt);
    if (!Number.isFinite(reported) || now - reported > WINDOW_MS) continue;
    if (!(row.verdict === 'stalled' || row.resumeAttempted === true || row.resumeAttempted === 'TRUE' || row.resumeAttempted === 'true')) continue;
    const prev = seen.get(row.key || `${row.sessionId}|${row.recordedAt}`);
    if (!prev || Date.parse(prev.reportedAt) < reported) seen.set(row.key || `${row.sessionId}|${row.recordedAt}`, row);
  }
  return [...seen.values()].sort((a, b) => Date.parse(a.recordedAt) - Date.parse(b.recordedAt));
}

const hoursSince = (iso, now) => { const t = Date.parse(iso); return Number.isFinite(t) ? Math.max(0, Math.round((now - t) / 3600000)) : null; };

export function formatDigest(rows, now = Date.now()) {
  if (!rows.length) return '';
  const lines = rows.map((row) => {
    const elapsed = hoursSince(row.recordedAt, now);
    const last = hoursSince(row.lastEvidenceAt, now);
    const resume = row.resumeAttempted === true || row.resumeAttempted === 'TRUE' || row.resumeAttempted === 'true' ? (row.resumeOutcome || '再開を試行（結果不明）') : '再開は未実施';
    return `・${row.pc}／約束: ${String(row.promise).slice(0, 80)}／経過 ${elapsed ?? '?'} 時間／最後の動き: ${last === null ? 'なし' : `${last} 時間前`}（${row.reason || '理由なし'}）／自動再開: ${resume}`;
  });
  return `止まっている自動進行 ${rows.length} 件\n${lines.join('\n')}`;
}

export async function run({ home = process.env.ORGIAST_HOME || os.homedir(), now = Date.now(), dryRun = false, io = {} } = {}) {
  if ((io.label ?? resolveFleetLabel(home)) !== 'kim-PC') return { skipped: 'not-kim-pc', sent: false, count: 0 };
  const config = (io.sheetConfig ?? sheetConfig)(home);
  if (!config) return { skipped: 'no-sheet-config', sent: false, count: 0 };
  const response = await (io.postSheet ?? postSheet)(config, 'auto-progress-list', { sinceMs: now - WINDOW_MS });
  const rows = selectRows(response?.rows, now);
  if (!rows.length) return { sent: false, count: 0 };
  const text = formatDigest(rows, now);
  if (dryRun) return { sent: false, count: rows.length, text };
  const result = await (io.notify ?? notifyKim)(text, { home, webhookFallback: false });
  return { sent: result?.delivered === 'dm', count: rows.length, ...(result?.delivered === 'dm' ? {} : { error: result?.reason || 'DM not delivered' }) };
}

if (isEntry(import.meta.url)) {
  try { console.log(JSON.stringify(await run({ dryRun: process.argv.includes('--dry-run') }))); }
  catch (error) { console.error(String(error?.message ?? error)); }
  process.exitCode = 0;
}
