#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseEnvText } from './env-kv.mjs';
import { isEntry } from './is-entry.mjs';

const GET_TIMEOUT_MS = 30_000;

function readEnv(file) {
  try { return parseEnvText(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

function categoryOf(row) {
  const reportedAt = String(row?.reportedAt ?? '').trim();
  const interactionLoop = String(row?.interactionLoop ?? '').trim();
  if (!reportedAt || !interactionLoop) return 'unreported';
  if (interactionLoop.startsWith('適用済')) return 'applied';
  if (interactionLoop.startsWith('未適用') || interactionLoop.startsWith('旧版')) return 'outdated';
  return 'unreported';
}

function reportedTime(value) {
  const text = String(value ?? '').trim();
  const jst = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (jst) {
    const [, year, month, day, hour = '00', minute = '00', second = '00'] = jst;
    return Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour) - 9, Number(minute), Number(second));
  }
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? -Infinity : parsed;
}

export function buildRollout(rows) {
  const normalized = (Array.isArray(rows) ? rows : []).map((row, index) => ({
    ...row,
    category: categoryOf(row),
    _index: index,
  })).sort((a, b) => reportedTime(b.reportedAt) - reportedTime(a.reportedAt) || a._index - b._index)
    .map(({ _index, ...row }) => row);
  const summary = { applied: 0, outdated: 0, unreported: 0 };
  for (const row of normalized) summary[row.category] += 1;
  return { summary, rows: normalized };
}

export function formatRollout(result) {
  const { summary, rows } = result;
  const lines = [`対話ループ展開: 適用済 ${summary.applied}台 / 未適用・旧版 ${summary.outdated}台 / 未報告 ${summary.unreported}台`];
  for (const row of rows) {
    const name = String(row.label ?? '').trim() || String(row.pcName ?? '').trim() || '(名称未設定)';
    lines.push(`${name} | ${String(row.interactionLoop ?? '').trim() || '未報告'} | ${String(row.interactionSelftest ?? '').trim() || '未報告'} | ${String(row.reportedAt ?? '').trim() || '未報告'}`);
  }
  return lines.join('\n');
}

export async function fetchRolloutRows({ sheetUrl, token, fetchImpl = globalThis.fetch }) {
  const url = new URL(sheetUrl);
  url.searchParams.set('token', token);
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(GET_TIMEOUT_MS), redirect: 'follow' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const payload = await response.json();
  if (!payload?.ok) throw new Error(`doGetエラー${payload?.error ? `: ${payload.error}` : ''}`);
  if (!Array.isArray(payload.rows)) throw new Error('doGet応答に rows がありません');
  return payload.rows;
}

export async function runInteractionRollout({
  argv = process.argv.slice(2),
  env = process.env,
  fetchImpl = globalThis.fetch,
  stdout = console.log,
  stderr = console.error,
} = {}) {
  const home = env.ORGIAST_HOME || os.homedir();
  const fleetEnv = readEnv(path.join(home, '.claude', 'fleet-sheet.env'));
  if (!fleetEnv.FLEET_SHEET_URL || !fleetEnv.FLEET_SHEET_TOKEN) {
    stderr('interaction-rollout: FLEET_SHEET_URL/TOKEN 未設定のため実行しません(~/.claude/fleet-sheet.env)');
    return;
  }
  try {
    const rows = await fetchRolloutRows({ sheetUrl: fleetEnv.FLEET_SHEET_URL, token: fleetEnv.FLEET_SHEET_TOKEN, fetchImpl });
    const result = buildRollout(rows);
    stdout(argv.includes('--json') ? JSON.stringify(result, null, 2) : formatRollout(result));
  } catch (error) {
    stderr(`interaction-rollout: 取得できませんでした (${error?.message || error?.name || 'error'})`);
  }
}

if (isEntry(import.meta.url)) await runInteractionRollout();
