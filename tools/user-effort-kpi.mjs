#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isEntry } from './is-entry.mjs';

const DAY_MS = 86_400_000;
const MIN_TRANSCRIPT_BYTES = 2 * 1024;
const EXCLUDED_USER_PREFIX = /^(?:<command-name|<local-command|<system-reminder|<task-notification|Stop hook feedback:|\[Request interrupted)/;
const KICK_PATTERN = /すすめて|つづけて|続けて|これ|この先|どうしたら|はい|した|できた|押した|まーじ|マージした|終わった|どうなった/;
const HANDOFF_PATTERN = /してください|クリック|貼り付け|押して|開いて|ダブルクリック|ログインして/;

function defaultHome() {
  return process.env.ORGIAST_HOME || process.env.USERPROFILE || process.cwd().match(/^(\/mnt\/[a-z]\/Users\/[^/]+)/i)?.[1] || os.homedir();
}

function readJsonl(file) {
  try {
    return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
  } catch { return []; }
}

function textContent(event) {
  const content = event?.message?.content ?? event?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((block) => block?.type === 'text' && typeof block.text === 'string').map((block) => block.text).join('\n');
}

function eventTime(event) {
  const value = event?.timestamp ?? event?.ts ?? event?.createdAt;
  const parsed = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function transcriptFiles(projectsDir, since, fsApi = fs) {
  const files = [];
  let projects = [];
  try { projects = fsApi.readdirSync(projectsDir, { withFileTypes: true }); } catch { return files; }
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const dir = path.join(projectsDir, project.name);
    let entries = [];
    try { entries = fsApi.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const file = path.join(dir, entry.name);
      try {
        const stat = fsApi.statSync(file);
        if (stat.size > MIN_TRANSCRIPT_BYTES && stat.mtimeMs >= since) files.push(file);
      } catch {}
    }
  }
  return files;
}

function rewriteStopCount(home, since) {
  const legacyCandidates = readJsonl(path.join(home, '.claude', 'handoff-ledger.jsonl'))
    .filter((row) => row.reason === 'stop_hook_active')
    .map((row) => eventTime(row)).filter((ts) => ts !== null && ts >= since).sort((a, b) => a - b);
  let legacyCount = 0;
  let clusterEnd = -Infinity;
  for (const ts of legacyCandidates) {
    // 旧ゲートが同じ発火を複数行に残すため、legacy 台帳内の 2 秒以内の記録を一つに丸める。
    if (ts - clusterEnd > 2_000) legacyCount += 1;
    clusterEnd = ts;
  }

  const runnerBySession = new Map();
  for (const row of readJsonl(path.join(home, '.claude', 'stop-gate-runner-ledger.jsonl'))) {
    const sessionId = typeof row.sessionId === 'string' ? row.sessionId : '';
    const ts = eventTime(row);
    if (!sessionId || sessionId.startsWith('e2e') || sessionId.startsWith('live') || ts === null) continue;
    if (!runnerBySession.has(sessionId)) runnerBySession.set(sessionId, []);
    runnerBySession.get(sessionId).push({ ...row, ts });
  }

  let runnerCount = 0;
  for (const rows of runnerBySession.values()) {
    rows.sort((a, b) => a.ts - b.ts);
    let previousWasBlock = false;
    for (const row of rows) {
      // rewrite_stop は「同一ターンの連続 block の 2 件目以降」で固定する。
      // KPI の時系列比較を壊さないため、skipped / retry-cap は連続を切らない。
      if (row.verdict === 'block') {
        if (previousWasBlock && row.ts >= since) runnerCount += 1;
        previousWasBlock = true;
      } else if (row.verdict === 'pass') {
        previousWasBlock = false;
      }
    }
  }

  return legacyCount + runnerCount;
}

function defaultManualMerges({ since, cwd }) {
  const result = spawnSync('gh', ['pr', 'list', '--state', 'merged', '--limit', '50', '--json', 'mergedBy,mergedAt'], { cwd, encoding: 'utf8' });
  if (result.error || result.status !== 0) return null;
  try {
    return JSON.parse(result.stdout).filter((pr) => Date.parse(pr.mergedAt) >= since && pr.mergedBy?.login !== 'github-actions').length;
  } catch { return null; }
}

export function collectUserEffortKpi({ days = 7, home = defaultHome(), now = Date.now(), cwd = process.cwd(), manualMerges = defaultManualMerges } = {}) {
  const since = now - days * DAY_MS;
  const files = transcriptFiles(path.join(home, '.claude', 'projects'), since);
  let humanTurns = 0;
  let kickTurns = 0;
  let charsRead = 0;
  let longTurns = 0;
  let handoffs = 0;
  for (const file of files) {
    for (const event of readJsonl(file)) {
      const text = textContent(event);
      if (!text || event.isSidechain === true) continue;
      if (event.type === 'user' && !EXCLUDED_USER_PREFIX.test(text.trimStart())) {
        humanTurns += 1;
        const compact = text.trim();
        if (compact.length <= 40 && KICK_PATTERN.test(compact)) kickTurns += 1;
      }
      if (event.type === 'assistant') {
        charsRead += text.length;
        if (text.split(/\r?\n/).length > 10) longTurns += 1;
        if (HANDOFF_PATTERN.test(text)) handoffs += 1;
      }
    }
  }
  const sessions = files.length;
  const followupsPerSession = sessions ? (humanTurns - sessions) / sessions : 0;
  let manualMergeCount = null;
  try { manualMergeCount = manualMerges({ since, cwd }); } catch {}
  return {
    days, sessions, human_turns: humanTurns,
    followups_per_session: Number(followupsPerSession.toFixed(1)),
    kick_turns: kickTurns, rewrite_stops: rewriteStopCount(home, since),
    chars_read: charsRead, long_turns: longTurns, handoffs,
    manual_merges: Number.isFinite(manualMergeCount) ? manualMergeCount : null,
  };
}

const GOALS = {
  sessions: '≤18', human_turns: '≤83', followups_per_session: '≤1.2', kick_turns: '≤24',
  rewrite_stops: '≤66', chars_read: '≤128k', long_turns: '≤67', handoffs: '—', manual_merges: '0',
};

export function formatUserEffortKpi(kpi) {
  const labels = {
    sessions: 'sessions', human_turns: 'human_turns', followups_per_session: 'followups_per_session',
    kick_turns: 'kick_turns', rewrite_stops: 'rewrite_stops', chars_read: 'chars_read',
    long_turns: 'long_turns', handoffs: 'handoffs', manual_merges: 'manual_merges',
  };
  const lines = [`## User effort KPI（直近 ${kpi.days} 日）`, '', '| 指標 | 実績 | 目標 |', '|---|---:|---:|'];
  for (const key of Object.keys(labels)) {
    const value = kpi[key] === null ? 'n/a' : key === 'followups_per_session' ? `${kpi[key].toFixed(1)}/session` : kpi[key].toLocaleString('en-US');
    lines.push(`| ${labels[key]} | ${value} | ${GOALS[key]} |`);
  }
  return `${lines.join('\n')}\n`;
}

export function summarizeUserEffortKpi(kpi) {
  const merge = kpi.manual_merges === null ? 'n/a' : kpi.manual_merges;
  return [
    `[user effort KPI / ${kpi.days}日] sessions ${kpi.sessions}, human ${kpi.human_turns}, followups ${kpi.followups_per_session.toFixed(1)}/session`,
    `kick ${kpi.kick_turns}/24, rewrite stops ${kpi.rewrite_stops}/66, chars ${kpi.chars_read.toLocaleString('en-US')}/128k`,
    `long turns ${kpi.long_turns}, handoffs ${kpi.handoffs}, manual merges ${merge}/0`,
  ].join('\n');
}

export function parseArgs(argv) {
  let days = 7;
  let json = false;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--json') json = true;
    else if (argv[i] === '--days') {
      days = Number(argv[++i]);
      if (!Number.isInteger(days) || days <= 0) throw new Error('--days は正の整数で指定してください');
    } else throw new Error(`不明な引数: ${argv[i]}`);
  }
  return { days, json };
}

if (isEntry(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const kpi = collectUserEffortKpi({ days: options.days });
    process.stdout.write(options.json ? `${JSON.stringify(kpi, null, 2)}\n` : formatUserEffortKpi(kpi));
  } catch (error) {
    console.error(`user-effort-kpi: ${error.message}`);
    process.exitCode = 1;
  }
}
