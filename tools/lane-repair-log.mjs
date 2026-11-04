#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { laneHome, readJson } from './lane-doctor.mjs';
import { faultId, repairRows } from './lib/lane-repair-state.mjs';
import { redactAll } from './lib/redact.mjs';
import { notifyKim } from './notify-kim.mjs';
import { isEntry } from './is-entry.mjs';

export async function recordRepair({ lane, tried, result, home = laneHome(), now = Date.now(), notify = notifyKim } = {}) {
  const health = readJson(path.join(home, '.claude/lane-health.json'));
  if (!health.lanes?.[lane] || lane === 'gemini-cli') throw new Error('--lane must name a lane in lane-health.json');
  if (!tried?.trim() || !['fixed', 'unfixable'].includes(result)) throw new Error('--tried and --result fixed|unfixable are required');
  const dir = path.join(home, '.claude');
  fs.mkdirSync(dir, { recursive: true });
  const lock = path.join(dir, 'lane-repair-log.lock');
  // Serialize the third-failure notification. Recover a crashed writer's stale
  // lock, while active writers remain protected (notification deadline: 5s).
  let fd;
  try { fd = fs.openSync(lock, 'wx', 0o600); } catch (e) {
    if (e.code !== 'EEXIST' || Date.now() - fs.statSync(lock).mtimeMs < 60_000) throw e;
    fs.unlinkSync(lock);
    fd = fs.openSync(lock, 'wx', 0o600);
  }
  try {
    const rows = repairRows(home), id = faultId(lane, health.lanes[lane]);
    const row = { ts: new Date(now).toISOString(), lane, faultId: id, tried: redactAll(tried.trim()).slice(0, 1500), result };
    fs.appendFileSync(path.join(dir, 'lane-repair-log.jsonl'), JSON.stringify(row) + '\n', { mode: 0o600 });
    const consecutive = [];
    for (const r of [...rows, row].filter(r => r.lane === lane).reverse()) {
      if (r.result !== 'unfixable' || r.faultId !== id) break;
      consecutive.push(r);
    }
    if (consecutive.length >= 3 && !consecutive.some(r => r.notified)) {
      const delivery = await notify(`[LANE-REPAIR] ${os.hostname()} の ${lane}: 同一故障(${health.lanes[lane].reason})の修復不可が${consecutive.length}回連続。試行: ${row.tried}。原因の調査と修復が必要です。`, { home, signal: AbortSignal.timeout(5000) });
      row.notification = delivery?.delivered || 'none';
      if (delivery?.delivered && !['none', 'unknown', 'suppressed'].includes(delivery.delivered)) {
        fs.appendFileSync(path.join(dir, 'lane-repair-log.jsonl'), JSON.stringify({ ...row, notified: true }) + '\n');
      }
    }
    return row;
  } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}
if (isEntry(import.meta.url)) {
  try {
    const args = process.argv.slice(2), value = flag => args[args.indexOf(flag) + 1];
    for (const flag of ['--lane', '--tried', '--result']) if (!args.includes(flag)) throw new Error(`${flag} is required`);
    console.log(JSON.stringify(await recordRepair({ lane: value('--lane'), tried: value('--tried'), result: value('--result') })));
  } catch (e) { console.error(redactAll(e.message)); process.exitCode = 1; }
}
