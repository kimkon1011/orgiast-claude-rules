#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseEnvText } from './env-kv.mjs';
import { isEntry } from './is-entry.mjs';

const GET_TIMEOUT_MS = 30_000;
const POST_TIMEOUT_MS = 20_000;

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

export function shouldRunWatch(markerExists) {
  return markerExists === true;
}

export function shouldNotify(prev, curr) {
  if (prev?.done === true) return false;
  if (!prev) return true;
  return ['applied', 'stale', 'unreported'].some((key) => Number(prev[key]) !== Number(curr[key]));
}

export function buildWatchMessage(curr, staleNames = []) {
  if (curr.stale === 0 && curr.unreported === 0) return `✅ 対話ループ: 全${curr.applied}台が適用済`;
  const lines = [`対話ループ展開: 適用済 ${curr.applied}台 / 未適用・旧版 ${curr.stale}台 / 未報告 ${curr.unreported}台`];
  const names = staleNames.slice(0, 10);
  if (names.length) lines.push(`未適用・旧版: ${names.join(' / ')}`);
  return lines.join('\n');
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

async function runWatch({ home, fleetEnv, fetchImpl, stdout, stderr, now }) {
  const claudeDir = path.join(home, '.claude');
  if (!shouldRunWatch(fs.existsSync(path.join(claudeDir, 'interaction-rollout-watch')))) return;

  const stateFile = path.join(claudeDir, 'interaction-rollout-state.json');
  const prev = readJson(stateFile);
  if (prev?.done === true) return;

  const costEnv = readEnv(path.join(claudeDir, 'cost-reporter.env'));
  const webhook = costEnv.DISCORD_COST_WEBHOOK || costEnv.COST_WEBHOOK || '';
  if (!webhook) {
    stderr('interaction-rollout: DISCORD_COST_WEBHOOK/COST_WEBHOOK 未設定のため投稿しません(~/.claude/cost-reporter.env)');
    return;
  }
  if (!fleetEnv.FLEET_SHEET_URL || !fleetEnv.FLEET_SHEET_TOKEN) {
    stderr('interaction-rollout: FLEET_SHEET_URL/TOKEN 未設定のため実行しません(~/.claude/fleet-sheet.env)');
    return;
  }

  const rows = await fetchRolloutRows({ sheetUrl: fleetEnv.FLEET_SHEET_URL, token: fleetEnv.FLEET_SHEET_TOKEN, fetchImpl });
  const result = buildRollout(rows);
  const curr = {
    applied: result.summary.applied,
    stale: result.summary.outdated,
    unreported: result.summary.unreported,
    done: result.summary.outdated === 0 && result.summary.unreported === 0,
  };
  if (!shouldNotify(prev, curr)) {
    stdout('skip:前回と差分なし');
    return;
  }
  const staleNames = result.rows.filter((row) => row.category === 'outdated')
    .map((row) => String(row.label ?? '').trim() || String(row.pcName ?? '').trim() || '(名称未設定)');
  const response = await fetchImpl(webhook, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: buildWatchMessage(curr, staleNames) }),
    signal: AbortSignal.timeout(POST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Discord POST HTTP ${response.status}`);
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(stateFile, `${JSON.stringify({ ...curr, notifiedAt: now().toISOString() }, null, 2)}\n`);
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
  now = () => new Date(),
} = {}) {
  const home = env.ORGIAST_HOME || os.homedir();
  const fleetEnv = readEnv(path.join(home, '.claude', 'fleet-sheet.env'));
  if (argv.includes('--watch')) {
    try {
      await runWatch({ home, fleetEnv, fetchImpl, stdout, stderr, now });
    } catch (error) {
      stderr(`interaction-rollout: 取得・投稿できませんでした (${error?.message || error?.name || 'error'})`);
    }
    return;
  }
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
