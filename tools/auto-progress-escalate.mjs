#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ledgerFile, readLedger, OPEN_STATUSES } from './auto-progress-ledger.mjs';
import { decisionOwnerOf } from './auto-progress-decision-owner.mjs';
import { notifyKim } from './notify-kim.mjs';
import { acquireLock } from './lib/progress-file-lock.mjs';
import { isEntry } from './is-entry.mjs';

const DAY_MS = 86400000;
export const escalationRowKey = row => `${row.sessionId || ''}${row.ts || ''}`;
export function decisionAge(row, now) {
  const times = [row.ts, row.lastCheckedAt].map(Date.parse).filter(Number.isFinite);
  return times.length ? now - Math.min(...times) : NaN;
}
export function escalationText(row, now) {
  return `【要対応・kim の判断待ち ${Math.floor(decisionAge(row, now) / DAY_MS)}日】${String(row.nextKim || '').slice(0, 2000)}\n（元の約束: ${String(row.promise || '').slice(0, 80)} / PC ${row.pc || ''} / セッション ${String(row.sessionId || '').slice(0, 8)} / 台帳 ts ${row.ts || ''}）`;
}

export async function escalateKimDecisions({ home = process.env.ORGIAST_HOME || os.homedir(), now = Date.now(), dryRun = false, io = {} } = {}) {
  const file = path.join(home, '.claude', 'auto-progress-escalated.json');
  // 読み取り専用の dry-run ではロックも状態ファイルも作らない。
  const release = dryRun ? () => {} : acquireLock(`${file}.lock`);
  if (!release) return { targets: [], sent: 0, skipped: 'locked' };
  try {
    let state = {};
    try { state = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('invalid escalation state');
    const rows = (io.readLedger ?? readLedger)(ledgerFile(home));
    const targets = [];
    let sent = 0;
    const seen = new Set();
    for (const row of rows) {
      if (!OPEN_STATUSES.has(row.status) || decisionOwnerOf(row) !== 'kim' || !(decisionAge(row, now) >= 2 * DAY_MS)) continue;
      const escalatedNextKim = String(row.nextKim ?? '').replace(/^[\s　]+|[\s　]+$/g, '');
      if (!escalatedNextKim || ['なし', '無し', '特になし', '不要', '対応不要'].includes(escalatedNextKim)) continue;
      const key = escalationRowKey(row);
      const lastSent = Date.parse(state[key]);
      if (seen.has(key) || (Number.isFinite(lastSent) && now - lastSent < DAY_MS)) continue;
      seen.add(key);
      const text = escalationText(row, now);
      targets.push({ rowKey: key, text });
      if (dryRun) continue;
      try {
        const result = await (io.notifyKim ?? notifyKim)(text, { kind: 'ask', kimActionRequired: true, sessionId: row.sessionId || '', home, now });
        if (!['dm', 'webhook', 'session-inbox'].includes(result?.delivered)) {
          (io.stderr ?? console.error)(`auto-progress-escalate: ${key}: ${result?.delivered || 'none'}: ${result?.reason || 'not delivered'}`);
          continue;
        }
        state[key] = new Date(now).toISOString();
        const temp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(temp, `${JSON.stringify(state)}\n`);
        fs.renameSync(temp, file);
        sent++;
      } catch (error) {
        (io.stderr ?? console.error)(`auto-progress-escalate: ${key}: ${error?.message || error}`);
      }
    }
    return { targets, sent };
  } finally { release(); }
}

if (isEntry(import.meta.url)) {
  try { console.log(JSON.stringify(await escalateKimDecisions({ dryRun: process.argv.includes('--dry-run') }), null, 2)); }
  catch (error) { console.error(error?.message || error); process.exitCode = 1; }
}
