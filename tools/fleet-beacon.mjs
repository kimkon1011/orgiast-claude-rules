#!/usr/bin/env node
// fleet ビーコン: converge の結果（ステップの ok/skip/fail）と最終 poll を GAS の fleet-beacon シートへ送る。
// 送信は fail-open（例外を投げない）。fleet-status.mjs と fleet-mail.mjs が fetchBeacons を import する。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntry } from './is-entry.mjs';
import { parseEnvText } from './env-kv.mjs';
import { machineIdentity } from './machine-identity.mjs';
import { redactSecrets } from './fleet-agent.mjs';
import { resolveFleetLabel } from './lib/fleet-label.mjs';

const ownRepo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const STATUS_MAP = { OK: 'ok', NOTICE: 'skip', NG: 'fail' };
const REASON_LIMIT = 120;
const ABSOLUTE_PATH = /(?:[A-Za-z]:\\[^\s"']+|\/(?:Users|home|mnt)\/[^\s"']+)/g;

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return fallback; return fallback; }
}
function envFile(file) {
  try { return parseEnvText(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}
// reason は 1 行・120 字以内・秘密と絶対パスを除去する。
export function sanitizeReason(value) {
  const text = redactSecrets(String(value ?? '')).replace(ABSOLUTE_PATH, '[path]').replace(/\s+/g, ' ').trim();
  return text.slice(0, REASON_LIMIT);
}
function domainOf(email) {
  const match = String(email ?? '').match(/@([^\s@]+)$/);
  return match ? match[1] : '';
}
// account はドメインのみ。メールのローカル部・パスは絶対に入れない。
export function beaconAccount({ label, pcMap, identity }) {
  const entry = pcMap && typeof pcMap === 'object' ? pcMap[label] : null;
  const fromMap = domainOf(entry?.account);
  if (fromMap) return fromMap;
  return domainOf(identity?.gitEmail);
}
// mobile-standby ステップの reason に「待機数/目標」を追記する。待機数が取れなければ「待機数不明」。
export function mobileStandbySuffix(home, now = Date.now()) {
  let waiting = null;
  let target = 3;
  try {
    const state = readJson(path.join(home, '.claude', 'mobile-sessions-state.json'), null);
    if (state && Number.isInteger(state.waiting) && state.waiting >= 0 && now - state.updatedAt <= 30000 && now >= state.updatedAt) waiting = state.waiting;
  } catch { /* 状態ファイルが無い/壊れている場合は不明扱い */ }
  try {
    const config = readJson(path.join(home, '.claude', 'mobile-sessions.json'), null);
    const count = Number(config?.count);
    if (Number.isInteger(count) && count >= 1 && count <= 10) target = count;
  } catch { /* 既定 3 */ }
  return `${waiting === null ? '待機数不明' : waiting}/${target}`;
}
export function buildBeacon({ home, label, results = [], now = Date.now(), pcMap, identity } = {}) {
  const resolvedLabel = label || resolveFleetLabel(home, identity ?? machineIdentity());
  const steps = results.map((result) => {
    const id = String(result?.item?.id ?? result?.id ?? '');
    const status = STATUS_MAP[result?.status] || 'skip';
    let reason = sanitizeReason(result?.reason ?? '');
    if (id === 'mobile-standby') {
      const suffix = mobileStandbySuffix(home, now);
      reason = sanitizeReason(reason ? `${reason} ${suffix}` : suffix);
    }
    return { id, status, reason };
  });
  const failing = steps.filter((step) => step.status === 'fail').map((step) => step.id);
  const pollAt = String(readJson(path.join(home, '.claude', '.fleet-mail-last-poll.json'), {})?.at || '');
  return {
    label: resolvedLabel,
    account: beaconAccount({ label: resolvedLabel, pcMap, identity: identity ?? machineIdentity() }),
    reportedAt: new Date(now).toISOString(),
    steps,
    failing,
    pollAt
  };
}
// 送信は絶対に例外を投げない。env 未設定は skip、応答に beacon が無ければ「GAS 未デプロイ」。
export async function sendBeacon(beacon, { home, fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  try {
    const config = envFile(path.join(home, '.claude', 'fleet-sheet.env'));
    if (!config.FLEET_SHEET_URL || !config.FLEET_SHEET_TOKEN) return { ok: false, skipped: true, reason: 'unconfigured' };
    const response = await fetchImpl(config.FLEET_SHEET_URL, {
      method: 'POST', headers: { 'content-type': 'application/json' }, redirect: 'follow',
      body: JSON.stringify({ ...beacon, kind: 'fleet-beacon', token: config.FLEET_SHEET_TOKEN }),
      signal: AbortSignal.timeout(Math.max(1, Math.ceil(timeoutMs)))
    });
    if (!response.ok) return { ok: false, reason: `HTTP ${response.status}` };
    const result = await response.json();
    if (result?.ok !== true) return { ok: false, reason: String(result?.error || 'invalid response') };
    if (!result.beacon) return { ok: false, reason: 'GAS 未デプロイ(beacon handler なし)' };
    return { ok: true, beacon: result.beacon };
  } catch (error) {
    return { ok: false, reason: sanitizeReason(error?.message || error) };
  }
}
// 戻り値の形は固定（fleet-mail.mjs / fleet-status.mjs が依存する）。失敗時も beacons/serverPolls を必ず返す。
export async function fetchBeacons({ home, fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  const empty = { ok: false, beacons: [], serverPolls: {} };
  try {
    const config = envFile(path.join(home, '.claude', 'fleet-sheet.env'));
    if (!config.FLEET_SHEET_URL || !config.FLEET_SHEET_TOKEN) return { ...empty, reason: 'unconfigured' };
    const response = await fetchImpl(config.FLEET_SHEET_URL, {
      method: 'POST', headers: { 'content-type': 'application/json' }, redirect: 'follow',
      body: JSON.stringify({ kind: 'fleet-beacon-list', token: config.FLEET_SHEET_TOKEN }),
      signal: AbortSignal.timeout(Math.max(1, Math.ceil(timeoutMs)))
    });
    if (!response.ok) return { ...empty, reason: `HTTP ${response.status}` };
    const result = await response.json();
    if (result?.ok !== true) return { ...empty, reason: String(result?.error || 'invalid response') };
    if (!Array.isArray(result.beacons)) return { ...empty, reason: 'GAS 未デプロイ(beacon handler なし)' };
    const beacons = result.beacons.map((beacon) => {
      let steps = beacon?.steps;
      if (typeof steps === 'string') { try { steps = JSON.parse(steps); } catch { steps = []; } }
      if (!Array.isArray(steps)) steps = [];
      const failing = Array.isArray(beacon?.failing) ? beacon.failing
        : String(beacon?.failing ?? '').split(',').map((id) => id.trim()).filter(Boolean);
      return {
        label: String(beacon?.label ?? ''), account: String(beacon?.account ?? ''), reportedAt: String(beacon?.reportedAt ?? ''),
        steps, failing, pollAt: String(beacon?.pollAt ?? ''), serverPollAt: String(beacon?.serverPollAt ?? '')
      };
    });
    const serverPolls = result.serverPolls && typeof result.serverPolls === 'object' && !Array.isArray(result.serverPolls) ? result.serverPolls : {};
    return { ok: true, beacons, serverPolls };
  } catch (error) {
    return { ...empty, reason: sanitizeReason(error?.message || error) };
  }
}
export async function main(argv = process.argv.slice(2), deps = {}) {
  const home = deps.home ?? process.env.ORGIAST_HOME ?? os.homedir();
  const out = deps.stdout ?? console.log;
  const err = deps.stderr ?? console.error;
  const mode = argv.includes('--send') ? 'send' : argv.includes('--print') ? 'print' : null;
  if (!mode) { err('fleet-beacon: --send または --print を指定してください'); return 1; }
  const pcMap = deps.pcMap ?? readJson(path.join(ownRepo, 'fleet-pc-map.json'), {});
  if (mode === 'print') {
    const result = await fetchBeacons({ home, fetchImpl: deps.fetch });
    out(JSON.stringify(result, null, 2));
    return result.ok ? 0 : 1;
  }
  const beacon = buildBeacon({ home, results: deps.results ?? [], pcMap });
  const result = await sendBeacon(beacon, { home, fetchImpl: deps.fetch });
  out(JSON.stringify(result));
  return result.ok ? 0 : 1;
}
if (isEntry(import.meta.url)) {
  try { process.exitCode = await main(); }
  catch (error) { console.error(`fleet-beacon: ${redactSecrets(error.message)}`); process.exitCode = 1; }
}
