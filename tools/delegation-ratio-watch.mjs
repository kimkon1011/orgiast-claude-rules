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

// Claude 重み付き消費トークン = (input + 1.25*cache_write + 0.1*cache_read + 5*output) × 重み
export function weightedTokens(row) {
  const w = weightFor(row.model);
  if (!w) return 0;
  const inp = Number(row.input_tokens || row.inputTokens || row.input || 0);
  const out = Number(row.output_tokens || row.outputTokens || row.output || 0);
  const cw = Number(row.cache_creation_input_tokens || row.cacheCreationInputTokens || 0);
  const cr = Number(row.cache_read_input_tokens || row.cacheReadInputTokens || 0);
  return w * (inp + 1.25 * cw + 0.1 * cr + 5 * out);
}

// 会話本文を読まず、usage と model 名だけを抽出する。
function extractUsageFromProjectJsonl(file, since) {
  const rows = [];
  try {
    const text = fs.readFileSync(file, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      if (!row || typeof row !== 'object') continue;
      const t = Number(row.timestamp) || Date.parse(row.timestamp || row.t || row.ts || row.created_at || 0);
      if (!Number.isFinite(t) || t < since) continue;
      if (row.model) rows.push(row);
    }
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  return rows;
}

function projectJsonlDirs(home) {
  const base = path.join(home, '.claude', 'projects');
  const results = [];
  try {
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try {
        for (const f of fs.readdirSync(path.join(base, entry.name), { withFileTypes: true })) {
          if (f.isFile() && f.name.endsWith('.jsonl')) results.push(path.join(base, entry.name, f.name));
        }
      } catch {}
    }
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
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
      const t = Number(row.t) || Date.parse(row.t || row.ts || 0);
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
  const files = projectFiles || projectJsonlDirs(home);
  for (const file of files) {
    try {
      for (const row of extractUsageFromProjectJsonl(file, since)) {
        const w = weightedTokens(row);
        totalWeighted += w;
        if (isOpusModel(row.model)) opusWeighted += w;
        totalRows++;
      }
    } catch (e) { if (e.code !== 'ENOENT') console.error(`[delegation-ratio-watch] ${file}: ${e.message}`); }
  }

  // 3. quota_wait 中の呼び出し — lane-health.json から quota_wait プロバイダを特定
  const quotaWaitProviders = new Set();
  try {
    const lh = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'lane-health.json'), 'utf8').replace(/^﻿/, ''));
    for (const [p, s] of Object.entries(lh?.lanes || {})) {
      if (s?.reason === 'quota_wait' && Number(s?.until) > now) quotaWaitProviders.add(String(p).toLowerCase());
    }
  } catch {}
  let quotaWaitCalls = 0;
  for (const row of executorRows) {
    if (row.provider && quotaWaitProviders.has(String(row.provider).toLowerCase())) quotaWaitCalls++;
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
    providers: [...quotaWaitProviders],
    alert,
    reasons: [
      deferredHigh && `代替されなかった deferred が ${deferredNoFallback} 件（閾値 10）`,
      quotaWaitHigh && `quota_wait 中の呼出しが ${quotaWaitCalls} 件（閾値 50）`,
      cheapLow && opusDominant && `安いAI実作業 ${cheapWorkCount} 件/日（閾値 10）かつ Claude Opus 比率 ${Math.round(opusRatio * 100)}%（閾値 70%）`,
    ].filter(Boolean),
  };
  return result;
}

export function saveResult(result, home = os.homedir()) {
  const file = path.join(home, '.claude', 'delegation-ratio-watch.json');
  const tmp = `${file}.${Math.random().toString(16).slice(2)}.tmp`;
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(tmp, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 }); fs.renameSync(tmp, file); }
  finally { try { fs.unlinkSync(tmp); } catch {} }
  return file;
}

// kim-inbox に info を積む
export function notifyInbox(result, home = os.homedir()) {
  if (!result.alert) return null;
  // 自身の tools/ からの相対パス
  const selfDir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
  const cli = path.join(selfDir, 'kim-inbox.mjs');
  if (!fs.existsSync(cli)) {
    console.error('[delegation-ratio-watch] kim-inbox CLI not found.');
    return null;
  }
  const text = [
    '【安いAIレーン委譲率異常】',
    ...result.reasons.map(r => `- ${r}`),
    `Claude Opus 比率: ${result.claude.opusRatio}% / 安いAI実作業: ${result.cheapAi.workCount} 件`,
    `代替されなかった deferred: ${result.deferred.noFallback} 件`,
    `quota_wait 中の呼出し: ${result.quotaWaitCalls} 件`,
  ].join('\n');
  try {
    execFileSync(process.execPath, [cli, 'info', '--text', text, '--priority', 'high', '--source', 'delegation-ratio-watch', '--dedupe-key', `delegation-ratio-${new Date().toISOString().slice(0, 10)}`], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
    return text;
  } catch (e) {
    console.error(`[delegation-ratio-watch] inbox delivery failed: ${e.message}`);
    return null;
  }
}

// 次回 auto-session 用の根本修正起票
export function writeFixTicket(result, home = os.homedir()) {
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
  const tmp = `${fixFile}.${Math.random().toString(16).slice(2)}.tmp`;
  try { fs.mkdirSync(path.dirname(fixFile), { recursive: true }); fs.writeFileSync(tmp, JSON.stringify(fix, null, 2) + '\n', { mode: 0o600 }); fs.renameSync(tmp, fixFile); }
  finally { try { fs.unlinkSync(tmp); } catch {} }
  return fixFile;
}

if (isEntry(import.meta.url)) {
  const home = process.env.ORGIAST_HOME || os.homedir();
  const now = Date.now();
  const result = compute({ home, now });
  saveResult(result, home);
  if (result.alert) {
    notifyInbox(result, home);
    writeFixTicket(result, home);
    for (const r of result.reasons) console.error(`[delegation-ratio-watch] 🔴 ${r}`);
  } else {
    console.error(`[delegation-ratio-watch] ✅ 正常（Claude Opus ${result.claude.opusRatio}% / 安いAI ${result.cheapAi.workCount} 件）`);
  }
  console.log(JSON.stringify(result));
}