#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseEnvText } from './env-kv.mjs';
import { isEntry } from './is-entry.mjs';

export const DEFAULT_STALE_HOURS = 72;

export function evaluateRows(rows, { now = new Date(), staleHours = DEFAULT_STALE_HOURS } = {}) {
  const staleMs = staleHours * 60 * 60 * 1000;
  return rows.filter((row) => row && (row.hostname || row.pcName || row.label)).map((row) => {
    const checked = new Date(row.keyserveCheckedAt);
    const stale = !row.keyserveCheckedAt || !Number.isFinite(checked.getTime()) || now - checked > staleMs;
    const reason = stale ? '未確認' : row.keyserveAuth !== 'primary' ? (row.keyserveAuth || 'unset') : null;
    return reason ? {
      hostname: row.hostname || row.label || '不明',
      pcName: row.pcName || row.label || '不明',
      auth: row.keyserveAuth || 'unset',
      checkedAt: row.keyserveCheckedAt || null,
      reason,
    } : null;
  }).filter(Boolean);
}

function readEnv(file) {
  try { return parseEnvText(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

export async function runGate({ env = process.env, fetchFn = fetch, now = new Date() } = {}) {
  const home = env.ORGIAST_HOME || os.homedir();
  const config = readEnv(path.join(home, '.claude', 'fleet-sheet.env'));
  const url = env.FLEET_SHEET_URL || config.FLEET_SHEET_URL;
  const token = env.FLEET_SHEET_TOKEN || config.FLEET_SHEET_TOKEN;
  if (!url || !token) throw new Error('FLEET_SHEET_URL/TOKEN が未設定');
  const endpoint = new URL(url);
  endpoint.searchParams.set('token', token);
  const response = await fetchFn(endpoint, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`台帳取得 HTTP ${response.status}`);
  const payload = await response.json();
  if (!payload?.ok || !Array.isArray(payload.rows)) throw new Error(payload?.error || '台帳応答が不正');
  const staleHours = Number(env.ORGIAST_ROTATION_GATE_STALE_HOURS ?? DEFAULT_STALE_HOURS);
  if (!Number.isFinite(staleHours) || staleHours < 0) throw new Error('ORGIAST_ROTATION_GATE_STALE_HOURS が不正');
  return { ok: true, staleHours, blockers: evaluateRows(payload.rows, { now, staleHours }) };
}

function printHuman(result) {
  if (result.ok && result.blockers.length === 0) {
    console.log('全 PC が primary で認証済みです。legacy 削除ゲート: PASS');
    return;
  }
  console.error('legacy を削除するな: primary 未確認の PC が残っています。');
  for (const row of result.blockers || []) console.error(`- ${row.pcName} / ${row.hostname}: ${row.reason} (auth=${row.auth}, checkedAt=${row.checkedAt || 'なし'})`);
  if (result.error) console.error(`- 台帳取得失敗: ${result.error}`);
}

async function main() {
  const json = process.argv.includes('--json');
  let result;
  try { result = await runGate(); }
  catch (error) { result = { ok: false, staleHours: null, blockers: [], error: String(error?.message || error) }; }
  const passed = result.ok && result.blockers.length === 0;
  if (json) console.log(JSON.stringify({ ...result, passed })); else printHuman(result);
  if (!passed) process.exitCode = 1;
}

if (isEntry(import.meta.url)) await main();
