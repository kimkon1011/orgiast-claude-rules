#!/usr/bin/env node
// kim-PC 専用: 各PCから届いた [lane-health] note を集計し「PC × レーン × 状態 × 理由 × 推奨対処」の表を出す。
// 毎時ウォッチドッグ（fleet-mail-watchdog.mjs）から runLaneHealthWatch を呼び、dead が新たに出たら kim に DM（1件1回）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntry } from './is-entry.mjs';
import { readInbox, resolveFleetLabel } from './fleet-mail.mjs';
import { notifyKim } from './notify-kim.mjs';
import { LANE_HEALTH_KIM_PC, parseLaneHealthMail, laneHealthRows, renderLaneHealthTable, laneHealthDm, deadLanes } from './lib/lane-health.mjs';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const STALE_MS = 48 * 3600_000;

function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }

export function accountResolver(pcMap) {
  return pc => pcMap?.[pc]?.codexAccount || pcMap?._codexAccountDefault || '';
}

// 受信 note + kim-PC 自身の lane-health.json から報告一覧を作る。
export function collectReports({ home, now = Date.now, selfLabel, readInboxImpl = readInbox }) {
  const reports = [];
  for (const mail of readInboxImpl(home, { unreadOnly: false })) {
    const report = parseLaneHealthMail(mail);
    if (report) reports.push(report);
  }
  const own = readJson(path.join(home, '.claude', 'lane-health.json'), null);
  if (own?.lanes && selfLabel) reports.push({ pc: selfLabel, recovered: false, at: own.probedAt || own.ts, autoFix: 'none', dead: deadLanes(own) });
  // 古すぎる報告は「状態不明」を避けるため dead 表から外す（最新が recovered のPCも自然に消える）。
  return reports.filter(r => now() - Date.parse(r.at) < STALE_MS);
}

export function buildReport({ home, now = Date.now, selfLabel, pcMap, readInboxImpl }) {
  const reports = collectReports({ home, now, selfLabel, readInboxImpl });
  const rows = laneHealthRows(reports, { account: accountResolver(pcMap) });
  return { rows, table: renderLaneHealthTable(rows) };
}

// ウォッチドッグから呼ぶ。新しい dead（pc|lane|reason）だけ DM。解消した key は state から消して、再発時に再通知する。
export async function runLaneHealthWatch({ home, now = Date.now, notify = notifyKim, dryRun = false, selfLabel, pcMap, readInboxImpl, stderr = console.error } = {}) {
  const label = selfLabel ?? (() => { try { return resolveFleetLabel(home); } catch { return LANE_HEALTH_KIM_PC; } })();
  const map = pcMap ?? readJson(path.join(repoRoot, 'fleet-pc-map.json'), {});
  const { rows, table } = buildReport({ home, now, selfLabel: label, pcMap: map, readInboxImpl });
  const stateFile = path.join(home, '.claude', 'fleet-lane-health-notified.json');
  const state = readJson(stateFile, {});
  const next = {};
  const notified = [];
  for (const row of rows) {
    if (state[row.key]) { next[row.key] = state[row.key]; continue; }
    if (dryRun) continue;
    try {
      const result = await notify(laneHealthDm(row), { home, webhookFallback: false });
      if (result?.delivered && result.delivered !== 'none') { next[row.key] = new Date(now()).toISOString(); notified.push(row.key); }
    } catch { stderr('fleet-lane-health: DM通知失敗=1'); }
  }
  if (!dryRun) {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, `${JSON.stringify(next, null, 2)}\n`);
  }
  return { rows, table, notified };
}

export async function main(argv = process.argv.slice(2)) {
  const home = process.env.ORGIAST_HOME || os.homedir();
  const pcMap = readJson(path.join(repoRoot, 'fleet-pc-map.json'), {});
  const { rows, table } = buildReport({ home, selfLabel: LANE_HEALTH_KIM_PC, pcMap });
  console.log(argv.includes('--json') ? JSON.stringify(rows) : table);
  return 0;
}
if (isEntry(import.meta.url)) { process.exitCode = await main().catch(e => { console.error(String(e.message)); return 1; }); }
