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
  return { id: 'stall-ledger', status: Number(safe.cutOff) > 0 ? 'fail' : 'ok', reason: `total=${Number(safe.total) || 0}; due24h=${Number(safe.due24h) || 0}; cutOff=${Number(safe.cutOff) || 0}` };
}

export function parseStallSummary(steps) {
  const step = (Array.isArray(steps) ? steps : []).find(item => item?.id === 'stall-ledger');
  if (!step) return null;
  const value = key => Number(new RegExp(`(?:^|;\\s*)${key}=(\\d+)`).exec(String(step.reason || ''))?.[1]);
  return { total: value('total'), due24h: value('due24h'), cutOff: value('cutOff') };
}

export function renderAllLedgers({ ownLedger, fleetRows = [], now = Date.now() } = {}) {
  const lines = ['# 全PC 停滞台帳', '', `更新: ${new Date(now).toISOString()}`, '', '| PC | 未完了 | 期日24h以内 | 打ち切り | 状態 |', '|---|---:|---:|---:|---|'];
  const ownHost = String(ownLedger?.hostname || '000KimPC');
  const seen = new Set();
  const add = (name, summary, state) => { seen.add(name); lines.push(`| ${clean(name, 80)} | ${summary?.total ?? '-'} | ${summary?.due24h ?? '-'} | ${summary?.cutOff ?? '-'} | ${state} |`); };
  add(ownHost, ownLedger?.summary, 'ローカル台帳');
  for (const row of fleetRows) {
    const name = row.hostname || row.label;
    if (!name || seen.has(name)) continue;
    add(name, row.stallLedger, row.stallLedger ? (row.stale ? 'beacon 古い' : 'beacon') : 'beacon 未対応');
  }
  return `${lines.join('\n')}\n`;
}

export function writeAllLedgers({ home = os.homedir(), ownLedger, fleetRows, now = Date.now() } = {}) {
  const file = path.join(home, '.claude', 'stall-ledger', 'ALL.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, renderAllLedgers({ ownLedger, fleetRows, now }), { mode: 0o600 });
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
    if (row.stale || !row.hasBeacon) return false;
    const at = Date.parse(row.pollAt || row.beaconAt);
    if (!Number.isFinite(at) || now - at > DAY) return false;
    const usage = [row.planFiveHourPct, row.planSevenDayPct].map(Number).filter(Number.isFinite);
    return !usage.length || Math.max(...usage) < stopPct;
  }).sort((a, b) => {
    const au = Math.max(Number(a.planFiveHourPct) || 0, Number(a.planSevenDayPct) || 0);
    const bu = Math.max(Number(b.planFiveHourPct) || 0, Number(b.planSevenDayPct) || 0);
    return au - bu || Date.parse(b.pollAt || b.beaconAt) - Date.parse(a.pollAt || a.beaconAt);
  })[0] || null;
}

export function buildHandoffMarkdown(record) {
  return clean(`# 停滞セッション引き継ぎ\n\n- 件名: ${record.title || '(件名なし)'}\n- 元PC: ${record.hostname || os.hostname()}\n- セッションID: ${record.sessionId || ''}\n- 期日: ${record.due || 'なし'}\n- 止まった理由: ${record.evidence || record.reason || '不明'}\n- 成果物パス: ${(record.artifactPaths || []).join(', ') || 'なし'}\n\n## 元の依頼（最初の発言）\n${record.firstUserText || '取得できず'}\n\n## 最後の assistant 発言（末尾2000字）\n${String(record.lastAssistantText || '取得できず').slice(-2000)}\n\n## 指示\nこの件を引き継いで完了まで進めよ。終わったら元PCの台帳に done を書け。\n`, 12000);
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
