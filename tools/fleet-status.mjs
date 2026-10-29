#!/usr/bin/env node
// fleet 状況一覧: fleet-pc-map.json の全ラベルと GAS のビーコンを突き合わせて表にする。
// ビーコン無しPCも「ビーコン無し」と明示し、最終 poll はサーバー観測とクライアント申告の新しい方を出す。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntry } from './is-entry.mjs';
import { fetchBeacons } from './fleet-beacon.mjs';

const ownRepo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const STALE_MS = 24 * 60 * 60 * 1000;
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function parseTime(value) {
  const at = Date.parse(String(value ?? ''));
  return Number.isFinite(at) ? at : null;
}
// pcMap の _ 始まりキーは管理用なので除外し、全ラベルを出す。pcMap に無いが beacon にあるラベルも出す。
export function fleetLabels(pcMap) {
  return Object.entries(pcMap && typeof pcMap === 'object' && !Array.isArray(pcMap) ? pcMap : {})
    .filter(([label, entry]) => !label.startsWith('_') && entry && typeof entry === 'object' && !Array.isArray(entry))
    .map(([label]) => label);
}
export function buildFleetStatus({ pcMap, beacons = [], serverPolls = {}, now = Date.now() } = {}) {
  const byLabel = new Map();
  for (const beacon of Array.isArray(beacons) ? beacons : []) if (beacon?.label) byLabel.set(String(beacon.label), beacon);
  const labels = fleetLabels(pcMap);
  for (const label of byLabel.keys()) if (!labels.includes(label)) labels.push(label);
  return labels.map((label) => {
    const beacon = byLabel.get(label) || null;
    const beaconAt = beacon ? parseTime(beacon.reportedAt) : null;
    const beaconAgeMs = beaconAt === null ? null : now - beaconAt;
    const serverAt = parseTime(serverPolls?.[label] || beacon?.serverPollAt);
    const clientAt = beacon ? parseTime(beacon.pollAt) : null;
    let pollAt = null;
    let pollSource = '';
    if (serverAt !== null && (clientAt === null || serverAt >= clientAt)) { pollAt = serverAt; pollSource = 'server'; }
    else if (clientAt !== null) { pollAt = clientAt; pollSource = 'client'; }
    const pollAgeMs = pollAt === null ? null : now - pollAt;
    const stale = (beaconAgeMs === null || beaconAgeMs > STALE_MS) || (pollAgeMs === null || pollAgeMs > STALE_MS);
    return {
      label,
      account: beacon ? String(beacon.account || '') : '',
      hostname: String(beacon?.hostname || ''),
      reporterLabel: String(beacon?.reporterLabel || ''),
      registrationCandidate: !!beacon?.account?.includes('@') && !fleetLabels(pcMap).some(key => {
        const entry = pcMap[key];
        const names = [key, entry.hostname, ...(entry.aliases || [])].filter(Boolean).map(s => String(s).toLowerCase());
        return [label, beacon?.hostname, beacon?.reporterLabel].filter(Boolean).some(s => names.includes(String(s).toLowerCase()));
      }),
      beaconAt: beaconAt === null ? '' : new Date(beaconAt).toISOString(),
      beaconAgeMs,
      hasBeacon: Boolean(beacon),
      failing: beacon && Array.isArray(beacon.failing) ? beacon.failing : [],
      pollAt: pollAt === null ? '' : new Date(pollAt).toISOString(),
      pollSource,
      pollAgeMs,
      stale
    };
  });
}
function jst(ms) {
  const date = new Date(ms + JST_OFFSET_MS);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(date.getUTCMonth() + 1)}/${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
}
export function registrationCandidates(options) {
  return buildFleetStatus(options).filter(row => row.registrationCandidate);
}
export function formatAge(ms) {
  if (ms === null || !Number.isFinite(ms)) return '不明';
  if (ms < 60 * 60 * 1000) return `${Math.max(0, Math.round(ms / 60000))}m`;
  if (ms < 24 * 60 * 60 * 1000) return `${Math.round(ms / 3600000)}h`;
  return `${Math.round(ms / 86400000)}d`;
}
export function formatFleetTable(rows, now = Date.now()) {
  const lines = rows.map((row) => {
    const warn = row.stale ? '⚠ ' : '';
    const beacon = row.hasBeacon ? `${jst(Date.parse(row.beaconAt))} (${formatAge(row.beaconAgeMs)})` : 'ビーコン無し';
    const failing = row.failing.length ? row.failing.join(',') : '-';
    const poll = row.pollAt ? `${jst(Date.parse(row.pollAt))} (${formatAge(row.pollAgeMs)}) [${row.pollSource}]` : '不明';
    return `${warn}${row.label}${row.registrationCandidate ? ' [登録候補・アカウントは自己申告]' : ''} / ${row.account || '-'} / ビーコン: ${beacon} / 失敗: ${failing} / poll: ${poll}`;
  });
  return lines.join('\n');
}
export async function main(argv = process.argv.slice(2), deps = {}) {
  const home = deps.home ?? process.env.ORGIAST_HOME ?? os.homedir();
  const out = deps.stdout ?? console.log;
  const err = deps.stderr ?? console.error;
  const json = argv.includes('--json');
  const pcMap = deps.pcMap ?? readJson(path.join(ownRepo, 'fleet-pc-map.json'), {});
  const result = await fetchBeacons({ home, fetchImpl: deps.fetch });
  if (!result.ok) err(`fleet-status: ビーコン取得に失敗（${result.reason || '不明'}）。ビーコン情報なしで表示します`);
  const rows = buildFleetStatus({ pcMap, beacons: result.beacons, serverPolls: result.serverPolls, now: deps.now ?? Date.now() });
  out(json ? JSON.stringify(rows) : formatFleetTable(rows, deps.now ?? Date.now()));
  return 0;
}
if (isEntry(import.meta.url)) {
  try { process.exitCode = await main(); }
  catch (error) { console.error(`fleet-status: ${error.message}`); process.exitCode = 1; }
}
