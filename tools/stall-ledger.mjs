import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { redactSecrets } from './redact-secrets.mjs';

const DAY = 86_400_000;
const PC_ALLOW = new Set(['000', '004', '008', '011', '014', '015', '018', '019', '999']);

function clean(value, limit = 4000) {
  return redactSecrets(String(value ?? '')).replace(/\0/g, '').slice(0, limit);
}

function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
}

export function normalizeLedgerEntry(entry, now = Date.now()) {
  return {
    title: clean(entry.title || entry.subject || '(件名なし)', 500),
    sessionId: clean(entry.sessionId, 200),
    type: clean(entry.type || '先送り', 80),
    due: entry.due ? new Date(entry.due).toISOString() : '',
    lastResult: clean(entry.lastResult || entry.outcome || '未試行', 1000),
    lastAttemptAt: entry.lastAttemptAt ? new Date(entry.lastAttemptAt).toISOString() : new Date(now).toISOString(),
    ...(entry.handedOffTo ? { handedOffTo: clean(entry.handedOffTo, 80) } : {}),
    ...(entry.handedOffAt ? { handedOffAt: new Date(entry.handedOffAt).toISOString() } : {}),
  };
}

export function ledgerSummary(entries, now = Date.now()) {
  const rows = Array.isArray(entries) ? entries : [];
  return {
    total: rows.length,
    due24h: rows.filter(row => { const due = Date.parse(row.due); return Number.isFinite(due) && due >= now && due <= now + DAY; }).length,
    cutOff: rows.filter(row => row.type === '打ち切り').length,
    handedOff: rows.filter(row => row.type === '移管済み').length,
  };
}

export function writeStallLedger({ home = os.homedir(), hostname = os.hostname(), entries = [], now = Date.now() } = {}) {
  const normalized = entries.map(entry => normalizeLedgerEntry(entry, now));
  const summary = ledgerSummary(normalized, now);
  const file = path.join(home, '.claude', 'stall-ledger', `${hostname}.json`);
  atomicJson(file, { hostname, updatedAt: new Date(now).toISOString(), summary, entries: normalized });
  return { file, entries: normalized, summary };
}

export function collectGbReportEntries({ reportsDir = 'C:\\Users\\uers\\gb-reports', now = Date.now() } = {}) {
  if (!fs.existsSync(reportsDir)) return [];
  const since = now - 7 * DAY;
  return fs.readdirSync(reportsDir, { withFileTypes: true }).filter(item => item.isDirectory()).flatMap(item => {
    const dir = path.join(reportsDir, item.name);
    if (fs.existsSync(path.join(dir, 'DONE.txt'))) return [];
    let mtime = 0;
    try { mtime = fs.statSync(dir).mtimeMs; } catch { return []; }
    if (mtime < since) return [];
    return [{ title: item.name, sessionId: '', type: 'gb-report未完了', due: '', lastResult: now - mtime > DAY ? '24時間超未完了' : '未完了', lastAttemptAt: mtime }];
  });
}

export function stallSummaryStep(summary) {
  const safe = summary || {};
  return { id: 'stall-ledger', status: Number(safe.cutOff) > 0 ? 'fail' : 'ok', reason: `total=${Number(safe.total) || 0}; due24h=${Number(safe.due24h) || 0}; cutOff=${Number(safe.cutOff) || 0}; handedOff=${Number(safe.handedOff) || 0}` };
}

export function parseStallSummary(steps) {
  const step = (Array.isArray(steps) ? steps : []).find(item => item?.id === 'stall-ledger');
  if (!step) return null;
  const value = key => Number(new RegExp(`(?:^|;\\s*)${key}=(\\d+)`).exec(String(step.reason || ''))?.[1]);
  return { total: value('total'), due24h: value('due24h'), cutOff: value('cutOff'), handedOff: value('handedOff') };
}

export function renderAllMarkdown(fleetRows = [], localLedger = null, now = Date.now()) {
  const lines = ['# 全PC 停滞台帳', '', `更新: ${new Date(now).toISOString()}`, '', '| PC | 未完了件数 | 期日24時間以内 | 打ち切り | 移管済み | beacon 時刻 |', '|---|---:|---:|---:|---:|---|'];
  const ownLedger = localLedger;
  const ownHost = String(ownLedger?.hostname || '000KimPC');
  const seen = new Set();
  const add = (name, summary, beaconAt) => { seen.add(name); lines.push(`| ${clean(name, 80)} | ${summary?.total ?? '-'} | ${summary?.due24h ?? '-'} | ${summary?.cutOff ?? '-'} | ${summary?.handedOff ?? '-'} | ${beaconAt} |`); };
  add(ownHost, ownLedger?.summary, ownLedger?.updatedAt || 'ローカル');
  for (const row of fleetRows) {
    const name = row.hostname || row.label;
    if (!name || seen.has(name)) continue;
    add(name, row.stallLedger, row.hasBeacon ? (row.beaconAt || row.pollAt || '時刻不明') : 'beacon 未対応');
  }
  return `${lines.join('\n')}\n`;
}

export function renderAllLedgers({ ownLedger, fleetRows = [], now = Date.now() } = {}) {
  return renderAllMarkdown(fleetRows, ownLedger, now);
}

export function writeAllLedgers({ home = os.homedir(), ownLedger, fleetRows, now = Date.now() } = {}) {
  const file = path.join(home, '.claude', 'stall-ledger', 'ALL.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, renderAllMarkdown(fleetRows, ownLedger, now), { mode: 0o600 });
  return file;
}

function pcNumber(row) {
  const text = `${row?.label || ''} ${row?.hostname || ''} ${row?.remoteName || ''}`;
  return /(?:^|\D)(000|004|008|011|014|015|018|019|999)(?:\D|$)/.exec(text)?.[1] || '';
}

export function chooseHandoffTarget(rows, { selfHostname = os.hostname(), now = Date.now(), stopPct = 85 } = {}) {
  return (Array.isArray(rows) ? rows : []).filter(row => {
    const pc = pcNumber(row);
    if (!PC_ALLOW.has(pc) || `${row.hostname} ${row.label}`.toLowerCase().includes(String(selfHostname).toLowerCase())) return false;
    if (!row.hasBeacon) return false;
    const at = Date.parse(row.beaconAt || row.pollAt);
    if (!Number.isFinite(at) || now - at > 2 * 60 * 60_000) return false;
    const fiveKnown = row.planFiveHourPct !== null && row.planFiveHourPct !== undefined && Number.isFinite(Number(row.planFiveHourPct));
    const sevenKnown = row.planSevenDayPct !== null && row.planSevenDayPct !== undefined && Number.isFinite(Number(row.planSevenDayPct));
    const five = Number(row.planFiveHourPct), seven = Number(row.planSevenDayPct);
    return (!fiveKnown || five < stopPct) && (!sevenKnown || seven < stopPct);
  }).sort((a, b) => {
    const aKnown = a.planFiveHourPct != null && a.planSevenDayPct != null && Number.isFinite(Number(a.planFiveHourPct)) && Number.isFinite(Number(a.planSevenDayPct));
    const bKnown = b.planFiveHourPct != null && b.planSevenDayPct != null && Number.isFinite(Number(b.planFiveHourPct)) && Number.isFinite(Number(b.planSevenDayPct));
    if (aKnown !== bKnown) return aKnown ? -1 : 1;
    const au = Math.max(Number(a.planFiveHourPct) || 0, Number(a.planSevenDayPct) || 0);
    const bu = Math.max(Number(b.planFiveHourPct) || 0, Number(b.planSevenDayPct) || 0);
    return au - bu || Date.parse(b.pollAt || b.beaconAt) - Date.parse(a.pollAt || a.beaconAt);
  })[0] || null;
}

export function buildHandoffMarkdown(record) {
  return clean(`# 停滞セッション引き継ぎ\n\n- 件名: ${record.title || '(件名なし)'}\n- 元PC: ${record.hostname || os.hostname()}\n- セッションID: ${record.sessionId || ''}\n- cwd: ${record.cwd || '不明'}\n- 期日: ${record.due || 'なし'}\n- 止まった理由: ${record.evidence || record.reason || '不明'}\n\n## 元の依頼（最初の発言）\n${record.firstUserText || '取得できず'}\n\n## 最後の assistant 発言（末尾2000字）\n${String(record.lastAssistantText || '取得できず').slice(-2000)}\n\n## 指示\nこの件を引き継いで完了まで進め、終わったら完了を返信せよ。\n`, 12000);
}

export function recentlyHandedOff(entry, now = Date.now()) {
  const at = Date.parse(entry?.handedOffAt || '');
  return Number.isFinite(at) && now - at < DAY;
}

// directiveSender は fleet-directive-send.mjs の main を注入する。通常呼出し側は --push を付ける。
export function handoffSession({ record, fleetRows, repo, home = os.homedir(), now = Date.now(), stopPct = 85, directiveSender } = {}) {
  if (recentlyHandedOff(record, now)) return { handedOff: false, reason: '24h-dedupe' };
  const target = chooseHandoffTarget(fleetRows, { selfHostname: record.hostname || os.hostname(), now, stopPct });
  if (!target) return { handedOff: false, reason: 'target-unavailable' };
  const dir = path.join(home, '.claude', 'stall-ledger', 'handoffs');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${clean(record.sessionId || `unknown-${now}`, 100).replace(/[^A-Za-z0-9_.-]/g, '_')}.md`);
  fs.writeFileSync(file, buildHandoffMarkdown(record), { mode: 0o600 });
  const targetName = target.remoteName || target.label || target.hostname;
  const directive = directiveSender(['--kind', 'prompt', '--targets', targetName, '--why', '停滞セッションを利用枠に余裕のあるPCへ移管', '--body-file', file, '--expires-hours', '24', '--push'], { repo, home });
  return { handedOff: true, target: targetName, file, directiveId: directive?.id, handedOffAt: new Date(now).toISOString() };
}
