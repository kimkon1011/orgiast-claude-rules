#!/usr/bin/env node
/**
 * 依頼追跡台帳 — 人や先方への依頼を完了条件まで追いかける。
 * 正本: Google スプレッドシート（config/followup-ledger.json）
 * ローカル退避: ~/.claude/followup-ledger/ledger.json（FOLLOWUP_LEDGER_HOME で差し替え可）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { isEntry } from './is-entry.mjs';
import { createSheetsClient, quoteTab } from './lib/sheets-dwd.mjs';
import { getDriveToken, driveApi, defaultDriveKeyPath } from './lib/drive-auth.mjs';
import { keyserveSecret } from './keyserve-auth.mjs';
import { gwsFetch } from './lib/gws-proxy.mjs';
import { ensureKimEditor } from './lib/kim-editor.mjs';
import { prepareTemaSend } from './lib/unattended-tema.mjs';
import { getAdapter, recordMockSpawn } from './lib/followup-adapters.mjs';
import { buildPcIdentityIndex, pcMapEntries } from './fleet-pc-identity.mjs';
import { checkTema, formatTemaFindings, stripTemaRecord } from './lib/tema-check.mjs';
import { scanReports, findExistingEntries, toAddFlags, selftest as stalledSelftest } from './lib/stalled-scan.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.dirname(__dirname);
const CONFIG_PATH = path.join(REPO_ROOT, 'config', 'followup-ledger.json');
const FLEET_PC_MAP_PATH = path.join(REPO_ROOT, 'fleet-pc-map.json');

import { HEADERS, FIELDS, normalizeRow, rowToValues, valuesToRow, normalizeOwnerAi } from './lib/followup-schema.mjs';
export { HEADERS, FIELDS, normalizeRow, rowToValues, valuesToRow, normalizeOwnerAi } from './lib/followup-schema.mjs';

export const STATUSES = Object.freeze([
  '依頼中', '催促済み', '承認待ち', '完了', '止まった', 'エスカレーション',
]);

export const AI_FOOTER = '※このメッセージは金の指示でAIが作成・送信しています。';
const LEDGER_TAB = 'ledger';
const HISTORY_TAB = 'history';
const HISTORY_HEADERS = Object.freeze(['時刻', '依頼ID', '状態', '理由', '送信ID', '実行PC', '実行AI']);
const REQUEST_FLAGS = Object.freeze({
  kind: 'requestKind', 'requested-by': 'requestedBy', 'evidence-kind': 'evidenceKind', evidence: 'evidence',
  prereq: 'prereq', 'kim-only': 'kimOnlyAction', 'reassign-to': 'reassignTo',
  'outcome-source': 'outcomeSource', 'outcome-max-days': 'outcomeMaxDays',
  'last-outcome-at': 'lastOutcomeAt', 'last-job-result': 'lastJobResult',
});

const DEFAULT_CONFIG = Object.freeze({
  spreadsheetId: '',
  hubPc: '008',
  url: '',
  owner: 'seisaku-team@orgiast.jp',
  approvalChannelId: '1561703420455292979',
  approverUserIds: [],
  approvalTimeoutMinutes: 120,
  quietHours: { start: '22:00', end: '07:00', tz: 'Asia/Tokyo' },
  alertFile: '~/gb-reports/followup-ledger/ALERT.md',
  morningReportFile: '~/gb-reports/followup-ledger/MORNING.md',
  outcomeDefaults: { maxDays: 1 },
  pcAliases: { '000': 'kim-PC', '011': '作業用011' },
  people: {
    'ほなみ': { role: 'cafe-solo', location: '大阪・東邦ハイツ211（カフェ店内・一人勤務）' },
    '澤口': { role: 'cafe-solo', location: '大阪・東邦ハイツ211（カフェ店内・一人勤務）' },
    'ゆりえ': { role: 'cafe-solo', location: '大阪・東邦ハイツ211（カフェ店内・一人勤務）' },
    '岡崎': { role: 'cafe-solo', location: '大阪・東邦ハイツ211（カフェ店内・一人勤務）' },
  },
});

export const OFF_SITE_PATTERN = /セブン|ネットプリント|コンビニ|郵便局|投函|ポスト|簡易書留|レターパック|書留|法務局|裁判所|役所|区役所|市役所|配達|届けて|訪問|持参|出向|窓口|銀行|買い出し|受け取りに行/;
export const CAFE_SOLO_REASON = 'カフェスタッフは一人勤務のため店を離れられない（店を離れる作業は、店を離れられる担当＝各地のアシスタント等へ付け替えが必要）';
export function isOffSiteTask(row = {}) {
  if (row.taskSite === 'off-site') return true;
  if (row.taskSite === 'in-store' || row.taskSite === 'any') return false;
  return OFF_SITE_PATTERN.test(String(row.task || ''));
}
export function isCafeSolo(row = {}) { return row.assigneeRole === 'cafe-solo'; }
/** 金さん 2026-11-28: 出勤前に取りに行って送ってもらう。カフェ一人勤務の店外禁止の、この依頼だけの例外。 */
export const PRE_SHIFT_PICKUP_MAIL_IDS = new Set(['GB179-shaho-honami']);
export function isPreShiftPickupMailException(row = {}) {
  return PRE_SHIFT_PICKUP_MAIL_IDS.has(String(row.id || ''));
}
export function siteConstraint(row = {}) {
  if (isCafeSolo(row) && isOffSiteTask(row)) {
    if (isPreShiftPickupMailException(row)) {
      return { blocked: false, exception: 'pre-shift-pickup-mail' };
    }
    return { blocked: true, reason: CAFE_SOLO_REASON };
  }
  return { blocked: false };
}
export function resolvePerson(to, config = {}) {
  const hit = Object.entries(config.people || {}).find(([name]) => String(to || '').includes(name));
  return hit ? { role: String(hit[1]?.role || ''), location: String(hit[1]?.location || '') } : null;
}
function prependReason(reason, existing = '') {
  const old = String(existing || '');
  return old.includes(reason) ? old : [reason, old].filter(Boolean).join('／');
}

export function parseArgs(argv = []) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      out._.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) {
        // --chat= / --chat=value → keep empty string as empty (never boolean)
        out.flags[a.slice(2, eq)] = a.slice(eq + 1);
        continue;
      }
      const key = a.slice(2);
      const next = argv[i + 1];
      // Only string values that look like flags (or missing) → boolean true.
      // Empty string '' is a real value. Non-strings (test harness) are stored as-is.
      if (next === undefined || (typeof next === 'string' && next.startsWith('--'))) {
        out.flags[key] = true;
      } else {
        out.flags[key] = next;
        i++;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

/** Resolve "now" for quietHours / due checks. Prefer explicit arg, then FOLLOWUP_NOW. */
export function resolveNow(now) {
  if (now instanceof Date && !Number.isNaN(now.getTime())) return now;
  if (now != null && now !== '') {
    const parsed = new Date(now);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  if (process.env.FOLLOWUP_NOW) {
    const fromEnv = new Date(process.env.FOLLOWUP_NOW);
    if (!Number.isNaN(fromEnv.getTime())) return fromEnv;
  }
  return new Date();
}

/** chatID that cannot drive beeper/discord sends. */
export function isMissingChatId(chatId) {
  const s = chatId == null || chatId === true ? '' : String(chatId);
  if (!s.trim()) return true;
  if (s === 'true') return true;
  if (/^未確認/.test(s)) return true;
  return false;
}

export function toIsoJst(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const g = (t) => parts.find((p) => p.type === t)?.value || '00';
  return `${g('year')}-${g('month')}-${g('day')}T${g('hour')}:${g('minute')}:${g('second')}+09:00`;
}

function jstHm(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Tokyo',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const h = parts.find((p) => p.type === 'hour')?.value || '00';
  const m = parts.find((p) => p.type === 'minute')?.value || '00';
  return `${h}:${m}`;
}

function parseHm(hm) {
  const [h, m] = String(hm || '00:00').split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

export function isQuietHours(now = new Date(), quietHours = DEFAULT_CONFIG.quietHours) {
  const cur = parseHm(jstHm(now));
  const start = parseHm(quietHours?.start || '22:00');
  const end = parseHm(quietHours?.end || '07:00');
  if (start === end) return false;
  if (start > end) return cur >= start || cur < end;
  return cur >= start && cur < end;
}

/** 次の quietHours.end（JST）を ISO+09:00 で返す */
export function nextQuietEnd(now = new Date(), quietHours = DEFAULT_CONFIG.quietHours) {
  const endHm = quietHours?.end || '07:00';
  const [eh, em] = endHm.split(':').map(Number);
  const jstNow = toIsoJst(now);
  const base = jstNow.slice(0, 10);
  let candidate = new Date(`${base}T${String(eh).padStart(2, '0')}:${String(em || 0).padStart(2, '0')}:00+09:00`);
  if (candidate.getTime() <= now.getTime()) {
    candidate = new Date(candidate.getTime() + 24 * 60 * 60 * 1000);
  }
  // If currently before end same morning (e.g. 03:00, end 07:00), use today.
  if (isQuietHours(now, quietHours)) {
    const todayEnd = new Date(`${base}T${String(eh).padStart(2, '0')}:${String(em || 0).padStart(2, '0')}:00+09:00`);
    if (todayEnd.getTime() > now.getTime()) candidate = todayEnd;
  }
  return toIsoJst(candidate);
}

export function computeDue(row, now = new Date()) {
  const due = row.dueAt ? Date.parse(row.dueAt) : NaN;
  if (Number.isFinite(due)) return due;
  const base = Date.parse(row.lastSentAt || row.requestedAt || now.toISOString());
  const renudge = Number(row.renudgeMin || 0) * 60_000;
  return Number.isFinite(base) ? base + renudge : now.getTime();
}

export function matchDonePattern(text, pattern) {
  if (!pattern) return false;
  try {
    return new RegExp(pattern).test(String(text || ''));
  } catch {
    return String(text || '').includes(String(pattern));
  }
}

const JOB_ONLY_EVIDENCE = /^(?:exit\s*0|exitCode\s*=\s*0|status\s*=\s*approved|approved|ok|done)$/i;

export function validateEvidence(evidenceKind, evidence) {
  const value = evidence == null || evidence === true ? '' : String(evidence).trim();
  const fail = (reason) => ({ ok: false, reason });
  if (JOB_ONLY_EVIDENCE.test(value)) return fail('exit 0 や approved は完了ではない');
  if (!evidenceKind) return { ok: true, reason: '' };
  if (!value) return fail('完了の実物が無い');
  if (evidenceKind === 'tracking-number') {
    if (!/^(?:\d{10,14}|[a-z]{2}\d{9}[a-z]{2})$/i.test(value.replace(/[\s-]/g, ''))) return fail('追跡番号は数字10〜14桁または国際郵便形式が必要');
  } else if (evidenceKind === 'public-url') {
    try {
      const url = new URL(value);
      const host = url.hostname.toLowerCase();
      if (!value.startsWith('https://') || url.username || url.password
        || !host.includes('.') || /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(host)
        || /^(?:127\.|10\.|192\.168\.|169\.254\.|0\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(host)
        || host.includes(':')) return fail('公開HTTPS URLが必要（ローカルURLは不可）');
      if (/(?:^|\.)instagram\.com$/.test(host) && !/^\/(?:p|reel|tv)\/[^/]+/.test(url.pathname)) return fail('Instagramは公開投稿URLが必要');
    } catch { return fail('公開HTTPS URLが必要'); }
  } else if (evidenceKind === 'reply-text') {
    if ([...value].length < 10) return fail('返信本文は10文字以上が必要');
  } else if (evidenceKind === 'file') {
    try {
      const stat = fs.statSync(value);
      if (!stat.isFile() || stat.size <= 0) return fail('成果物ファイルが空です');
    } catch { return fail('成果物ファイルが存在しません'); }
  } else return fail(`未対応の完了の実物種別: ${evidenceKind}`);
  return { ok: true, reason: '' };
}

function extractEvidence(kind, text) {
  const value = String(text || '');
  if (kind === 'tracking-number') {
    const candidates = value.match(/(?<![a-z0-9])(?:[a-z]{2}\d{9}[a-z]{2}|\d(?:[\d -]*\d)?)(?![a-z0-9])/gi) || [];
    return candidates.find((v) => validateEvidence(kind, v).ok) || '';
  }
  if (kind === 'public-url') {
    const candidates = value.match(/https:\/\/[^\s<>"'）)\]、。]+/g) || [];
    return candidates.find((v) => validateEvidence(kind, v).ok) || '';
  }
  return value.trim();
}

export function checkPrereq(row, { fsImpl = fs } = {}) {
  return String(row.prereq || '').split(';').map((s) => s.trim())
    .filter((s) => s.startsWith('file:')).map((s) => s.slice(5))
    .filter((file) => { try { return !fsImpl.existsSync(file); } catch { return true; } });
}

export function readOutcome(source, { fsImpl = fs, now = new Date() } = {}) {
  if (!source) return null;
  try {
    const read = (file) => JSON.parse(fsImpl.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    if (source.startsWith('json:')) return read(source.slice(5));
    if (!source.startsWith('insta-queue:')) return null;
    const dir = source.slice('insta-queue:'.length);
    const entries = fsImpl.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => read(path.join(dir, f)));
    const outcomes = entries.filter((e) => e.postedAt || e.postUrl);
    const dates = outcomes.map((e) => e.postedAt).filter((d) => Number.isFinite(Date.parse(d)) && Date.parse(d) <= new Date(now).getTime());
    dates.sort((a, b) => Date.parse(b) - Date.parse(a));
    return { lastOutcomeAt: dates[0] || '', outcomes, pendingApproved: entries.filter((e) => e.status === 'approved' && !e.postedAt).length, note: '' };
  } catch { return null; }
}

export function evaluateOutcomeLiveness(row, snapshot, now = new Date(), config = DEFAULT_CONFIG) {
  const maxDays = Number(row.outcomeMaxDays || config.outcomeDefaults?.maxDays || 1);
  const base = Date.parse(snapshot?.lastOutcomeAt || row.lastOutcomeAt || row.requestedAt);
  if (!Number.isFinite(base) || !(maxDays > 0)) return { state: 'warn', reason: '成果警告: 基準日時または成果許容日数が不明' };
  const ageDays = (new Date(now).getTime() - base) / 86_400_000;
  if (ageDays > maxDays && (snapshot?.outcomes || []).length === 0) {
    return { state: 'stalled', reason: `成果ゼロ: ${maxDays}日以上 実結果なし（ジョブ結果 ${row.lastJobResult || '不明'}・承認済み未投稿 ${snapshot?.pendingApproved || 0}件）。exit 0 や approved は完了ではない` };
  }
  if (ageDays > maxDays / 2) return { state: 'warn', reason: `成果警告: 最終成果から${ageDays.toFixed(1)}日（許容${maxDays}日）` };
  return { state: 'ok', reason: '' };
}

/**
 * Pure decision helper.
 * @returns {{ action: string, reason?: string, evidence?: string, messageId?: string }}
 */
export function decideAction(row, replies = [], now = new Date()) {
  const status = row.status || '依頼中';
  if (status === '完了') return { action: 'noop', reason: 'already-complete' };

  const others = (replies || []).filter((m) => !m.isSelf);
  for (const m of others) {
    if (matchDonePattern(m.text, row.donePattern)) {
      const evidence = extractEvidence(row.evidenceKind, m.text);
      if (!validateEvidence(row.evidenceKind, evidence).ok || (row.requestKind && row.requestKind !== 'human' && !evidence)) continue;
      return {
        action: 'complete',
        reason: 'done-pattern',
        evidence,
        messageId: m.id || '',
      };
    }
  }
  const constraint = siteConstraint(row);
  if (constraint.blocked) return { action: 'reassign', reason: constraint.reason };
  if (others.length && !row.evidenceKind) {
    return {
      action: 'reply_incomplete',
      reason: `返事あり・完了条件未達: ${String(others[0].text || '').slice(0, 80)}`,
      evidence: String(others[0].text || '').slice(0, 80),
      messageId: others[0].id || '',
    };
  }

  const nowMs = now.getTime();
  const dueMs = computeDue(row, now);
  const lastSent = Date.parse(row.lastSentAt || row.requestedAt || 0);
  const renudgeMs = Number(row.renudgeMin || 0) * 60_000;
  const overdue = nowMs >= dueMs || (Number.isFinite(lastSent) && renudgeMs > 0 && nowMs >= lastSent + renudgeMs);

  if (status === '承認待ち') {
    return { action: 'approval_check', reason: overdue ? 'approval-overdue' : 'awaiting-approval' };
  }

  if (!overdue) return { action: 'wait', reason: 'not-due' };

  const nudges = Number(row.nudgeCount || 0);
  const max = Number(row.maxNudges || 0);
  if (max > 0 && nudges >= max) {
    return { action: 'escalate', reason: `最大催促回数(${max})超過` };
  }
  if (String(row.channel || '') === 'manual') {
    return { action: 'escalate', reason: '手動チャネル・期限超過' };
  }
  if (String(row.scope || '') === 'external') {
    return { action: 'request_approval', reason: 'external-nudge' };
  }
  return { action: 'nudge', reason: 'overdue' };
}

function homeRoot() {
  if (process.env.FOLLOWUP_LEDGER_HOME) return process.env.FOLLOWUP_LEDGER_HOME;
  return path.join(process.env.ORGIAST_HOME || os.homedir(), '.claude', 'followup-ledger');
}

function localLedgerPath() {
  return path.join(homeRoot(), 'ledger.json');
}

function expandHome(p) {
  if (!p) return p;
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  if (p === '~') return os.homedir();
  return p;
}

function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

function atomicText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

export function loadConfig(configPath = CONFIG_PATH) {
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return {
    ...DEFAULT_CONFIG,
    ...raw,
    quietHours: { ...DEFAULT_CONFIG.quietHours, ...(raw.quietHours || {}) },
    outcomeDefaults: { ...DEFAULT_CONFIG.outcomeDefaults, ...(raw.outcomeDefaults || {}) },
    approverUserIds: Array.isArray(raw.approverUserIds) ? raw.approverUserIds.map(String) : [],
    pcAliases: {
      ...DEFAULT_CONFIG.pcAliases,
      ...(raw.pcAliases && typeof raw.pcAliases === 'object' ? raw.pcAliases : {}),
    },
    people: raw.people && typeof raw.people === 'object' ? raw.people : DEFAULT_CONFIG.people,
    _path: configPath,
  };
}

function saveConfig(config, configPath = CONFIG_PATH) {
  const { _path, ...rest } = config;
  atomicJson(configPath || _path || CONFIG_PATH, {
    spreadsheetId: rest.spreadsheetId || '',
    hubPc: rest.hubPc || DEFAULT_CONFIG.hubPc,
    url: rest.url || '',
    owner: rest.owner || DEFAULT_CONFIG.owner,
    approvalChannelId: rest.approvalChannelId || DEFAULT_CONFIG.approvalChannelId,
    approverUserIds: rest.approverUserIds || [],
    approvalTimeoutMinutes: rest.approvalTimeoutMinutes ?? DEFAULT_CONFIG.approvalTimeoutMinutes,
    quietHours: rest.quietHours || DEFAULT_CONFIG.quietHours,
    alertFile: rest.alertFile || DEFAULT_CONFIG.alertFile,
    morningReportFile: rest.morningReportFile || DEFAULT_CONFIG.morningReportFile,
    outcomeDefaults: rest.outcomeDefaults || DEFAULT_CONFIG.outcomeDefaults,
    pcAliases: rest.pcAliases || DEFAULT_CONFIG.pcAliases,
    people: rest.people || DEFAULT_CONFIG.people,
  });
}

export function currentPcName({ env = process.env, hostname = os.hostname() } = {}) {
  const fromEnv = String(env.FOLLOWUP_PC || '').trim();
  return fromEnv || String(hostname || '').trim();
}

export function loadFleetPcMap(mapPath = FLEET_PC_MAP_PATH) {
  try {
    return JSON.parse(fs.readFileSync(mapPath, 'utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}

function pcKey(name) {
  return String(name || '').trim().toLocaleLowerCase('ja');
}

/** Expand a PC label through config.pcAliases and fleet-pc-map (label/hostname/aliases). */
export function expandPcNames(name, { pcMap = {}, pcAliases = {} } = {}) {
  const names = new Set();
  const add = (n) => {
    const k = pcKey(n);
    if (k) names.add(k);
  };
  add(name);
  const aliasEntries = Object.entries(pcAliases || {}).filter(([k, v]) => k && v != null && String(v).trim());
  // Apply aliases iteratively so "000" → "kim-PC" then fleet expands kim-PC.
  let changed = true;
  while (changed) {
    changed = false;
    const snapshot = [...names];
    for (const [k, v] of aliasEntries) {
      const kk = pcKey(k);
      const vk = pcKey(v);
      if (snapshot.includes(kk) && !names.has(vk)) { add(v); changed = true; }
      if (snapshot.includes(vk) && !names.has(kk)) { add(k); changed = true; }
    }
  }
  const index = buildPcIdentityIndex(pcMap);
  for (const n of [...names]) {
    const identity = index.find(n);
    if (identity) {
      for (const x of identity.names) add(x);
      // Also index by remoteName / titleLabel when present on mapped entry.
      const mapped = identity.mapped || {};
      add(mapped.remoteName);
      add(mapped.titleLabel);
      add(mapped.sheetName);
    }
  }
  // Fallback: scan entries whose hostname/aliases intersect (covers keys not found by index quirks).
  for (const [label, mapped] of pcMapEntries(pcMap)) {
    const candidates = [label, mapped.hostname, mapped.sheetName, mapped.remoteName, mapped.titleLabel, ...(mapped.aliases || [])]
      .map(pcKey).filter(Boolean);
    if (candidates.some((c) => names.has(c))) {
      for (const c of candidates) names.add(c);
    }
  }
  return names;
}

export function isSamePc(a, b, opts = {}) {
  const left = String(a || '').trim();
  const right = String(b || '').trim();
  if (!left || !right) return false;
  if (pcKey(left) === pcKey(right)) return true;
  const setA = expandPcNames(left, opts);
  const setB = expandPcNames(right, opts);
  for (const x of setA) {
    if (setB.has(x)) return true;
  }
  return false;
}

export function effectiveOwnerPc(row, config = DEFAULT_CONFIG) {
  const owner = String(row.ownerPc || '').trim();
  return !owner || ['グロボ', 'ふわ', 'どっと'].includes(normalizeOwnerAi(owner)) ? (config.hubPc || DEFAULT_CONFIG.hubPc) : owner;
}

export function isOwnerPcMatch(ownerPc, thisPc, opts = {}) {
  const owner = String(ownerPc || '').trim();
  if (!owner || pcKey(owner) === 'any') return true;
  return isSamePc(owner, thisPc, opts);
}

export function watchdogStaleMs(row) {
  const interval = Number(row.intervalMin || 15);
  return (interval * 2 + 30) * 60_000;
}

export function hasWatchdogToday(history, id, now = new Date()) {
  const day = toIsoJst(now).slice(0, 10);
  return (history || []).some((h) => (
    String(h.id) === String(id)
    && String(h.reason || '') === 'watchdog'
    && String(h.at || '').startsWith(day)
  ));
}

function emptyStore() {
  return { schema: 'followup-ledger/v1', items: [], history: [], pendingSync: false, syncError: null, updatedAt: toIsoJst() };
}

export function loadLocalStore(file = localLedgerPath()) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    return {
      schema: raw.schema || 'followup-ledger/v1',
      items: Array.isArray(raw.items) ? raw.items : [],
      history: Array.isArray(raw.history) ? raw.history : [],
      pendingSync: Boolean(raw.pendingSync),
      syncError: raw.syncError || null,
      updatedAt: raw.updatedAt || toIsoJst(),
    };
  } catch (error) {
    if (error.code === 'ENOENT') return emptyStore();
    throw error;
  }
}

export function saveLocalStore(store, file = localLedgerPath()) {
  const next = { ...store, updatedAt: toIsoJst() };
  atomicJson(file, next);
  return next;
}

export function rowFromArgs(flags, { now = new Date(), config = DEFAULT_CONFIG } = {}) {
  // PowerShell `--chat ''` often drops the empty arg → parseArgs sets true.
  const rawChat = flags.chat;
  const chatId = (rawChat == null || rawChat === true) ? '' : String(rawChat);
  const channel = String(flags.channel || 'manual');
  const chatMissing = isMissingChatId(chatId);
  let status = flags.status ? String(flags.status) : '依頼中';
  let statusReason = flags.reason ? String(flags.reason) : '';
  const person = resolvePerson(flags.to, config);
  if (chatMissing && (channel === 'beeper' || channel === 'discord')) {
    status = '止まった';
    statusReason = 'chatID不明';
    // Persist empty rather than the boolean-coerced "true".
  }
  const intervalMin = Number(flags.interval ?? 15);
  const requestedAt = flags['requested-at'] || toIsoJst(now);
  // add 直後の check で拾えるよう、次回確認は「今」（間隔先送りしない）
  const nextCheckAt = flags['next-check-at'] || toIsoJst(now);
  let nudgeText = '';
  let temaCheck = '';
  const temaArg = flags['tema-check'];
  if (temaArg && temaArg !== true) {
    const candidate = String(temaArg);
    temaCheck = fs.existsSync(candidate) ? fs.readFileSync(candidate, 'utf8').trim() : candidate.trim();
  }
  if (!temaCheck) throw new Error('--tema-check <記録文字列またはファイル> が必要です。例: --tema-check "[TEMA-CHECK] 候補: ... [/TEMA-CHECK]"');
  if (flags['nudge-text-file']) {
    nudgeText = fs.readFileSync(String(flags['nudge-text-file']), 'utf8').trim();
  } else if (flags['nudge-text'] != null && flags['nudge-text'] !== true) {
    nudgeText = String(flags['nudge-text']).trim();
  }
  const row = normalizeRow({
    id: String(flags.id || ''),
    to: String(flags.to || ''),
    channel,
    chatId: chatMissing && (channel === 'beeper' || channel === 'discord') ? '' : chatId,
    scope: String(flags.scope || 'internal'),
    task: String(flags.task || ''),
    requestedAt,
    doneWhen: String(flags['done-when'] || ''),
    donePattern: String(flags['done-pattern'] || ''),
    intervalMin,
    dueAt: String(flags.due || ''),
    renudgeMin: Number(flags.renudge ?? 60),
    maxNudges: Number(flags['max-nudges'] ?? 3),
    nudgeCount: 0,
    escalateTo: String(flags.escalate || 'kim-inbox'),
    ownerAi: normalizeOwnerAi(flags['owner-ai'] || 'Claude Code'),
    ownerPc: String(flags['owner-pc'] || ''),
    status,
    statusReason,
    lastCheckedAt: '',
    lastSentAt: '',
    lastSentId: '',
    nextCheckAt,
    nudgeText,
    caseName: String(flags.case || ''),
    note: String(flags.note || ''),
    updatedAt: toIsoJst(now),
    assigneeRole: String(flags['assignee-role'] || person?.role || ''),
    assigneeLocation: String(flags.location || person?.location || ''),
    taskSite: String(flags.site || ''),
    temaCheck,
    requestKind: String(flags.kind || 'human'),
    requestedBy: String(flags['requested-by'] || currentPcName()),
    evidenceKind: String(flags['evidence-kind'] || ''),
    evidence: String(flags.evidence || ''),
    prereq: String(flags.prereq || ''),
    kimOnlyAction: String(flags['kim-only'] || ''),
    reassignTo: String(flags['reassign-to'] || ''),
    outcomeSource: String(flags['outcome-source'] || ''),
    outcomeMaxDays: Number(flags['outcome-max-days'] || 0),
    lastOutcomeAt: String(flags['last-outcome-at'] || ''),
    lastJobResult: String(flags['last-job-result'] || ''),
  }, { validateRequired: false });
  const constraint = siteConstraint(row);
  if (constraint.blocked) {
    row.status = '止まった';
    row.statusReason = prependReason(constraint.reason, row.statusReason);
  }
  return row;
}

export function assertStatusReason(status, reason) {
  if ((status === '止まった' || status === 'エスカレーション') && !String(reason || '').trim()) {
    throw new Error(`${status} には状態理由が必須です`);
  }
}

export function setRowStatus(row, status, reason = '') {
  assertStatusReason(status, reason);
  if (!STATUSES.includes(status)) throw new Error(`invalid status: ${status}`);
  row.status = status;
  row.statusReason = reason || '';
  row.updatedAt = toIsoJst();
  return row;
}

function appendHistory(store, { id, status, reason, messageId = '', pc = '', ai = '', at = toIsoJst() }) {
  store.history = store.history || [];
  store.history.push({
    _pendingSheet: true, at, id, status, reason: reason || '', messageId: messageId || '', pc: pc || os.hostname(), ai: ai || process.env.FOLLOWUP_OWNER_AI || 'followup-ledger',
  });
}

function withAiFooter(text) {
  const body = String(text || '').trimEnd();
  if (body.includes(AI_FOOTER)) return body;
  return `${body}\n\n${AI_FOOTER}`;
}

async function withTemaRecord(text, row, ctx) {
  const combined = row.temaCheck ? `${String(text).trimEnd()}\n\n${row.temaCheck}` : String(text);
  return (await prepareTemaSend(combined, { home: ctx.adapterDeps?.home, channel: row.channel, to: row.to, source: 'followup-ledger', dryRun: ctx.dryRun || ctx.noNudge, addItemImpl: ctx.adapterDeps?.addItemImpl })).trim();
}

function defaultNudgeText(row) {
  if (row.nudgeText) return row.nudgeText;
  return `【催促】${row.task || '依頼'} の件、ご対応状況を教えてください。（依頼ID: ${row.id}）`;
}

function recentSelfNudge(messages, text, renudgeMin, now = new Date()) {
  const prefix = String(text || '').slice(0, 40);
  const windowMs = Number(renudgeMin || 0) * 60_000;
  const cutoff = now.getTime() - (windowMs || 0);
  return (messages || []).some((m) => {
    if (!m.isSelf) return false;
    if (!String(m.text || '').includes(prefix)) return false;
    if (!windowMs) return true;
    const at = Date.parse(m.at || 0);
    return Number.isFinite(at) && at >= cutoff;
  });
}

async function escalate(row, reason, ctx) {
  const { store, dryRun, alerts } = ctx;
  // 止まった（前提欠落）はそのまま。それ以外はエスカレーションへ。
  if (row.status !== '止まった') setRowStatus(row, 'エスカレーション', reason);
  else setRowStatus(row, '止まった', reason || row.statusReason);
  appendHistory(store, { id: row.id, status: row.status, reason, ai: row.ownerAi, pc: row.ownerPc, at: toIsoJst(resolveNow(ctx.now)) });

  const target = String(row.escalateTo || 'kim-inbox');
  const body = [
    `followup-ledger エスカレーション`,
    `依頼ID: ${row.id}`,
    `依頼先: ${row.to}`,
    `内容: ${row.task}`,
    `理由: ${reason}`,
    `状態: ${row.status}`,
    ...(String(reason).includes(CAFE_SOLO_REASON) ? [
      `付け替え: 店を離れられる担当（各地のアシスタント等）へ。法務局・郵便局は全国どこでも可。依頼先の居住地・最寄り: ${row.assigneeLocation || '未記入'}`,
      'カフェスタッフに頼めるのは店内でできること（書類の有無の確認・店に来た人への手渡し・返事）だけ',
    ] : []),
  ].join('\n');

  if (dryRun) {
    alerts.push(`[dry-run] escalate → ${target}: ${row.id} ${reason}`);
    ctx.escalations = ctx.escalations || [];
    ctx.escalations.push({ target, id: row.id, reason, body });
    return;
  }

  if (target === 'kim-inbox') {
    await escalateKimInbox(row.id, body, ctx);
  } else if (target.startsWith('discord:')) {
    const channelId = target.slice('discord:'.length);
    const adapter = getAdapter('discord', ctx.adapterDeps);
    const sendRow = { ...row, channel: 'discord', chatId: channelId };
    const result = await adapter.send(sendRow, body);
    alerts.push(result.ok
      ? `Discord escalate ${channelId}: ${row.id}`
      : `Discord escalate 失敗: ${result.error}`);
  } else {
    alerts.push(`escalate(${target}): ${row.id} ${reason}`);
  }
}

async function escalateKimInbox(id, body, ctx) {
  const { dryRun, alerts, spawn = spawnSync } = ctx;
  const kimInbox = path.join(REPO_ROOT, 'tools', 'kim-inbox.mjs');
  ctx.escalations = ctx.escalations || [];
  ctx.escalations.push({ target: 'kim-inbox', id, body });

  if (dryRun) {
    alerts.push(`[dry-run] kim-inbox ask: ${id}`);
    return;
  }
  if (process.env.FOLLOWUP_ADAPTER === 'mock' && !ctx.spawn) {
    recordMockSpawn(process.execPath, [kimInbox, '--add', '--kind', 'ask', '--dedupe-key', `followup-ledger:${id}`], body);
    return;
  }

  // Prefer --lookup; also use --dedupe-key so open duplicates are not stacked.
  try {
    const looked = spawn(process.execPath, [kimInbox, '--lookup', id], {
      encoding: 'utf8', windowsHide: true, timeout: 30_000, env: process.env,
    });
    if (looked.status === 0) {
      try {
        const hits = JSON.parse(looked.stdout || '[]');
        if (Array.isArray(hits) && hits.length) {
          alerts.push(`kim-inbox lookup hit (skip add): ${id}`);
          return;
        }
      } catch { /* ignore parse */ }
    }
  } catch { /* continue to add */ }

  // Open duplicate check via --list --json --open
  try {
    const listed = spawn(process.execPath, [kimInbox, '--list', '--json', '--open'], {
      encoding: 'utf8', windowsHide: true, timeout: 30_000, env: process.env,
    });
    if (listed.status === 0) {
      const items = JSON.parse(listed.stdout || '[]');
      if (Array.isArray(items) && items.some((i) => String(i.text || '').includes(id) || i.dedupeKey === `followup-ledger:${id}`)) {
        alerts.push(`kim-inbox open 既存あり (skip): ${id}`);
        return;
      }
    }
  } catch { /* continue */ }

  const tmp = path.join(homeRoot(), `escalate-${id}.${process.pid}.txt`);
  fs.mkdirSync(path.dirname(tmp), { recursive: true });
  fs.writeFileSync(tmp, body);
  try {
    const added = spawn(process.execPath, [
      kimInbox, '--add', '--kind', 'ask', '--body-file', tmp, '--dedupe-key', `followup-ledger:${id}`, '--source', 'followup-ledger',
    ], { encoding: 'utf8', windowsHide: true, timeout: 60_000, env: process.env });
    if (added.status === 0) alerts.push(`kim-inbox ask added: ${id}`);
    else alerts.push(`kim-inbox add 失敗: ${(added.stderr || added.stdout || '').slice(0, 120)}`);
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

async function ensureSpreadsheet(config, { shareDomain = 'orgiast.jp', editor = 'kim@orgiast.jp' } = {}) {
  const owner = config.owner || DEFAULT_CONFIG.owner;
  const sheets = createSheetsClient({
    getToken: (opts) => getDriveToken({ ...opts, impersonate: owner }),
  });

  let spreadsheetId = config.spreadsheetId;
  let url = config.url;
  if (!spreadsheetId) {
    const token = await getDriveToken({
      scope: 'https://www.googleapis.com/auth/spreadsheets',
      impersonate: owner,
    });
    const res = await gwsFetch('https://sheets.googleapis.com/v4/spreadsheets', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        properties: { title: '依頼追跡台帳（followup-ledger）' },
        sheets: [
          { properties: { title: LEDGER_TAB, gridProperties: { frozenRowCount: 1, columnCount: HEADERS.length } } },
          { properties: { title: HISTORY_TAB, gridProperties: { frozenRowCount: 1, columnCount: HISTORY_HEADERS.length } } },
        ],
      }),
    });
    if (!res.ok) throw new Error(`Sheets create HTTP ${res.status}`);
    const created = await res.json();
    spreadsheetId = created.spreadsheetId;
    url = created.spreadsheetUrl || `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;
  }

  await ensureTabs(sheets, spreadsheetId, owner);

  // Domain + editor share
  const token = await getDriveToken({ scope: 'https://www.googleapis.com/auth/drive', impersonate: owner });
  const permEndpoint = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(spreadsheetId)}/permissions`;
  const shareOps = [
    { type: 'domain', role: 'writer', domain: shareDomain },
    { type: 'user', role: 'writer', emailAddress: editor },
  ];
  for (const body of shareOps) {
    try {
      await driveApi(token, `${permEndpoint}?sendNotificationEmail=false&supportsAllDrives=true`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (error) {
      // already exists is fine
      if (!/already|exists|409/i.test(String(error.message || error))) {
        console.error(`共有警告: ${error.message || error}`);
      }
    }
  }
  await ensureKimEditor(spreadsheetId, { actingUser: owner, token });

  // Read-back permissions
  const listed = await (await driveApi(token, `${permEndpoint}?supportsAllDrives=true&fields=permissions(id,type,role,emailAddress,domain)&pageSize=100`)).json();
  return { spreadsheetId, url: url || `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`, permissions: listed.permissions || [] };
}

async function ensureTabs(sheets, spreadsheetId, owner = DEFAULT_CONFIG.owner) {
  const meta = await sheets.metadata(spreadsheetId);
  const titles = new Set((meta.sheets || []).map((s) => s.properties.title));
  const requests = [];
  if (!titles.has(LEDGER_TAB)) {
    requests.push({ addSheet: { properties: { title: LEDGER_TAB, gridProperties: { frozenRowCount: 1, columnCount: HEADERS.length } } } });
  }
  if (!titles.has(HISTORY_TAB)) {
    requests.push({ addSheet: { properties: { title: HISTORY_TAB, gridProperties: { frozenRowCount: 1, columnCount: HISTORY_HEADERS.length } } } });
  }
  // 既存台帳の列数も拡張する。ヘッダー書込だけでは旧gridの末尾を越える。
  for (const [title, count] of [[LEDGER_TAB, HEADERS.length], [HISTORY_TAB, HISTORY_HEADERS.length]]) {
    const tab = meta.sheets?.find((s) => s.properties.title === title)?.properties;
    if (tab && Number(tab.gridProperties?.columnCount) < count) requests.push({
      updateSheetProperties: { properties: { sheetId: tab.sheetId, gridProperties: { columnCount: count } }, fields: 'gridProperties.columnCount' },
    });
  }
  if (requests.length) {
    if (sheets.updateStructure) await sheets.updateStructure(spreadsheetId, requests);
    else {
      const token = await getDriveToken({ scope: 'https://www.googleapis.com/auth/spreadsheets', impersonate: owner });
      const res = await gwsFetch(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}:batchUpdate`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ requests }),
      });
      if (!res.ok) throw new Error(`Sheets structure update HTTP ${res.status}`);
    }
  }
  const lastCol = columnLetter(HEADERS.length);
  const histCol = columnLetter(HISTORY_HEADERS.length);
  const existing = await sheets.get(spreadsheetId, `${quoteTab(LEDGER_TAB)}!A1:${lastCol}1`);
  if (!existing.length || (existing[0]?.length || 0) < HEADERS.length) {
    await sheets.update(spreadsheetId, `${quoteTab(LEDGER_TAB)}!A1:${lastCol}1`, [HEADERS]);
  }
  const hist = await sheets.get(spreadsheetId, `${quoteTab(HISTORY_TAB)}!A1:${histCol}1`);
  if (!hist.length) {
    await sheets.update(spreadsheetId, `${quoteTab(HISTORY_TAB)}!A1:${histCol}1`, [HISTORY_HEADERS]);
  }
}

function columnLetter(n) {
  let s = '';
  let x = n;
  while (x > 0) {
    const m = (x - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    x = Math.floor((x - 1) / 26);
  }
  return s || 'A';
}

async function loadStore({ storeMode, config, sheets: suppliedSheets, readOnly = false }) {
  if (storeMode === 'local' || !config.spreadsheetId) {
    return { mode: 'local', store: loadLocalStore(), sheetError: config.spreadsheetId ? null : 'spreadsheetId 未設定' };
  }
  try {
    const sheets = suppliedSheets || createSheetsClient({
      getToken: (opts) => getDriveToken({ ...opts, impersonate: config.owner || DEFAULT_CONFIG.owner }),
    });
    if (!readOnly) await ensureTabs(sheets, config.spreadsheetId, config.owner || DEFAULT_CONFIG.owner);
    const lastCol = columnLetter(HEADERS.length);
    const values = await sheets.get(config.spreadsheetId, `${quoteTab(LEDGER_TAB)}!A2:${lastCol}`);
    const items = values.map((v, i) => ({ values: v, sheetRow: i + 2 }))
      .filter(({ values: v }) => v.some((cell) => String(cell ?? '').trim()))
      .map(({ values: v, sheetRow }) => ({ ...valuesToRow(v), _sheetRow: sheetRow }));
    // Keep failed registrations until sync; an existing sheet ID always wins.
    const local = loadLocalStore();
    for (const row of local.items.filter((r) => r._pendingSheet)) {
      if (!items.some((r) => r.id === row.id)) items.push(row);
    }
    const histCol = columnLetter(HISTORY_HEADERS.length);
    const histValues = await sheets.get(config.spreadsheetId, `${quoteTab(HISTORY_TAB)}!A2:${histCol}`);
    const history = histValues.map((v) => ({
      at: v[0] || '', id: v[1] || '', status: v[2] || '', reason: v[3] || '',
      messageId: v[4] || '', pc: v[5] || '', ai: v[6] || '',
    }));
    // 未送信の履歴は再読込で失わない。append成功後の応答断も重複除去する。
    const historyKey = (h) => JSON.stringify([h.at, h.id, h.status, h.reason, h.messageId, h.pc, h.ai]);
    const known = new Set(history.map(historyKey));
    for (const h of loadLocalStore().history.filter((h) => h._pendingSheet)) {
      if (!known.has(historyKey(h))) { history.push(h); known.add(historyKey(h)); }
    }
    const pendingSync = items.some((r) => r._pendingSheet) || history.some((h) => h._pendingSheet);
    const store = { schema: 'followup-ledger/v1', items, history, pendingSync, syncError: pendingSync ? '履歴のシート同期待ち' : null, updatedAt: toIsoJst() };
    if (!readOnly) saveLocalStore(store);
    return { mode: 'sheet', store, sheets, sheetError: null };
  } catch (error) {
    const store = loadLocalStore();
    store.pendingSync = true;
    const failure = classifySheetError(error, config);
    store.syncError = failure.message;
    if (!readOnly) saveLocalStore(store);
    return { mode: 'local', store, sheetError: store.syncError, sheetFailure: failure };
  }
}

async function persistRow(ctx, row, { previousUpdatedAt } = {}) {
  const { storeMode, config, store, sheets } = ctx;
  if (ctx.dryRun && storeMode === 'sheet') return row;
  row.updatedAt = toIsoJst();
  const idx = store.items.findIndex((r) => r.id === row.id);
  if (idx >= 0) store.items[idx] = normalizeRow(row, { validateRequired: false });
  else store.items.push(normalizeRow(row, { validateRequired: false }));

  if (storeMode === 'local' || !config.spreadsheetId || !sheets) {
    if (storeMode !== 'local') {
      row._pendingSheet = true;
      store.items.find((r) => r.id === row.id)._pendingSheet = true;
      store.pendingSync = true;
      store.syncError = store.syncError || 'sheet unavailable';
    }
    saveLocalStore(store);
    return row;
  }

  // Save pending before the request, including ambiguous append failures.
  row._pendingSheet = true;
  store.items.find((r) => r.id === row.id)._pendingSheet = true;
  store.pendingSync = true;
  saveLocalStore(store);
  try {
    // Optimistic lock: re-read target row updatedAt
    const lastCol = columnLetter(HEADERS.length);
    const all = await sheets.get(config.spreadsheetId, `${quoteTab(LEDGER_TAB)}!A2:${lastCol}`);
    let sheetRowIndex = all.findIndex((v) => String(v[0] || '') === row.id);
    if (sheetRowIndex >= 0) {
      const current = valuesToRow(all[sheetRowIndex]);
      if (previousUpdatedAt && current.updatedAt && current.updatedAt !== previousUpdatedAt) {
        // conflict: re-apply status fields onto fresh row
        const merged = { ...current, ...row, updatedAt: toIsoJst() };
        all[sheetRowIndex] = rowToValues(merged);
        await sheets.update(
          config.spreadsheetId,
          `${quoteTab(LEDGER_TAB)}!A${sheetRowIndex + 2}:${lastCol}${sheetRowIndex + 2}`,
          [rowToValues(merged)],
        );
        Object.assign(row, merged);
      } else {
        await sheets.update(
          config.spreadsheetId,
          `${quoteTab(LEDGER_TAB)}!A${sheetRowIndex + 2}:${lastCol}${sheetRowIndex + 2}`,
          [rowToValues(row)],
        );
      }
    } else {
      await sheets.append(config.spreadsheetId, `${quoteTab(LEDGER_TAB)}!A:${lastCol}`, [rowToValues(row)]);
    }

    delete row._pendingSheet;
    delete store.items.find((r) => r.id === row.id)._pendingSheet;
    await persistHistory(ctx);
  } catch (error) {
    store.pendingSync = true;
    store.syncError = classifySheetError(error, config).message;
    saveLocalStore(store);
  }
  return row;
}


async function persistHistory(ctx) {
  const { store, storeMode, config, sheets } = ctx;
  if (ctx.dryRun && storeMode === 'sheet') return;
  if (storeMode === 'sheet' && sheets && config.spreadsheetId) {
    const pending = store.history.filter((h) => h._pendingSheet);
    try {
      if (pending.length) await sheets.append(config.spreadsheetId, `${quoteTab(HISTORY_TAB)}!A:G`, pending.map((h) => [
        h.at, h.id, h.status, h.reason, h.messageId, h.pc, h.ai,
      ]));
      for (const h of pending) delete h._pendingSheet;
      store.pendingSync = store.items.some((r) => r._pendingSheet);
      store.syncError = null;
    } catch (error) {
      store.pendingSync = true;
      store.syncError = classifySheetError(error, config).message;
    }
  }
  saveLocalStore(store);
}

function alertPath(config, flags = {}) {
  if (flags['alert-file']) return expandHome(String(flags['alert-file']));
  return expandHome(config.alertFile || DEFAULT_CONFIG.alertFile);
}

export function renderAlert({
  now = new Date(),
  checked = 0,
  stalled = [],
  escalated = [],
  awaitingApproval = [],
  missingOwner = [],
  alertRows = [],
  alerts = [],
  pendingSync = false,
  syncError = null,
  quietDue = [],
  outcomeWarnings = [],
} = {}) {
  const stalledList = stalled.length ? stalled : alertRows.filter((r) => r.status === '止まった');
  const escalatedList = escalated.length ? escalated : alertRows.filter((r) => r.status === 'エスカレーション');
  const approvalList = awaitingApproval.length ? awaitingApproval : alertRows.filter((r) => r.status === '承認待ち');
  const missingList = missingOwner;
  const tableRows = alertRows.length
    ? alertRows
    : [...new Map([...stalledList, ...escalatedList, ...approvalList, ...missingList].map((r) => [r.id || `sheet-row-${r._sheetRow}`, r])).values()];

  const lines = [
    `# followup-ledger ALERT`,
    `時刻: ${toIsoJst(now)}`,
    `確認件数: ${checked}`,
    `止まった: ${stalledList.length}件`,
    `エスカレーション: ${escalatedList.length}件`,
    `承認待ち: ${approvalList.length}件`,
    `担当PC不在: ${missingList.length}件`,
  ];
  if (pendingSync) lines.push(`シート未同期（${syncError || '理由不明'}）`);
  if (quietDue.length) {
    lines.push('', '## quietHours 中に期限到来');
    for (const r of quietDue) lines.push(`- ${r.id}: ${r.to} / ${r.task} / due=${r.dueAt}`);
  }
  if (tableRows.length) {
    lines.push('', '## 一覧');
    lines.push('| 依頼ID | 依頼先 | 担当者区分 | 居住地・最寄り | 状態 | 理由 | 次回確認 |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- |');
    for (const r of tableRows) {
      const reason = r._alertReason || r.statusReason || '';
      lines.push(`| ${r.id || ''} | ${r.to || ''} | ${r.assigneeRole || ''} | ${r.assigneeLocation || ''} | ${r.status || ''} | ${reason} | ${r.nextCheckAt || ''} |`);
    }
  }
  const reassign = tableRows.filter((r) => String(r.statusReason || r._alertReason || '').includes(CAFE_SOLO_REASON));
  if (reassign.length) {
    lines.push('', '## 付け替えが必要（店を離れる作業）');
    for (const r of reassign) lines.push(`- ${r.id}: ${r.to} / ${r.task || ''} / ${r.assigneeLocation || '未記入'}`);
  }
  if (stalledList.length) {
    lines.push('', '## 止まった');
    for (const r of stalledList) lines.push(`- ${r.id}: ${r.statusReason || ''}`);
  }
  if (outcomeWarnings.length) {
    lines.push('', '## 成果警告');
    for (const r of outcomeWarnings) lines.push(`- ${r.id}: ${r._outcomeReason || r.statusReason || ''}`);
  }
  if (alerts.length) {
    lines.push('', '## 詳細');
    for (const a of alerts) lines.push(`- ${a}`);
  }
  lines.push('');
  return lines.join('\n');
}

export function writeAlert(file, payload) {
  atomicText(file, renderAlert(payload));
  return file;
}

async function cmdInit(flags) {
  const config = loadConfig();
  const shareDomain = flags['share-domain'] || 'orgiast.jp';
  const editor = flags.editor || 'kim@orgiast.jp';
  const result = await ensureSpreadsheet(config, { shareDomain, editor });
  config.spreadsheetId = result.spreadsheetId;
  config.url = result.url;
  saveConfig(config);
  console.log(JSON.stringify({
    spreadsheetId: result.spreadsheetId,
    url: result.url,
    permissions: result.permissions.map((p) => ({
      type: p.type, role: p.role, emailAddress: p.emailAddress || null, domain: p.domain || null,
    })),
  }, null, 2));
  return 0;
}

export function sheetCredentialSources() {
  const keyPath = process.env.GOOGLE_SA_KEY ?? defaultDriveKeyPath();
  const home = process.env.ORGIAST_HOME || os.homedir();
  let relayAvailable = false;
  try { relayAvailable = Boolean(keyserveSecret(home, process.env)); } catch { /* report presence only */ }
  let relay = '(未設定)';
  try {
    const url = new URL('/api/gws', process.env.ORGIAST_CHANNEL_BASE_URL || 'https://orgiast-memoryserve.vercel.app');
    relay = `${url.origin}${url.pathname}`;
  } catch { /* never print a malformed URL containing credentials */ }
  return { keyPath, keyExists: fs.existsSync(keyPath), relay, relayAvailable };
}

export function classifySheetError(error, config, sources = sheetCredentialSources()) {
  const messages = [];
  for (let e = error, depth = 0; e && depth < 5; e = e.cause, depth++) messages.push(`${e.status || ''} ${e.code || ''} ${e.message || e}`);
  const detail = messages.join(' ');
  let category;
  if (!config.spreadsheetId) category = 'spreadsheetId 未設定';
  else if (/\b40[13]\b|権限なし/.test(detail)) category = '権限なし';
  else if (/鍵なし|credential missing|ENOENT/.test(detail)) category = '鍵なし';
  else if (/\b5\d\d\b|fetch|network|通信失敗|ECONN|ETIMEDOUT|timeout|ENOTFOUND/i.test(detail)) category = '通信失敗';
  else category = !sources.keyExists && !sources.relayAvailable ? '鍵なし' : '通信失敗';
  const hint = category === '権限なし'
    ? `impersonate=${config.owner || DEFAULT_CONFIG.owner}。シートの共有に ${config.owner || DEFAULT_CONFIG.owner} が編集者か確認してください`
    : category === '鍵なし' ? `確認した鍵パス: ${sources.keyPath} / relay先: ${sources.relay}（資格情報 ${sources.relayAvailable ? 'あり' : 'なし'}）`
      : category === 'spreadsheetId 未設定' ? 'config/followup-ledger.json の spreadsheetId を設定してください'
        : 'シートへ到達できません。doctor で確認し、復旧後 sync を実行してください';
  // Do not expose raw upstream bodies, tokens, or credential values.
  return { category, message: `${category}: ${hint}` };
}

function printAddResult(row, store, loaded, config, storeMode, upsert = false) {
  const failed = storeMode === 'sheet' && (store.pendingSync || loaded.sheetError);
  const failure = failed ? (loaded.sheetFailure || classifySheetError(new Error(store.syncError || loaded.sheetError), config)) : null;
  console.log(JSON.stringify({ ok: !failed, upsert, id: row.id, status: row.status, statusReason: row.statusReason,
    registeredFrom: currentPcName(), effectiveOwnerPc: effectiveOwnerPc(row, config), ...(failure || {}) }));
  return failed ? 3 : 0;
}

async function cmdDoctor(flags, ctxBase = {}) {
  const config = ctxBase.config || loadConfig();
  const sources = sheetCredentialSources();
  const result = { configPath: config._path || CONFIG_PATH, spreadsheetId: config.spreadsheetId,
    impersonate: config.owner || DEFAULT_CONFIG.owner, currentPc: currentPcName(), hubPc: config.hubPc || DEFAULT_CONFIG.hubPc,
    sources, headers: {}, ok: false };
  try {
    if (!config.spreadsheetId) throw new Error('spreadsheetId 未設定');
    const sheets = ctxBase.sheets || createSheetsClient({ getToken: (opts) => getDriveToken({ ...opts, impersonate: result.impersonate }) });
    for (const [tab, headers] of [[LEDGER_TAB, HEADERS], [HISTORY_TAB, HISTORY_HEADERS]]) {
      const values = await sheets.get(config.spreadsheetId, `${quoteTab(tab)}!A1:${columnLetter(headers.length)}1`);
      result.headers[tab] = { readable: true, matches: headers.every((h, i) => values[0]?.[i] === h), values: values[0] || [] };
    }
    result.ok = Object.values(result.headers).every((h) => h.matches);
    if (!result.ok) result.message = 'シートのヘッダ不一致（doctor は修正しません）';
  } catch (error) { Object.assign(result, classifySheetError(error, config, sources)); }
  if (flags.json) console.log(JSON.stringify(result, null, 2));
  else console.log(`PC: ${result.currentPc} / hubPc: ${result.hubPc}\nconfig: ${result.configPath}\nspreadsheetId: ${result.spreadsheetId || '(未設定)'}\nimpersonate: ${result.impersonate}\n鍵パス: ${sources.keyPath}（${sources.keyExists ? 'あり' : 'なし'}）\nrelay先: ${sources.relay}（資格情報 ${sources.relayAvailable ? 'あり' : 'なし'}）\nヘッダ: ${result.ok ? '読取成功・一致' : result.message}`);
  return result.ok ? 0 : 3;
}

async function cmdSync(flags, ctxBase = {}) {
  const config = ctxBase.config || loadConfig();
  const loaded = await loadStore({ storeMode: 'sheet', config, sheets: ctxBase.sheets });
  const { store, sheets } = loaded;
  let synced = 0;
  if (sheets && !loaded.sheetError) {
    try {
      for (const row of store.items.filter((r) => r._pendingSheet)) {
        // Re-read before each append; never overwrite an existing sheet row.
        const values = await sheets.get(config.spreadsheetId, `${quoteTab(LEDGER_TAB)}!A2:${columnLetter(HEADERS.length)}`);
        if (!values.some((v) => String(v[0]) === row.id)) await sheets.append(config.spreadsheetId, `${quoteTab(LEDGER_TAB)}!A:${columnLetter(HEADERS.length)}`, [rowToValues(row)]);
        delete row._pendingSheet;
        synced++;
        saveLocalStore(store);
      }
      await persistHistory({ ...loaded, storeMode: 'sheet', config });
    } catch (error) {
      store.pendingSync = true;
      store.syncError = classifySheetError(error, config).message;
      saveLocalStore(store);
    }
  }
  const failed = Boolean(loaded.sheetError || store.pendingSync);
  console.log(JSON.stringify({ ok: !failed, synced, pendingRows: store.items.filter((r) => r._pendingSheet).length,
    pendingHistory: store.history.filter((h) => h._pendingSheet).length,
    ...(failed ? loaded.sheetFailure || classifySheetError(new Error(store.syncError || loaded.sheetError), config) : {}) }));
  return failed ? 3 : 0;
}

async function cmdAdd(flags, ctxBase = {}) {
  const config = ctxBase.config || loadConfig();
  const storeMode = flags.store === 'local' || ctxBase.storeMode === 'local' ? 'local' : 'sheet';
  const loaded = await loadStore({ storeMode, config, sheets: ctxBase.sheets });
  const store = loaded.store;
  const now = resolveNow(ctxBase.now);
  const row = rowFromArgs(flags, { now, config });
  if (!row.id) throw new Error('--id が必要です');
  assertStatusReason(row.status, row.statusReason);
  const existing = store.items.find((r) => r.id === row.id);
  if (existing && !flags.upsert) throw new Error(`同じ依頼IDが既にあります: ${row.id}（--upsert で更新）`);
  if (existing && flags.upsert) {
    Object.assign(existing, row, { nudgeCount: existing.nudgeCount, lastSentAt: existing.lastSentAt, lastSentId: existing.lastSentId });
    appendHistory(store, { id: row.id, status: existing.status, reason: 'upsert', ai: row.ownerAi, pc: currentPcName() });
    await persistRow({ ...loaded, storeMode, config, store }, existing, { previousUpdatedAt: existing.updatedAt });
    return printAddResult(existing, store, loaded, config, storeMode, true);
  }
  store.items.push(row);
  appendHistory(store, { id: row.id, status: row.status, reason: row.statusReason || 'add', ai: row.ownerAi, pc: currentPcName() });
  if (row.status === '止まった') {
    await escalate(row, row.statusReason, {
      config, store, dryRun: Boolean(flags['dry-run']), alerts: [],
      adapterDeps: ctxBase.adapterDeps, spawn: ctxBase.spawn, escalations: [],
    });
  }
  await persistRow({ ...loaded, storeMode, config, store }, row);
  return printAddResult(row, store, loaded, config, storeMode);
}

async function sendApprovalRequest(row, ctx) {
  const { config, store, dryRun, alerts } = ctx;
  const channelId = config.approvalChannelId || DEFAULT_CONFIG.approvalChannelId;
  const text = await withTemaRecord([
    `【followup-ledger 承認依頼】`,
    `依頼ID: ${row.id}`,
    `宛先: ${row.to}`,
    `チャネル: ${row.channel}`,
    `内容:`,
    defaultNudgeText(row),
    ``,
    `OK なら『OK ${row.id}』と返信`,
  ].join('\n'), row, ctx);
  if (dryRun) {
    alerts.push(`[dry-run] approval → ${channelId}: ${row.id}`);
    ctx.approvals = ctx.approvals || [];
    ctx.approvals.push({ channelId, id: row.id, text });
    setRowStatus(row, '承認待ち', 'external承認待ち');
    appendHistory(store, { id: row.id, status: '承認待ち', reason: 'approval-request(dry-run)' });
    return { ok: true, dryRun: true };
  }
  const adapter = getAdapter(process.env.FOLLOWUP_ADAPTER === 'mock' ? 'mock' : 'discord', ctx.adapterDeps);
  const sendRow = { ...row, channel: 'discord', chatId: channelId };
  const result = await adapter.send(sendRow, text);
  if (!result.ok) {
    await escalate(row, `承認依頼送信失敗: ${result.error}`, ctx);
    return result;
  }
  setRowStatus(row, '承認待ち', 'external承認待ち');
  row.lastSentAt = toIsoJst();
  row.lastSentId = result.messageId || '';
  row.nudgeCount = Number(row.nudgeCount || 0) + 1;
  appendHistory(store, { id: row.id, status: '承認待ち', reason: 'approval-request', messageId: result.messageId });
  alerts.push(`承認依頼送信: ${row.id} → ${channelId}`);
  return result;
}

async function performNudge(row, ctx) {
  const { config, store, dryRun, alerts, noNudge, force, now = new Date() } = ctx;
  if (row.status === '完了') return { skipped: true, reason: 'already-complete' };
  const missing = checkPrereq(row);
  if (missing.length) {
    await stopForPrereq(row, missing, ctx);
    return { skipped: true, reason: 'prereq-missing' };
  }
  const constraint = siteConstraint(row);
  if (constraint.blocked) {
    const reason = prependReason(constraint.reason, row.statusReason);
    setRowStatus(row, '止まった', reason);
    await escalate(row, reason, ctx);
    return { skipped: true, reason: 'cafe-solo-off-site' };
  }
  const decision = decideAction(row, [], now);
  if (decision.action === 'escalate' || (Number(row.maxNudges) > 0 && Number(row.nudgeCount) >= Number(row.maxNudges) && !force)) {
    await escalate(row, decision.reason || `最大催促回数(${row.maxNudges})超過`, ctx);
    return { skipped: true, reason: 'max-nudges' };
  }

  if (row.scope === 'external' && row.status !== '承認待ち') {
    return sendApprovalRequest(row, ctx);
  }

  if (isQuietHours(now, config.quietHours) && row.scope === 'internal') {
    const next = nextQuietEnd(now, config.quietHours);
    row.nextCheckAt = next;
    appendHistory(store, { id: row.id, status: row.status, reason: `quietHoursのため催促延期→${next}` });
    alerts.push(`quietHours延期: ${row.id} → ${next}`);
    return { skipped: true, reason: 'quiet-hours', nextCheckAt: next };
  }

  const text = dryRun ? withAiFooter(defaultNudgeText(row)) : await withTemaRecord(withAiFooter(defaultNudgeText(row)), row, ctx);
  const adapter = getAdapter(row.channel, ctx.adapterDeps);

  // Pre-read: duplicate prevention
  const sinceIso = row.lastSentAt || row.requestedAt;
  const fetched = await adapter.fetchReplies(row, sinceIso);
  if (!fetched.ok) {
    setRowStatus(row, '止まった', fetched.error || '取得失敗');
    await escalate(row, fetched.error || '取得失敗', ctx);
    return { skipped: true, reason: 'fetch-fail' };
  }
  if (!force && recentSelfNudge(fetched.messages, text, row.renudgeMin, now)) {
    appendHistory(store, { id: row.id, status: row.status, reason: '重複のため送らず' });
    alerts.push(`重複のため送らず: ${row.id}`);
    return { skipped: true, reason: 'duplicate' };
  }

  if (noNudge || dryRun) {
    alerts.push(`[${dryRun ? 'dry-run' : 'no-nudge'}] nudge ${row.id}: ${text.slice(0, 80)}`);
    if (dryRun) {
      ctx.nudges = ctx.nudges || [];
      ctx.nudges.push({ id: row.id, text, temaCheckRequired: !row.temaCheck });
    }
    return { skipped: true, reason: dryRun ? 'dry-run' : 'no-nudge', text };
  }

  const sent = await adapter.send(row, text, { now });
  if (!sent.ok) {
    setRowStatus(row, '止まった', sent.error || '送信失敗');
    await escalate(row, sent.error || '送信失敗', ctx);
    return { skipped: true, reason: 'send-fail' };
  }

  const read = await adapter.readBack(row, text, sent.messageId);
  if (!read.ok) {
    setRowStatus(row, '止まった', '送信未確認');
    await escalate(row, '送信未確認', ctx);
    return { skipped: true, reason: 'readback-fail' };
  }

  row.nudgeCount = Number(row.nudgeCount || 0) + 1;
  row.lastSentAt = toIsoJst(now);
  row.lastSentId = sent.messageId || '';
  setRowStatus(row, row.evidenceKind ? '依頼中' : '催促済み', row.evidenceKind ? '実物未確認・nudge-sent' : 'nudge-sent');
  appendHistory(store, { id: row.id, status: row.status, reason: 'nudge', messageId: sent.messageId });
  alerts.push(`催促送信: ${row.id}`);
  ctx.nudges = ctx.nudges || [];
  ctx.nudges.push({ id: row.id, text, messageId: sent.messageId });
  return { ok: true, messageId: sent.messageId, text };
}

async function checkApproval(row, ctx) {
  const { config, store, alerts, now = new Date() } = ctx;
  const channelId = config.approvalChannelId || DEFAULT_CONFIG.approvalChannelId;
  const approvers = config.approverUserIds || [];
  const adapter = getAdapter(process.env.FOLLOWUP_ADAPTER === 'mock' ? 'mock' : 'discord', ctx.adapterDeps);
  const approvalRow = { ...row, channel: 'discord', chatId: channelId };
  const since = row.lastSentAt || row.requestedAt;
  const fetched = await adapter.fetchReplies(approvalRow, since);
  if (!fetched.ok) {
    setRowStatus(row, '止まった', fetched.error || '承認チャンネル取得失敗');
    await escalate(row, fetched.error || '承認チャンネル取得失敗', ctx);
    return;
  }

  const okRe = new RegExp(`OK\\s+${row.id}\\b`, 'i');
  const approved = fetched.messages.find((m) => {
    if (m.isSelf) return false;
    if (!okRe.test(m.text || '')) return false;
    if (!approvers.length) return false; // safe: nobody can approve while empty
    const author = String(m.authorId || m.from || '');
    return approvers.includes(author);
  });

  if (approved) {
    alerts.push(`承認検出: ${row.id} by ${approved.authorId || approved.from}`);
    // Temporarily treat as internal send path for the actual channel
    const scope = row.scope;
    row.scope = 'internal';
    row.status = '依頼中';
    const result = await performNudge(row, { ...ctx, force: true });
    row.scope = scope;
    if (result?.ok) {
      appendHistory(store, { id: row.id, status: row.status, reason: 'approved-and-sent', messageId: result.messageId });
    }
    return;
  }

  if (!approvers.length) {
    alerts.push(`承認者未設定のため承認待ち維持: ${row.id}`);
  }

  const timeoutMin = Number(config.approvalTimeoutMinutes || 120);
  const last = Date.parse(row.lastSentAt || row.requestedAt || 0);
  if (Number.isFinite(last) && now.getTime() >= last + timeoutMin * 60_000) {
    if (Number(row.nudgeCount) >= Number(row.maxNudges)) {
      await escalate(row, '承認期限超過・最大催促回数', ctx);
    } else {
      await sendApprovalRequest(row, ctx);
    }
  }
}

async function processRow(row, ctx) {
  const { store, alerts, now = new Date(), noNudge, dryRun } = ctx;
  const previousUpdatedAt = row.updatedAt;
  row.lastCheckedAt = toIsoJst(now);
  row.nextCheckAt = toIsoJst(new Date(now.getTime() + Number(row.intervalMin || 15) * 60_000));
  const missing = checkPrereq(row);
  if (missing.length) {
    await stopForPrereq(row, missing, ctx);
    await persistRow(ctx, row, { previousUpdatedAt });
    return;
  }
  const recovered = row.status === '止まった' && row.statusReason.startsWith('前提欠落:');
  if (recovered) {
    setRowStatus(row, '依頼中', '前提が揃った');
    appendHistory(store, { id: row.id, status: row.status, reason: row.statusReason, at: toIsoJst(now) });
  }
  if (row.requestKind === 'automation' || row.outcomeSource) {
    await applyOutcome(row, outcomeSnapshot(row, store, now), ctx);
    await persistRow(ctx, row, { previousUpdatedAt });
    return;
  }
  if (recovered) {
    await persistRow(ctx, row, { previousUpdatedAt });
    return;
  }
  const adapter = getAdapter(row.channel, ctx.adapterDeps);

  if (row.status === '承認待ち') {
    await checkApproval(row, ctx);
    row.lastCheckedAt = toIsoJst(now);
    row.nextCheckAt = toIsoJst(new Date(now.getTime() + Number(row.intervalMin || 15) * 60_000));
    await persistRow(ctx, row, { previousUpdatedAt });
    return;
  }

  const since = row.lastSentAt || row.requestedAt;
  const fetched = await adapter.fetchReplies(row, since);
  if (!fetched.ok) {
    setRowStatus(row, '止まった', fetched.error || '取得失敗');
    await escalate(row, fetched.error || '取得失敗', ctx);
    row.lastCheckedAt = toIsoJst(now);
    row.nextCheckAt = toIsoJst(new Date(now.getTime() + Number(row.intervalMin || 15) * 60_000));
    await persistRow(ctx, row, { previousUpdatedAt });
    return;
  }

  const decision = decideAction(row, fetched.messages, now);

  if (decision.action === 'complete') {
    row.evidence = decision.evidence;
    setRowStatus(row, '完了', decision.reason);
    appendHistory(store, {
      id: row.id, status: '完了',
      reason: `証拠: ${decision.evidence || ''}`,
      messageId: decision.messageId || '',
    });
    alerts.push(`完了: ${row.id}`);
  } else if (decision.action === 'reassign') {
    const reason = prependReason(decision.reason, row.statusReason);
    setRowStatus(row, '止まった', reason);
    await escalate(row, reason, ctx);
  } else if (decision.action === 'reply_incomplete') {
    row.statusReason = decision.reason;
    row.updatedAt = toIsoJst(now);
    appendHistory(store, { id: row.id, status: row.status, reason: decision.reason });
    const infoBody = `followup-ledger: ${row.id}\n${decision.reason}`;
    const target = String(row.escalateTo || 'kim-inbox');
    if (dryRun) {
      ctx.escalations = ctx.escalations || [];
      ctx.escalations.push({ target: `${target}-info`, id: row.id, reason: decision.reason, body: infoBody });
      alerts.push(`[dry-run] info → ${target}: ${row.id}`);
    } else if (target === 'kim-inbox') {
      await escalateKimInboxInfo(row.id, infoBody, ctx);
    } else if (target.startsWith('discord:')) {
      const channelId = target.slice('discord:'.length);
      const disc = getAdapter('discord', ctx.adapterDeps);
      await disc.send({ ...row, channel: 'discord', chatId: channelId }, infoBody);
    } else {
      alerts.push(`info(${target}): ${row.id} ${decision.reason}`);
    }
    alerts.push(decision.reason);
  } else if (decision.action === 'nudge' || decision.action === 'request_approval') {
    if (decision.action === 'request_approval') await sendApprovalRequest(row, ctx);
    else await performNudge(row, { ...ctx, noNudge });
  } else if (decision.action === 'escalate') {
    await escalate(row, decision.reason, ctx);
  }

  row.lastCheckedAt = toIsoJst(now);
  if (!isQuietHours(now, ctx.config.quietHours) || row.scope !== 'internal') {
    row.nextCheckAt = toIsoJst(new Date(now.getTime() + Number(row.intervalMin || 15) * 60_000));
  }
  await persistRow(ctx, row, { previousUpdatedAt });
}

async function escalateKimInboxInfo(id, body, ctx) {
  const { spawn = spawnSync, alerts } = ctx;
  const kimInbox = path.join(REPO_ROOT, 'tools', 'kim-inbox.mjs');
  ctx.escalations = ctx.escalations || [];
  ctx.escalations.push({ target: 'kim-inbox-info', id, body });
  if (ctx.dryRun || (process.env.FOLLOWUP_ADAPTER === 'mock' && !ctx.spawn)) {
    if (process.env.FOLLOWUP_ADAPTER === 'mock') recordMockSpawn(process.execPath, [kimInbox, '--add', '--kind', 'info', '--dedupe-key', `followup-ledger-info:${id}`], body);
    alerts.push(`[記録のみ] kim-inbox info: ${id}`);
    return;
  }
  const tmp = path.join(homeRoot(), `info-${id}.${process.pid}.txt`);
  fs.mkdirSync(path.dirname(tmp), { recursive: true });
  fs.writeFileSync(tmp, body);
  try {
    const added = spawn(process.execPath, [
      kimInbox, '--add', '--kind', 'info', '--body-file', tmp, '--dedupe-key', `followup-ledger-info:${id}`, '--source', 'followup-ledger',
    ], { encoding: 'utf8', windowsHide: true, timeout: 60_000, env: process.env });
    if (added.status === 0) alerts.push(`kim-inbox info: ${id}`);
    else alerts.push(`kim-inbox info 失敗: ${(added.stderr || '').slice(0, 80)}`);
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

async function stopOnce(row, reason, ctx) {
  setRowStatus(row, '止まった', reason);
  const day = toIsoJst(ctx.now).slice(0, 10);
  const category = reason.split(':')[0] + ':';
  const exists = ctx.store.history.some((h) => h.id === row.id && h.status === '止まった'
    && h.reason.startsWith(category) && String(h.at).slice(0, 10) === day);
  if (!exists) await escalate({ ...row, escalateTo: 'kim-inbox' }, reason, ctx);
}

async function stopForPrereq(row, missing, ctx) {
  const reason = `前提欠落: ${missing.map((p) => `${p}（ファイルが無い）`).join('、')}`
    + (row.kimOnlyAction ? `／金さんだけができること: ${row.kimOnlyAction}` : '');
  await stopOnce(row, reason, ctx);
}

function outcomeSnapshot(row, store, now) {
  const source = readOutcome(row.outcomeSource, { now });
  if (source) return source;
  const observed = [...store.history].reverse().find((h) => h.id === row.id && h.reason.startsWith('outcome-observation:'));
  if (observed) {
    try { return JSON.parse(observed.reason.slice('outcome-observation:'.length)); } catch { /* fall back */ }
  }
  return null;
}

async function applyOutcome(row, snapshot, ctx) {
  if (snapshot?.lastOutcomeAt && Number.isFinite(Date.parse(snapshot.lastOutcomeAt)) && Date.parse(snapshot.lastOutcomeAt) <= ctx.now.getTime()) {
    if (!row.lastOutcomeAt || Date.parse(snapshot.lastOutcomeAt) > Date.parse(row.lastOutcomeAt)) row.lastOutcomeAt = snapshot.lastOutcomeAt;
  }
  const result = evaluateOutcomeLiveness(row, snapshot, ctx.now, ctx.config);
  if (result.state === 'stalled') {
    const reason = result.reason + (row.kimOnlyAction ? `／金さんだけができること: ${row.kimOnlyAction}` : '');
    await stopOnce(row, reason, ctx);
  } else if (row.status === '止まった' && row.statusReason.startsWith('成果ゼロ:')) {
    setRowStatus(row, '依頼中', result.reason || '成果を確認');
    appendHistory(ctx.store, { id: row.id, status: row.status, reason: row.statusReason, at: toIsoJst(ctx.now) });
  }
  return result;
}

function collectOutcomeWarnings(store, now, config) {
  return store.items.filter((r) => r.status !== '完了' && (r.requestKind === 'automation' || r.outcomeSource))
    .flatMap((row) => {
      const result = evaluateOutcomeLiveness(row, outcomeSnapshot(row, store, now), now, config);
      return result.state === 'ok' ? [] : [{ ...row, _outcomeReason: result.reason }];
    });
}

async function cmdOutcome(flags, ctxBase = {}) {
  const config = ctxBase.config || loadConfig();
  const storeMode = flags.store === 'local' || ctxBase.storeMode === 'local' ? 'local' : (config.spreadsheetId ? 'sheet' : 'local');
  const loaded = await loadStore({ storeMode, config, sheets: ctxBase.sheets });
  const now = resolveNow(ctxBase.now);
  const row = loaded.store.items.find((r) => r.id === String(flags.id || ''));
  if (!row) throw new Error('依頼IDが見つかりません');
  const previousUpdatedAt = row.updatedAt;
  const ctx = { ...ctxBase, ...loaded, storeMode, config, now, alerts: [], escalations: [], dryRun: Boolean(flags['dry-run']) };
  if (flags['job-result'] != null) {
    const at = flags['job-at'] || toIsoJst(now);
    if (!Number.isFinite(Date.parse(at)) || !/^-?\d+$/.test(String(flags['job-result']))) throw new Error('ジョブ結果・日時が不正です');
    row.lastJobResult = `${flags['job-result']}@${at}`;
  }
  const snapshot = { lastOutcomeAt: row.lastOutcomeAt, outcomes: [], pendingApproved: 0, ...(outcomeSnapshot(row, loaded.store, now) || {}) };
  if (flags['last-outcome-at'] != null) {
    if (!Number.isFinite(Date.parse(flags['last-outcome-at'])) || Date.parse(flags['last-outcome-at']) > now.getTime()) throw new Error('最終成果の日時が不正です');
    row.lastOutcomeAt = String(flags['last-outcome-at']);
    snapshot.lastOutcomeAt = row.lastOutcomeAt;
  }
  if (flags['pending-approved'] != null) {
    const count = Number(flags['pending-approved']);
    if (!Number.isInteger(count) || count < 0) throw new Error('承認済み未投稿件数が不正です');
    snapshot.pendingApproved = count;
  }
  // キュー内の設定や本文を履歴へ丸ごと転記せず、観測した成果の事実だけ残す。
  const observation = {
    lastOutcomeAt: snapshot.lastOutcomeAt,
    outcomes: (snapshot.outcomes || []).map((o) => ({ postedAt: o?.postedAt || '', postUrl: o?.postUrl || '' })),
    pendingApproved: snapshot.pendingApproved,
  };
  appendHistory(loaded.store, { id: row.id, status: row.status, reason: `outcome-observation:${JSON.stringify(observation)}`, at: toIsoJst(now), pc: currentPcName() });
  if (flags['prereq-missing']) {
    const file = String(flags['prereq-missing']);
    const entries = String(row.prereq || '').split(';').filter(Boolean);
    if (!entries.includes(`file:${file}`)) row.prereq = [...entries, `file:${file}`].join(';');
    await stopForPrereq(row, [file], ctx);
  } else {
    // 他PCからの観測時は、そのPCにない前提パスを勝手に検査しない。
    await applyOutcome(row, snapshot, ctx);
  }
  await persistRow(ctx, row, { previousUpdatedAt });
  console.log(JSON.stringify({ ok: true, id: row.id, status: row.status, reason: row.statusReason }));
  return 0;
}

function missingOwnerRows(store, now, thisPc, pcOpts, config) {
  return store.items.filter((r) => r.status !== '完了' && !isOwnerPcMatch(effectiveOwnerPc(r, config), thisPc, pcOpts)
    && (!r.lastCheckedAt || !Number.isFinite(Date.parse(r.lastCheckedAt)) || now.getTime() - Date.parse(r.lastCheckedAt) > watchdogStaleMs(r)))
    .map((r) => ({ ...r, _alertReason: `担当PC ${effectiveOwnerPc(r, config)} がこの依頼を見ていない（最終確認 ${r.lastCheckedAt || 'なし'}）` }));
}

const REQUEST_LABELS = { ai: 'AI', human: '人', globo: 'グロボ', 'claude-code': 'Claude Code', automation: '自動化' };
function reportTable(rows) {
  const cell = (s) => String(s || '').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
  return [
    '| 依頼ID | 依頼種別 | 依頼元 | 依頼先 | 内容 | 期限 | 状態 | 理由 | 金さんだけができること | 付け替え先 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...rows.map((r) => `| ${[r.id, REQUEST_LABELS[r.requestKind || 'human'] || r.requestKind, r.requestedBy, r.to, r.task, r.dueAt,
      r.status, [r.statusReason, r._alertReason, r._outcomeReason].filter(Boolean).join('／'), r.kimOnlyAction, r.reassignTo].map(cell).join(' | ')} |`),
  ];
}

async function cmdReport(flags, ctxBase = {}) {
  const config = ctxBase.config || loadConfig();
  const storeMode = flags.store === 'local' || ctxBase.storeMode === 'local' ? 'local' : (config.spreadsheetId ? 'sheet' : 'local');
  const loaded = await loadStore({ storeMode, config, sheets: ctxBase.sheets });
  const { store } = loaded;
  const now = resolveNow(ctxBase.now);
  const missingOwner = missingOwnerRows(store, now, currentPcName({ hostname: ctxBase.hostname }), {
    pcMap: ctxBase.pcMap || loadFleetPcMap(), pcAliases: config.pcAliases,
  }, config);
  const outcomeWarnings = collectOutcomeWarnings(store, now, config);
  const problems = store.items.filter((r) => r.status !== '完了' && (Date.parse(r.dueAt) < now.getTime()
    || ['止まった', 'エスカレーション', '承認待ち'].includes(r.status)));
  const combined = new Map();
  for (const row of [...problems, ...missingOwner, ...outcomeWarnings]) combined.set(row.id, { ...combined.get(row.id), ...row });
  const sections = [
    { title: '金さんの手が必要', rows: [...combined.values()].filter((r) => r.kimOnlyAction) },
    { title: '止まった・期限超過', rows: problems.filter((r) => !r.kimOnlyAction) },
    { title: '担当PC不在', rows: missingOwner },
    { title: '成果警告', rows: outcomeWarnings },
  ];
  const lines = ['# followup-ledger 朝の報告', `時刻: ${toIsoJst(now)}`];
  if (store.pendingSync || loaded.sheetError) lines.push(`シート未同期（${store.syncError || loaded.sheetError}）`);
  for (const section of sections) lines.push('', `## ${section.title}`, '', ...(section.rows.length ? reportTable(section.rows) : ['該当なし']));
  const body = `${lines.join('\n')}\n`;
  const file = expandHome(String(flags.out || config.morningReportFile || DEFAULT_CONFIG.morningReportFile));
  atomicText(file, body);
  const key = `followup-morning-${toIsoJst(now).slice(0, 10).replace(/-/g, '')}`;
  const spawns = [];
  if (flags['kim-inbox'] && !store.history.some((h) => h.id === key && h.reason === 'morning-report')) {
    const args = [path.join(REPO_ROOT, 'tools', 'kim-inbox.mjs'), '--add', '--kind', 'info', '--force-kind', '--body-file', file, '--dedupe-key', key, '--source', 'followup-ledger'];
    const mock = process.env.FOLLOWUP_ADAPTER === 'mock';
    const dryRun = Boolean(flags['dry-run'] || ctxBase.dryRun);
    spawns.push({ command: process.execPath, args });
    if (dryRun && !flags.json) console.log(`[dry-run] kim-inbox info: ${key}`);
    if (mock) recordMockSpawn(process.execPath, args, body);
    else if (!dryRun) {
      const result = (ctxBase.spawn || spawnSync)(process.execPath, args, { encoding: 'utf8', windowsHide: true, timeout: 60_000, env: process.env });
      if (result.status !== 0) throw new Error(`朝の報告のkim-inbox登録失敗: ${result.error?.message || result.stderr || result.stdout || result.status}`);
    }
    if (!dryRun) {
      appendHistory(store, { id: key, status: '報告', reason: 'morning-report', at: toIsoJst(now), pc: currentPcName() });
      await persistHistory({ ...loaded, storeMode, config });
    }
  }
  if (flags.json) console.log(JSON.stringify({ file, sections, spawns, pendingSync: store.pendingSync }, null, 2));
  else console.log(body);
  return 0;
}

async function cmdCheck(flags, ctxBase = {}) {
  const config = ctxBase.config || loadConfig();
  const storeMode = flags.store === 'local' || ctxBase.storeMode === 'local' ? 'local' : (config.spreadsheetId ? 'sheet' : 'local');
  const loaded = await loadStore({ storeMode, config, sheets: ctxBase.sheets, readOnly: Boolean(flags['dry-run']) });
  const store = loaded.store;
  const now = resolveNow(ctxBase.now);
  const alerts = [];
  const quietDue = [];
  if (loaded.sheetError || store.pendingSync) {
    alerts.push(`シート未同期（${store.syncError || loaded.sheetError || '理由不明'}）`);
  }

  const thisPc = currentPcName({ env: process.env, hostname: ctxBase.hostname || os.hostname() });
  const allPcs = Boolean(flags['all-pcs']);
  const pcOpts = {
    pcMap: ctxBase.pcMap || loadFleetPcMap(),
    pcAliases: config.pcAliases || DEFAULT_CONFIG.pcAliases,
  };

  const dueRows = store.items.filter((r) => {
    if (r.status === '完了') return false;
    if (['止まった', 'エスカレーション'].includes(r.status) && !/^(前提欠落:|成果ゼロ:)/.test(r.statusReason)) return false;
    if (flags.id && r.id !== String(flags.id)) return false;
    const next = Date.parse(r.nextCheckAt || 0);
    if (!Number.isFinite(next) || next <= now.getTime()) return true;
    // nextCheckAt が先でも、返答期限超過かつ未確認なら即処理（add 直後の取りこぼし防止）
    const neverChecked = !String(r.lastCheckedAt || '').trim();
    if (neverChecked && now.getTime() >= computeDue(r, now)) return true;
    return false;
  });

  const processRows = dueRows.filter((r) => allPcs || isOwnerPcMatch(effectiveOwnerPc(r, config), thisPc, pcOpts));
  const watchRows = store.items.filter((r) => {
    if (r.status === '完了') return false;
    if (flags.id && r.id !== String(flags.id)) return false;
    if (allPcs) return false;
    return !isOwnerPcMatch(effectiveOwnerPc(r, config), thisPc, pcOpts);
  });

  const ctx = {
    config,
    store,
    storeMode,
    sheets: loaded.sheets,
    dryRun: Boolean(flags['dry-run']),
    noNudge: Boolean(flags['no-nudge']),
    now,
    alerts,
    adapterDeps: ctxBase.adapterDeps || {},
    spawn: ctxBase.spawn,
    escalations: [],
    nudges: [],
    approvals: [],
    thisPc,
  };

  for (const row of processRows) {
    const dueMs = computeDue(row, now);
    if (isQuietHours(now, config.quietHours) && dueMs <= now.getTime()) {
      quietDue.push(row);
    }
    await processRow(row, ctx);
  }

  const missingOwner = [];
  let watchdogWrote = false;
  for (const row of watchRows) {
    const last = Date.parse(row.lastCheckedAt || 0);
    const stale = !Number.isFinite(last) || (now.getTime() - last) > watchdogStaleMs(row);
    if (!stale) continue;
    const reason = `担当PC ${effectiveOwnerPc(row, config)} がこの依頼を見ていない（最終確認 ${row.lastCheckedAt || 'なし'}）`;
    missingOwner.push({ ...row, _alertReason: reason });
    if (!hasWatchdogToday(store.history, row.id, now)) {
      appendHistory(store, {
        id: row.id,
        status: row.status,
        reason: 'watchdog',
        pc: thisPc,
        ai: row.ownerAi,
        at: toIsoJst(now),
      });
      alerts.push(reason);
      watchdogWrote = true;
    }
  }
  if (watchdogWrote || store.history.some((h) => h._pendingSheet)) await persistHistory(ctx);

  const stalled = store.items.filter((r) => r.status === '止まった');
  const escalated = store.items.filter((r) => r.status === 'エスカレーション');
  const awaitingApproval = store.items.filter((r) => r.status === '承認待ち');
  const alertRows = [...new Map(
    [...stalled, ...escalated, ...awaitingApproval, ...missingOwner].map((r) => [r.id || `sheet-row-${r._sheetRow}`, r]),
  ).values()];
  const file = writeAlert(alertPath(config, flags), {
    now,
    checked: processRows.length,
    stalled,
    escalated,
    awaitingApproval,
    missingOwner,
    alertRows,
    alerts,
    pendingSync: store.pendingSync,
    syncError: store.syncError || loaded.sheetError,
    quietDue,
    outcomeWarnings: collectOutcomeWarnings(store, now, config),
  });

  const summary = {
    processRows: processRows.map((r) => ({ id: r.id, effectiveOwnerPc: effectiveOwnerPc(r, config) })),
    checked: processRows.length,
    watched: watchRows.length,
    stalled: stalled.length,
    escalated: escalated.length,
    awaitingApproval: awaitingApproval.length,
    missingOwner: missingOwner.length,
    thisPc,
    alertFile: file,
    nudges: ctx.nudges,
    escalations: ctx.escalations,
    approvals: ctx.approvals,
  };
  if (flags.json) console.log(JSON.stringify(summary, null, 2));
  else {
    console.log(`check: ${summary.checked}件 / 止まった ${summary.stalled}件 / 担当PC不在 ${summary.missingOwner}件 / ALERT ${file}`);
  }
  return summary;
}

async function cmdNudge(flags, ctxBase = {}) {
  const config = ctxBase.config || loadConfig();
  const storeMode = flags.store === 'local' || ctxBase.storeMode === 'local' ? 'local' : (config.spreadsheetId ? 'sheet' : 'local');
  const loaded = await loadStore({ storeMode, config, sheets: ctxBase.sheets });
  const store = loaded.store;
  const id = String(flags.id || '');
  if (!id) throw new Error('--id が必要です');
  const row = store.items.find((r) => r.id === id);
  if (!row) throw new Error(`依頼IDが見つかりません: ${id}`);
  const alerts = [];
  const ctx = {
    config, store, storeMode, sheets: loaded.sheets,
    dryRun: Boolean(flags['dry-run']),
    force: Boolean(flags.force),
    now: resolveNow(ctxBase.now),
    alerts,
    adapterDeps: ctxBase.adapterDeps || {},
    spawn: ctxBase.spawn,
    nudges: [],
    escalations: [],
    approvals: [],
  };
  const previousUpdatedAt = row.updatedAt;
  const result = await performNudge(row, ctx);
  row.lastCheckedAt = toIsoJst(ctx.now);
  row.nextCheckAt = result?.reason === 'quiet-hours' ? result.nextCheckAt
    : toIsoJst(new Date(ctx.now.getTime() + Number(row.intervalMin || 15) * 60_000));
  await persistRow(ctx, row, { previousUpdatedAt });
  writeAlert(alertPath(config, flags), {
    now: ctx.now, checked: 1,
    stalled: store.items.filter((r) => r.status === '止まった'),
    alerts,
    pendingSync: store.pendingSync,
    syncError: store.syncError,
  });
  console.log(JSON.stringify({ ok: true, id, result, status: row.status, nudgeCount: row.nudgeCount }));
  return 0;
}

async function cmdComplete(flags, ctxBase = {}) {
  const config = ctxBase.config || loadConfig();
  const storeMode = flags.store === 'local' || ctxBase.storeMode === 'local' ? 'local' : (config.spreadsheetId ? 'sheet' : 'local');
  const loaded = await loadStore({ storeMode, config, sheets: ctxBase.sheets });
  const store = loaded.store;
  const id = String(flags.id || '');
  const evidence = flags.evidence === true ? '' : String(flags.evidence || '').trim();
  if (!id) throw new Error('--id が必要です');
  const row = store.items.find((r) => r.id === id);
  if (!row) throw new Error(`依頼IDが見つかりません: ${id}`);
  const validation = validateEvidence(row.evidenceKind, evidence);
  if (!validation.ok || (!evidence && row.requestKind !== 'human')) {
    console.error(validation.ok ? '完了の実物が無い' : validation.reason);
    return 2;
  }
  const previousUpdatedAt = row.updatedAt;
  row.evidence = evidence;
  setRowStatus(row, '完了', 'manual-complete');
  appendHistory(store, { id, status: '完了', reason: `証拠: ${evidence.slice(0, 200)}` });
  await persistRow({ ...loaded, storeMode, config, store }, row, { previousUpdatedAt });
  console.log(JSON.stringify({ ok: true, id, status: '完了' }));
  return 0;
}

async function cmdStop(flags, ctxBase = {}) {
  const config = ctxBase.config || loadConfig();
  const storeMode = flags.store === 'local' || ctxBase.storeMode === 'local' ? 'local' : (config.spreadsheetId ? 'sheet' : 'local');
  const loaded = await loadStore({ storeMode, config, sheets: ctxBase.sheets });
  const store = loaded.store;
  const id = String(flags.id || '');
  const reason = String(flags.reason || '');
  if (!id) throw new Error('--id が必要です');
  assertStatusReason('止まった', reason);
  const row = store.items.find((r) => r.id === id);
  if (!row) throw new Error(`依頼IDが見つかりません: ${id}`);
  const previousUpdatedAt = row.updatedAt;
  const alerts = [];
  setRowStatus(row, '止まった', reason);
  await escalate(row, reason, {
    config, store, dryRun: Boolean(flags['dry-run']), alerts,
    adapterDeps: ctxBase.adapterDeps || {}, spawn: ctxBase.spawn, escalations: [],
  });
  await persistRow({ ...loaded, storeMode, config, store }, row, { previousUpdatedAt });
  console.log(JSON.stringify({ ok: true, id, status: row.status, statusReason: row.statusReason }));
  return 0;
}

async function cmdStatus(flags, ctxBase = {}) {
  const config = ctxBase.config || loadConfig();
  const storeMode = flags.store === 'local' || ctxBase.storeMode === 'local' ? 'local' : (config.spreadsheetId ? 'sheet' : 'local');
  const loaded = await loadStore({ storeMode, config, sheets: ctxBase.sheets });
  let items = loaded.store.items;
  if (!flags.all) items = items.filter((r) => r.status !== '完了');
  if (flags.json) {
    console.log(JSON.stringify(items, null, 2));
    return 0;
  }
  if (!items.length) {
    console.log('(0件)');
    return 0;
  }
  const cols = ['id', 'to', 'assigneeRole', 'channel', 'scope', 'status', 'statusReason', 'dueAt', 'nudgeCount', 'nextCheckAt'];
  console.log(cols.join('\t'));
  for (const r of items) console.log(cols.map((c) => String(r[c] ?? '')).join('\t'));
  return 0;
}

async function cmdSeed(flags, ctxBase = {}) {
  const file = String(flags.file || '');
  if (!file) throw new Error('--file が必要です');
  const rows = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  if (!Array.isArray(rows)) throw new Error('seed は JSON 配列である必要があります');
  for (const raw of rows) {
    const mapped = {
      id: raw.id || raw['依頼ID'],
      to: raw.to || raw['依頼先'],
      channel: raw.channel || raw['チャネル'],
      chat: raw.chatId || raw.chat || raw['chatID'],
      scope: raw.scope || raw['社内外'],
      task: raw.task || raw['依頼内容'],
      'done-when': raw.doneWhen || raw['完了条件'],
      'done-pattern': raw.donePattern || raw['完了パターン'],
      interval: raw.intervalMin ?? raw.interval ?? raw['確認間隔分'],
      due: raw.dueAt || raw.due || raw['返答期限'],
      renudge: raw.renudgeMin ?? raw.renudge ?? raw['再催促分'],
      'max-nudges': raw.maxNudges ?? raw['最大催促回数'],
      escalate: raw.escalateTo || raw.escalate || raw['エスカレーション先'],
      'owner-ai': raw.ownerAi || raw['担当AI'],
      'owner-pc': raw.ownerPc || raw['担当PC'],
      case: raw.caseName || raw.case || raw['案件'],
      note: raw.note || raw['備考'],
      status: raw.status || raw['状態'],
      reason: raw.statusReason || raw.reason || raw['状態理由'],
      'requested-at': raw.requestedAt || raw['依頼日時'],
      'nudge-text': raw.nudgeText ?? raw['催促文'],
      'assignee-role': raw.assigneeRole || raw['担当者区分'],
      location: raw.assigneeLocation || raw['居住地・最寄り'],
      site: raw.taskSite || raw['作業場所'],
      'tema-check': raw.temaCheck || raw['手間チェック記録'],
      ...Object.fromEntries(Object.entries(REQUEST_FLAGS).map(([flag, field]) => [flag, raw[field] ?? raw[HEADERS[FIELDS.indexOf(field)]]])),
      upsert: flags.upsert,
      store: flags.store,
    };
    if (mapped['nudge-text'] == null) delete mapped['nudge-text'];
    await cmdAdd(mapped, ctxBase);
  }
  return 0;
}

async function cmdAlert(flags, ctxBase = {}) {
  const config = ctxBase.config || loadConfig();
  const storeMode = flags.store === 'local' || ctxBase.storeMode === 'local' ? 'local' : (config.spreadsheetId ? 'sheet' : 'local');
  const loaded = await loadStore({ storeMode, config, sheets: ctxBase.sheets });
  const now = resolveNow(ctxBase.now);
  const missingOwner = missingOwnerRows(loaded.store, now, currentPcName({ hostname: ctxBase.hostname }), {
    pcMap: ctxBase.pcMap || loadFleetPcMap(), pcAliases: config.pcAliases,
  }, config);
  const stalled = loaded.store.items.filter((r) => r.status === '止まった');
  const escalated = loaded.store.items.filter((r) => r.status === 'エスカレーション');
  const awaitingApproval = loaded.store.items.filter((r) => r.status === '承認待ち');
  const alertRows = [...new Map([...stalled, ...escalated, ...awaitingApproval, ...missingOwner].map((r) => [r.id || `sheet-row-${r._sheetRow}`, r])).values()];
  const file = writeAlert(alertPath(config, flags), {
    now,
    checked: 0,
    stalled,
    escalated,
    awaitingApproval,
    missingOwner,
    outcomeWarnings: collectOutcomeWarnings(loaded.store, now, config),
    alertRows,
    alerts: loaded.store.pendingSync ? [`シート未同期（${loaded.store.syncError || '理由不明'}）`] : [],
    pendingSync: loaded.store.pendingSync,
    syncError: loaded.store.syncError,
  });
  console.log(file);
  return 0;
}

async function cmdStalledScan(flags, ctxBase = {}) {
  const config = ctxBase.config || loadConfig();
  const storeMode = flags.store === 'local' || ctxBase.storeMode === 'local' ? 'local' : (config.spreadsheetId ? 'sheet' : 'local');
  const loaded = await loadStore({ storeMode, config, sheets: ctxBase.sheets });
  const store = loaded.store;
  const now = resolveNow(ctxBase.now);
  const nowMs = now.getTime();

  const reportsDir = flags['reports-dir'] ? String(flags['reports-dir']) : path.join(os.homedir(), 'gb-reports');
  const staleHours = Number(flags['stale-hours'] || 6);
  const pcName = String(flags.pc || currentPcName({ hostname: ctxBase.hostname }));
  const dryRun = Boolean(flags['dry-run']);

  // --selftest: check task registration
  if (flags.selftest) {
    const results = await stalledSelftest({ spawnImpl: ctxBase.spawn });
    console.log(JSON.stringify(results, null, 2));
    return results.every((r) => r.ok) ? 0 : 1;
  }

  const entries = scanReports(reportsDir, pcName, staleHours, nowMs);
  const alerts = [];
  let registered = 0;
  let skipped = 0;
  let errors = 0;

  for (const entry of entries) {
    const existing = findExistingEntries(store.items, entry);
    const hasExisting = existing.length > 0;

    if (dryRun) {
      alerts.push(`[dry-run] ${hasExisting ? '更新' : '新規'}: ${entry.id} (${entry.folder}) / 理由: ${entry.reason}`);
      registered++;
      continue;
    }

    try {
      const row = normalizeRow({
        id: entry.id,
        to: '',
        channel: 'manual',
        task: `【stalled-scan】${entry.folder}`,
        doneWhen: '復旧確認',
        intervalMin: 60,
        dueAt: entry.due,
        renudgeMin: 120,
        maxNudges: 5,
        escalateTo: 'kim-inbox',
        ownerAi: 'Claude Code',
        ownerPc: entry.pc,
        status: '止まった',
        statusReason: entry.reason,
        requestKind: 'automation',
        requestedBy: 'stalled-scan',
        note: entry.folder,
        kimOnlyAction: entry.kimOnlyAction || '',
      }, { validateRequired: false });

      const previousUpdatedAt = hasExisting ? existing[0].updatedAt : undefined;

      if (hasExisting) {
        const target = existing[0];
        Object.assign(target, row, {
          nudgeCount: target.nudgeCount || 0,
          lastSentAt: target.lastSentAt || '',
          lastSentId: target.lastSentId || '',
        });
        appendHistory(store, { id: row.id, status: '止まった', reason: `stalled-scan upsert: ${entry.reason}`, ai: 'Claude Code', pc: currentPcName() });
        await persistRow({ ...loaded, storeMode, config, store }, target, { previousUpdatedAt });
      } else {
        store.items.push(row);
        appendHistory(store, { id: row.id, status: '止まった', reason: `stalled-scan add: ${entry.reason}`, ai: 'Claude Code', pc: currentPcName() });
        await persistRow({ ...loaded, storeMode, config, store }, row);
      }
      registered++;
    } catch (error) {
      errors++;
      alerts.push(`登録エラー: ${entry.id} — ${error.message}`);
    }
  }

  // ALERT を出力
  const stalled = store.items.filter((r) => r.status === '止まった');
  const file = writeAlert(alertPath(config, flags), {
    now,
    checked: entries.length,
    stalled,
    escalated: store.items.filter((r) => r.status === 'エスカレーション'),
    awaitingApproval: store.items.filter((r) => r.status === '承認待ち'),
    alertRows: stalled,
    alerts,
    pendingSync: store.pendingSync,
    syncError: store.syncError,
  });

  console.log(JSON.stringify({
    ok: errors === 0,
    scanned: entries.length,
    registered,
    skipped,
    errors,
    alertFile: file,
    pendingSync: store.pendingSync,
    syncError: store.syncError,
  }, null, 2));

  // 同期失敗は非0で終了
  if (store.pendingSync && storeMode !== 'local') return 3;
  return errors > 0 ? 1 : 0;
}

export async function main(argv = process.argv.slice(2), ctxBase = {}) {
  const parsed = parseArgs(argv);
  const cmd = parsed._[0] || 'status';
  const flags = parsed.flags;
  const ctx = { ...ctxBase, now: resolveNow(ctxBase.now) };
  switch (cmd) {
    case 'init': return cmdInit(flags);
    case 'add': return cmdAdd(flags, ctx);
    case 'doctor': return cmdDoctor(flags, ctx);
    case 'sync': return cmdSync(flags, ctx);
    case 'run':
    case 'check': await cmdCheck(flags, ctx); return 0;
    case 'nudge': return cmdNudge(flags, ctx);
    case 'complete': return cmdComplete(flags, ctx);
    case 'status': return cmdStatus(flags, ctx);
    case 'stop': return cmdStop(flags, ctx);
    case 'seed': return cmdSeed(flags, ctx);
    case 'alert': return cmdAlert(flags, ctx);
    case 'outcome': return cmdOutcome(flags, ctx);
    case 'report': return cmdReport(flags, ctx);
    case 'stalled-scan': return cmdStalledScan(flags, ctx);
    default:
      throw new Error(`未知のサブコマンド: ${cmd}`);
  }
}

if (isEntry(import.meta.url)) {
  main().then((code) => {
    if (typeof code === 'number' && code !== 0) process.exit(code);
  }).catch((error) => {
    console.error(`followup-ledger: ${error.message || error}`);
    process.exit(1);
  });
}
