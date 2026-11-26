#!/usr/bin/env node
// 委譲率ウォッチドッグ: 毎日1回、直近24hの Claude 使用量と安いAI実作業件数を集計し、
// 閾値を超えたら kim-inbox へ info を積む + 次回 auto-session 用の根本修正起票を書く。
// Discord DM は送らず、結果を ~/.claude/delegation-ratio-watch.json に保存する。
//
// 閾値:
//   - 代替されなかった deferred ≥ 10
//   - quota_wait 中の呼び出し ≥ 50
//   - 安いAI実作業 < 10件/日 かつ Claude Opus 比率 > 70%
//
// Claude 重み付き消費 = Opus=5, Sonnet=3, Haiku=1 × (input + 1.25*cache_write + 0.1*cache_read + 5*output)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { isEntry } from './is-entry.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
const OPUS_WEIGHT = 5;
const SONNET_WEIGHT = 3;
const HAIKU_WEIGHT = 1;

// モデル名 → 重み
const MODEL_WEIGHTS = Object.freeze({
  'claude-opus-5-5': OPUS_WEIGHT, 'claude-opus-5': OPUS_WEIGHT, 'claude-opus-5.5': OPUS_WEIGHT, 'claude-opus': OPUS_WEIGHT,
  opus: OPUS_WEIGHT,
  'claude-sonnet-5-5': SONNET_WEIGHT, 'claude-sonnet-5': SONNET_WEIGHT, 'claude-sonnet-5.5': SONNET_WEIGHT,
  'claude-sonnet': SONNET_WEIGHT, sonnet: SONNET_WEIGHT, 'claude-3.7-sonnet': SONNET_WEIGHT, 'claude-3.5-sonnet': SONNET_WEIGHT, 'claude-4-sonnet': SONNET_WEIGHT,
  'claude-haiku-5-5': HAIKU_WEIGHT, 'claude-haiku-5': HAIKU_WEIGHT, 'claude-haiku-5.5': HAIKU_WEIGHT, 'claude-haiku': HAIKU_WEIGHT,
  haiku: HAIKU_WEIGHT, 'claude-3.5-haiku': HAIKU_WEIGHT, 'claude-3-haiku': HAIKU_WEIGHT,
  'claude-fable-5-2': SONNET_WEIGHT, fable: SONNET_WEIGHT, 'claude-fable': SONNET_WEIGHT,
});
const OPUS_NAMES = new Set(['claude-opus-5-5', 'claude-opus-5', 'claude-opus-5.5', 'claude-opus', 'opus']);

function weightFor(model) {
  if (!model) return 0;
  return MODEL_WEIGHTS[String(model).toLowerCase()] || 0;
}
function isOpusModel(rmodel) {
  return OPUS_NAMES.has(String(rmodel || '').toLowerCase());
}

// usage フィールドを flat/ネスト両対応で取り出す
function usageField(row, key, keyAlt) {
  const msg = row.message;
  if (msg && msg.usage && typeof msg.usage === 'object') {
    const v = msg.usage[key];
    if (v !== undefined && v !== null) return Number(v);
  }
  return Number(row[key] || row[keyAlt] || 0);
}

// モデル名を flat/ネスト両対応で取り出す
function extractModel(row) {
  if (row.message && row.message.model) return String(row.message.model);
  if (row.model) return String(row.model);
  return '';
}

// Claude 重み付き消費トークン = (input + 1.25*cache_write + 0.1*cache_read + 5*output) × 重み
export function weightedTokens(row) {
  const model = extractModel(row);
  const w = weightFor(model);
  if (!w) return 0;
  const inp = usageField(row, 'input_tokens', 'inputTokens');
  const out = usageField(row, 'output_tokens', 'outputTokens');
  const cw = usageField(row, 'cache_creation_input_tokens', 'cacheCreationInputTokens');
  const cr = usageField(row, 'cache_read_input_tokens', 'cacheReadInputTokens');
  return w * (inp + 1.25 * cw + 0.1 * cr + 5 * out);
}

// 会話本文を読まず、usage と model 名だけを抽出する。
// ネスト形式（row.message.model / row.message.usage.input_tokens）と
// flat 形式（row.model / row.input_tokens）の両方に対応。
// message.id + requestId で重複排除。
function extractUsageFromProjectJsonl(file, since) {
  const rows = [];
  const seen = new Set();
  try {
    const text = fs.readFileSync(file, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      if (!row || typeof row !== 'object') continue;
      const model = extractModel(row);
      if (!model) continue;
      const t = Number(row.timestamp) || Date.parse(row.timestamp || row.t || row.ts || row.created_at);
      if (!Number.isFinite(t) || t < since) continue;
      // message.id + requestId で重複排除
      const msgId = (row.message && row.message.id) ? String(row.message.id) : '';
      const reqId = row.requestId ? String(row.requestId) : '';
      const dedupKey = `${msgId}|${reqId}`;
      if (dedupKey !== '|' && seen.has(dedupKey)) continue;
      if (dedupKey !== '|') seen.add(dedupKey);
      rows.push(row);
    }
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  return rows;
}

// projects 配下を再帰的に走査し、.jsonl ファイルを収集。
// mtime が since より古いファイルは飛ばす。
function projectJsonlFiles(home, since) {
  const base = path.join(home, '.claude', 'projects');
  const results = [];
  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        try {
          const stat = fs.statSync(full);
          if (stat.mtimeMs >= since) results.push(full);
        } catch {}
      }
    }
  }
  try { walk(base); } catch {}
  return results;
}

export function compute({ home = os.homedir(), now = Date.now(), executorUsageFile, projectFiles } = {}) {
  const since = now - DAY_MS;
  const usageFile = executorUsageFile || path.join(home, '.claude', 'executor-usage.jsonl');

  // 1. executor-usage.jsonl から安いAIの実作業と deferred を集計
  let cheapWorkCount = 0;
  let deferredNoFallback = 0;
  let deferredAllBackendsFailed = 0;
  const executorRows = [];
  try {
    for (const line of fs.readFileSync(usageFile, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      if (!row || typeof row !== 'object') continue;
      const t = Number(row.t) || Date.parse(row.t || row.ts);
      if (!Number.isFinite(t) || t < since) continue;
      executorRows.push(row);
      // 安いAI実作業 (Claude 以外で out > 200, status ok)
      if (row.provider && !/^claude/i.test(String(row.provider)) && row.status === 'ok'
        && (Number(row.out) || Number(row.outputChars) || 0) > 200) {
        cheapWorkCount++;
      }
      // deferred で代替されなかった
      if (row.status === 'deferred') {
        if (row.fallbackSkipped === 'no_fallback_flag') deferredNoFallback++;
        else if (row.fallbackSkipped === 'all_backends_failed') deferredAllBackendsFailed++;
      }
    }
  } catch (e) { if (e.code !== 'ENOENT') throw e; }

  // 2. プロジェクト JSONL から Claude 使用量を集計（会話本文は読まない）
  let totalWeighted = 0;
  let opusWeighted = 0;
  let totalRows = 0;
  const files = projectFiles || projectJsonlFiles(home, since);
  for (const file of files) {
    try {
      for (const row of extractUsageFromProjectJsonl(file, since)) {
        const w = weightedTokens(row);
        totalWeighted += w;
        const model = extractModel(row);
        if (isOpusModel(model)) opusWeighted += w;
        totalRows++;
      }
    } catch (e) { if (e.code !== 'ENOENT') console.error(`[delegation-ratio-watch] ${file}: ${e.message}`); }
  }

  // 3. quota_wait 中の呼び出し — lane-health.json から quota_wait プロバイダを特定
  const quotaWaitWindows = new Map();
  const quotaWaitUnknownSince = [];
  try {
    const lh = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'lane-health.json'), 'utf8').replace(/^﻿/, ''));
    for (const [p, s] of Object.entries(lh?.lanes || {})) {
      if (s?.reason !== 'quota_wait' || Number(s?.until) <= now) continue;
      const provider = String(p).toLowerCase();
      const startedAt = Number(s?.since) || Date.parse(s?.since || s?.probedAt);
      if (Number.isFinite(startedAt)) quotaWaitWindows.set(provider, { since: startedAt, until: Number(s.until) });
      // 開始時刻なしの旧データは過去の正常呼出しを誤算入するため、安全側で数えない。
      else quotaWaitUnknownSince.push(provider);
    }
  } catch {}
  let quotaWaitCalls = 0;
  for (const row of executorRows) {
    const window = row.provider && quotaWaitWindows.get(String(row.provider).toLowerCase());
    if (!window) continue;
    const t = Number(row.t) || Date.parse(row.t || row.ts);
    if (Number.isFinite(t) && t >= window.since && t <= window.until) quotaWaitCalls++;
  }

  // 4. 判断
  const opusRatio = totalWeighted > 0 ? opusWeighted / totalWeighted : 0;
  const cheapLow = cheapWorkCount < 10;
  const opusDominant = opusRatio > 0.7;
  const deferredHigh = deferredNoFallback >= 10;
  const quotaWaitHigh = quotaWaitCalls >= 50;
  const alert = deferredHigh || quotaWaitHigh || (cheapLow && opusDominant);

  const result = {
    t: new Date(now).toISOString(),
    window: { since: new Date(since).toISOString(), until: new Date(now).toISOString() },
    claude: { totalWeighted, opusWeighted, opusRatio: Math.round(opusRatio * 1000) / 10, totalRows },
    cheapAi: { workCount: cheapWorkCount },
    deferred: { noFallback: deferredNoFallback, allBackendsFailed: deferredAllBackendsFailed },
    quotaWaitCalls,
    providers: [...quotaWaitWindows.keys(), ...quotaWaitUnknownSince],
    alert,
    reasons: [
      deferredHigh && `代替されなかった deferred が ${deferredNoFallback} 件（閾値 10）`,
      quotaWaitHigh && `quota_wait 中の呼出しが ${quotaWaitCalls} 件（閾値 50）`,
      ...quotaWaitUnknownSince.map(provider => `${provider} の quota_wait 開始時刻が不明なため呼出し数から除外`),
      cheapLow && opusDominant && `安いAI実作業 ${cheapWorkCount} 件/日（閾値 10）かつ Claude Opus 比率 ${Math.round(opusRatio * 100)}%（閾値 70%）`,
    ].filter(Boolean),
  };
  return result;
}

// Duplicate scheduled tasks/readers can briefly deny replacement on Windows.
// Retry only rename: keep the previous JSON intact and never replay delivery.
// 上限 8 回・1回最大 2 秒・合計約 9 秒（100ms×2^attempt、capped at 2000ms）。
function saveJson(file, value, { fsImpl = fs, sleepImpl = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) } = {}) {
  const pid = process.pid;
  const tmp = `${file}.${pid}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    fsImpl.mkdirSync(path.dirname(file), { recursive: true });
    fsImpl.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
    for (let attempt = 0; ; attempt++) {
      try { fsImpl.renameSync(tmp, file); break; }
      catch (error) {
        if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || attempt >= 8) {
          console.error(`[saveJson] rename failed after ${attempt} retries: ${error.code} ${error.message}`);
          throw error;
        }
        sleepImpl(Math.min(100 * (2 ** attempt), 2000));
      }
    }
  } finally { try { fsImpl.unlinkSync(tmp); } catch {} }
  return file;
}

export function saveResult(result, home = os.homedir(), deps) {
  return saveJson(path.join(home, '.claude', 'delegation-ratio-watch.json'), result, deps);
}

// kim-inbox に送る本文を組み立てる
export function buildInboxText(result) {
  return [
    '【委譲率異常】直近24時間の委譲率が閾値超過',
    `起きたこと:`,
    ...result.reasons.map(r => `- ${r}`),
    `Claude Opus 比率: ${result.claude.opusRatio}% / 安いAI実作業: ${result.cheapAi.workCount} 件`,
    `代替されなかった deferred: ${result.deferred.noFallback} 件 / quota_wait 中の呼出し: ${result.quotaWaitCalls} 件`,
    `判断してほしいこと: 不要（Claude が自動で修正を起票済み）`,
    `返事の例: 返事不要`,
  ].join('\n');
}

// kim-inbox に info を積む
export function notifyInbox(result, home = os.homedir(), execImpl = execFileSync) {
  if (!result.alert) return null;
  const selfDir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
  const cli = path.join(selfDir, 'kim-inbox.mjs');
  if (!fs.existsSync(cli)) {
    console.error('[delegation-ratio-watch] kim-inbox CLI not found.');
    return null;
  }
  const text = buildInboxText(result);
  const dateKey = `delegation-ratio-${new Date().toISOString().slice(0, 10)}`;
  const bodyFile = path.join(home, '.claude', 'delegation-ratio-watch', `inbox-body-${dateKey}.txt`);
  try { fs.mkdirSync(path.dirname(bodyFile), { recursive: true }); } catch {}
  fs.writeFileSync(bodyFile, text, 'utf8');
  try {
    const args = [cli, '--add', '--body-file', bodyFile, '--kind', 'info', '--source', 'delegation-ratio-watch', '--key', dateKey];
    // 異常の深刻度が高い（deferred ≥ 10 かつ quota_wait ≥ 50）なら urgent
    if (result.deferred.noFallback >= 10 && result.quotaWaitCalls >= 50) args.push('--urgent');
    execImpl(process.execPath, args, { encoding: 'utf8', windowsHide: true, timeout: 30000 });
    return text;
  } catch (e) {
    console.error(`[delegation-ratio-watch] inbox delivery failed: ${e.message}`);
    return null;
  } finally {
    try { fs.unlinkSync(bodyFile); } catch {}
  }
}

// 次回 auto-session 用の根本修正起票
export function writeFixTicket(result, home = os.homedir(), deps) {
  if (!result.alert) return null;
  const fixFile = path.join(home, '.claude', 'delegation-ratio-watch-fix.json');
  const fix = {
    generatedAt: new Date().toISOString(),
    alert: result.alert,
    reasons: result.reasons,
    suggestedFixes: [
      'lane-doctor --probe で全レーン現状を確認',
      'quota_wait レーンの reset 時刻を確認し、復帰後は自動で戻',
      'codex-do の --no-fallback 不必要付与を grep で調査・除去',
      '復帰まで llm-fallback の quota_wait スキップに任せる',
    ],
  };
  return saveJson(fixFile, fix, deps);
}

if (isEntry(import.meta.url)) {
  const home = process.env.ORGIAST_HOME || os.homedir();
  const now = Date.now();
  const dryRun = process.argv.includes('--dry-run');
  const result = compute({ home, now });
  // saveResult が EPERM で失敗しても exit 1 にしない（次回のタスク起動で再試行）。
  try { saveResult(result, home); } catch (e) { console.error(`[delegation-ratio-watch] saveResult skipped: ${e.message}`); }
  if (result.alert) {
    if (dryRun) {
      console.log('【kim-inbox に積む本文（--dry-run）】');
      console.log(buildInboxText(result));
      console.log(`\nClaude totalRows=${result.claude.totalRows} totalWeighted=${result.claude.totalWeighted} opusRatio=${result.claude.opusRatio}%`);
    } else {
      const ok = notifyInbox(result, home);
      if (!ok) process.exitCode = 1;
      try { writeFixTicket(result, home); } catch (e) { console.error(`[delegation-ratio-watch] writeFixTicket skipped: ${e.message}`); }
    }
    for (const r of result.reasons) console.error(`[delegation-ratio-watch] 🔴 ${r}`);
  } else {
    console.error(`[delegation-ratio-watch] ✅ 正常（Claude Opus ${result.claude.opusRatio}% / 安いAI ${result.cheapAi.workCount} 件 / totalRows=${result.claude.totalRows}）`);
  }
  console.log(JSON.stringify(result));
}
