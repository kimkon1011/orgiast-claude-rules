#!/usr/bin/env node
// 毎日1台（推奨は000）で Cursor Models / Other Models の使用量を測り、
// 周期（既定: 2026-11-18〜12/18）の理想ペースと比べて追加回し／停止を決める。
// 画面の自動操作はしない。User API キーではダッシュボード％が取れないため、
// Team API キーがあればそれを使い、無ければ明示の％または前回値を使う。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isEntry } from './is-entry.mjs';
import {
  DEFAULT_CYCLE_END,
  DEFAULT_CYCLE_START,
  countCursorAgentRuns,
  cycleWindow,
  decideCursorPace,
  extractPlanPercents,
  formatPaceLine,
  writePaceOutputs,
  cursorUsagePaceTxtPath,
  readOwnerReport,
  findLastGoodFromState,
  hoursAgo,
  ownerReportPath,
} from './lib/cursor-usage-pace.mjs';

function argValue(args, name, fallback = '') {
  const i = args.indexOf(name);
  return i >= 0 ? String(args[i + 1] ?? fallback) : fallback;
}

function readCursorEnv(home) {
  const file = path.join(home, '.claude', 'cursor.env');
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return {}; }
  const out = {};
  for (const line of text.split(/\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

function firstKey(env, names) {
  for (const name of names) {
    const v = String(env[name] || '').trim();
    if (v) return { name, value: v };
  }
  return null;
}

async function tryOfficialUsage({ key, auth, url, method, body }) {
  const headers = { Accept: 'application/json', 'Content-Type': 'application/json' };
  if (auth === 'basic') headers.Authorization = `Basic ${Buffer.from(`${key}:`).toString('base64')}`;
  else headers.Authorization = `Bearer ${key}`;
  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.status, json };
}

export async function fetchCursorPlanUsage({
  home,
  env = process.env,
  fetchImpl = tryOfficialUsage,
} = {}) {
  const fileEnv = readCursorEnv(home);
  const merged = { ...fileEnv, ...env };
  const team = firstKey(merged, ['CURSOR_TEAM_API_KEY', 'CURSOR_ADMIN_API_KEY']);
  if (team) {
    try {
      const res = await fetchImpl({
        key: team.value,
        auth: 'basic',
        url: 'https://api.cursor.com/teams/spend',
        method: 'POST',
        body: { page: 1, pageSize: 25 },
      });
      const extracted = extractPlanPercents(res.json);
      if (res.status >= 200 && res.status < 300 && extracted) {
        return { ok: true, source: 'team-api', ...extracted };
      }
    } catch { /* fall through; never print the key or body */ }
  }
  const user = firstKey(merged, ['CURSOR_API_KEY']);
  if (user) {
    // Probe only documented / likely official endpoints. Session cookies are not used.
    const probes = [
      { url: 'https://api.cursor.com/v1/me/usage', method: 'GET', auth: 'bearer' },
      { url: 'https://api.cursor.com/v1/usage', method: 'GET', auth: 'bearer' },
    ];
    for (const probe of probes) {
      try {
        const res = await fetchImpl({ key: user.value, ...probe });
        const extracted = extractPlanPercents(res.json);
        if (res.status >= 200 && res.status < 300 && extracted) {
          return { ok: true, source: 'user-api', ...extracted };
        }
      } catch { /* keep going */ }
    }
  }
  return { ok: false, source: 'unavailable', reason: 'no-official-usage-api' };
}

export async function runCursorUsagePace({
  home = process.env.ORGIAST_HOME || os.homedir(),
  args = [],
  now = Date.now(),
  fetchPlanImpl,
} = {}) {
  const cycleStart = argValue(args, '--cycle-start', DEFAULT_CYCLE_START);
  const cycleEnd = argValue(args, '--cycle-end', DEFAULT_CYCLE_END);
  const cursorArg = argValue(args, '--cursor-models', '');
  const otherArg = argValue(args, '--other-models', '');
  const sourceArg = argValue(args, '--source', '');
  const { start } = cycleWindow({ cycleStart, cycleEnd });
  const local = countCursorAgentRuns(home, { sinceMs: start, untilMs: now });

  let cursorModelsPct = cursorArg === '' ? NaN : Number(cursorArg);
  let otherModelsPct = otherArg === '' ? NaN : Number(otherArg);
  let source = sourceArg;
  let onDemandUsed = args.includes('--on-demand');
  let decidedFillOverride = null; // null=auto, false=force-no-fill
  if (!Number.isFinite(cursorModelsPct) || !Number.isFinite(otherModelsPct)) {
    const fetched = await (fetchPlanImpl || fetchCursorPlanUsage)({ home });
    if (fetched?.ok) {
      cursorModelsPct = fetched.cursorModelsPct;
      otherModelsPct = fetched.otherModelsPct;
      onDemandUsed = onDemandUsed || Boolean(fetched.onDemandUsed);
      source = source || fetched.source;
    } else {
      source = source || fetched?.source || 'unavailable';
      // ④ Owner report fallback
      if (!Number.isFinite(cursorModelsPct) || !Number.isFinite(otherModelsPct)) {
        const owner = readOwnerReport(home);
        if (owner) {
          const ownerAt = Date.parse(owner.at);
          const elapsedH = Number.isFinite(ownerAt) ? hoursAgo(ownerAt, now) : 999;
          if (!Number.isFinite(ownerAt) || elapsedH > 168) { // 7日超 → 使わない
            source = !Number.isFinite(ownerAt) ? 'owner-report(at不正)' : 'owner-report(7d超)';
          } else {
            cursorModelsPct = owner.cursorModelsPct;
            otherModelsPct = owner.otherModelsPct;
            onDemandUsed = onDemandUsed || owner.onDemandUsed;
            const hLabel = elapsedH < 48 ? `${Math.round(elapsedH)}h前` : `${Math.round(elapsedH / 24)}d前`;
            source = `前回値(owner-report, ${hLabel})(推定)`;
            if (elapsedH > 48) decidedFillOverride = false; // 48h超 → fill しない
          }
        }
      }
      // ⑤ Carry-forward from state
      if (!Number.isFinite(cursorModelsPct) || !Number.isFinite(otherModelsPct)) {
        const lastGood = findLastGoodFromState(home);
        if (lastGood) {
          const lastGoodAt = Date.parse(lastGood.at);
          const elapsedH = Number.isFinite(lastGoodAt) ? hoursAgo(lastGoodAt, now) : 999;
          if (!Number.isFinite(lastGoodAt) || elapsedH > 168) {
            source = !Number.isFinite(lastGoodAt) ? 'carry-forward(at不正)' : 'carry-forward(7d超)';
          } else {
            cursorModelsPct = lastGood.cursorModelsPct;
            otherModelsPct = lastGood.otherModelsPct;
            onDemandUsed = onDemandUsed || Boolean(lastGood.onDemandUsed);
            const hLabel = elapsedH < 48 ? `${Math.round(elapsedH)}h前` : `${Math.round(elapsedH / 24)}d前`;
            source = `前回値(${lastGood.source}, ${hLabel})(推定)`;
            if (elapsedH > 48) decidedFillOverride = false; // 48h超 → fill しない
          }
        }
      }
    }
  }

  const decided = decideCursorPace({
    cursorModelsPct,
    otherModelsPct,
    now,
    onDemandUsed,
    cycleStart,
    cycleEnd,
  });
  // Apply fill override from staleness rules
  if (decidedFillOverride === false) decided.fill = false;
  const line = formatPaceLine({
    ...decided,
    now,
    cycleStart,
    cycleEnd,
    source,
    localCursorOk: local.ok,
  });
  const written = writePaceOutputs(home, {
    ...decided,
    now,
    cycleStart,
    cycleEnd,
    source,
    localCursorOk: local.ok,
    local,
    line,
  });
  let fillDispatch = null;
  try {
    const { dispatchCursorFill } = await import('./cursor-fill-dispatch.mjs');
    fillDispatch = dispatchCursorFill({ home });
  } catch (err) {
    console.error(`cursor-fill-dispatch failed: ${err?.message || err}`);
  }
  return { ...decided, ...written, local, source, path: written.txt, fillDispatch };
}

export async function main(args = process.argv.slice(2)) {
  const result = await runCursorUsagePace({ args });
  console.log(result.line);
  console.log(`書き出し: ${result.path}`);
  if (result.halt) console.error('従量課金に入りそうなため Cursor の追加利用を止めました');
  return 0;
}

if (isEntry(import.meta.url)) process.exitCode = await main();
