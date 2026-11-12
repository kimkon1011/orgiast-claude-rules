#!/usr/bin/env node
// user 入力なしの定期進捗プッシュ。アクティブな有人セッションの進捗1行を収集し、
// ~/.claude/progress-push/latest.json に書き出す。
// また、PushNotification 可能なセッション向けに additionalContext を stdout へ出力する。
// fail-open: どんな失敗でも exit 0。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listItems } from './kim-inbox.mjs';
import { redactSecrets } from './redact-secrets.mjs';
import { isEntry } from './is-entry.mjs';
import { resolveFleetLabel } from './lib/fleet-label.mjs';
import { resolveOwner } from './lib/fleet-owner.mjs';
import { readLedger, ledgerFile, latestOpenPromises, isUnattendedRow } from './auto-progress-ledger.mjs';
import { readRows, inboxFile } from './lib/auto-progress-inbox.mjs';

export const PROGRESS_PUSH_DIR = home => path.join(home, '.claude', 'progress-push');
export const LATEST_FILE = home => path.join(PROGRESS_PUSH_DIR(home), 'latest.json');

export function collectActiveSessions({ home = os.homedir(), now = Date.now() } = {}) {
  const file = ledgerFile(home);
  let rows;
  try { rows = readLedger(file); } catch { rows = []; }
  // 直近48時間以内の open 行を収集（無人除外）
  const window = 48 * 3600 * 1000;
  const active = latestOpenPromises(rows).filter(row => {
    if (isUnattendedRow(row, home)) return false;
    const recorded = Date.parse(row.ts);
    return Number.isFinite(recorded) && now - recorded < window;
  });
  const bySession = new Map(active.map(row => [row.sessionId, row]));
  const counters = path.join(home, '.claude', '.intra-turn-progress-counter');
  try {
    for (const name of fs.readdirSync(counters).filter(name => name.endsWith('.json'))) {
      try {
        const file = path.join(counters, name);
        const state = JSON.parse(fs.readFileSync(file, 'utf8'));
        const updated = state.updatedAt ?? fs.statSync(file).mtimeMs;
        if (now - updated < 0 || now - updated > 2 * 3600000) continue;
        const sessionId = decodeURIComponent(name.slice(0, -5));
        if (!bySession.has(sessionId)) bySession.set(sessionId, { sessionId, ts: new Date(updated).toISOString(), status: 'open', promise: '有人セッションで作業中' });
      } catch {}
    }
  } catch {}
  try {
    for (const item of listItems(home, { status: 'open' })) {
      if (!item.sessionId || bySession.has(item.sessionId) || isUnattendedRow(item, home)) continue;
      bySession.set(item.sessionId, { sessionId: item.sessionId, ts: item.createdAt, status: item.kind === 'ask' ? 'waiting_user' : 'open', promise: item.text });
    }
  } catch {}
  return [...bySession.values()];
}

export function readSessionProgress({ home = os.homedir(), sessionId } = {}) {
  if (!sessionId) return [];
  const file = inboxFile(home, sessionId);
  try {
    return readRows(file)
      .filter(row => row.state && row.evidence)
      .sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0))
      .slice(0, 3);
  } catch {
    return [];
  }
}

export function summarize(sessions, { home = os.homedir(), now = Date.now(), label } = {}) {
  const items = [];
  for (const row of sessions) {
    const progress = readSessionProgress({ home, sessionId: row.sessionId });
    const latest = progress[0];
    const statusLabel = row.status === 'waiting_user' ? '判断待ち'
      : row.status === 'done' ? '完了'
      : row.status === 'resumed' ? '再開中'
      : row.status === 'stalled' ? '停滞'
      : row.status === 'scheduled' ? '予約'
      : '進行中';
    const summary = latest?.evidence
      ? latest.evidence.replace(/[\r\n]+/g, ' ').slice(0, 120)
      : String(row.promise || '').replace(/[\r\n]+/g, ' ').slice(0, 120);
    const ago = Number.isFinite(Date.parse(row.ts))
      ? Math.round((now - Date.parse(row.ts)) / 3600000) + '時間前'
      : '';
    items.push({
      sessionId: row.sessionId,
      label: String(row.label || '').slice(0, 60),
      status: row.status,
      statusLabel,
      summary,
      ago,
      progressCount: progress.length,
      promise: String(row.promise || '').slice(0, 120),
    });
  }
  return {
    at: new Date(now).toISOString(),
    label: label || resolveFleetLabel(home),
    owner: resolveOwner({ home }),
    activeCount: items.length,
    items: items.map(item => ({ ...item, summary: redactSecrets(item.summary), promise: redactSecrets(item.promise), label: redactSecrets(item.label) })),
  };
}

export function writeReport(home, report) {
  const dir = PROGRESS_PUSH_DIR(home);
  fs.mkdirSync(dir, { recursive: true });
  const file = LATEST_FILE(home);
  fs.writeFileSync(file, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  return file;
}

export function pushContext(report) {
  if (!report.items.length) return '';
  const lines = ['【定期進捗プッシュ】進行中の有人セッション:'];
  for (const item of report.items.slice(0, 5)) {
    const tag = item.statusLabel;
    lines.push(`  ${tag} ${item.summary || item.label || item.promise}（${item.ago}）`);
  }
  if (report.items.length > 5) lines.push(`  ほか${report.items.length - 5}件`);
  return lines.join('\n');
}

export function main({ home = process.env.ORGIAST_HOME || os.homedir(), now = Date.now(), push = false } = {}) {
  try {
    const label = resolveFleetLabel(home);
    const sessions = collectActiveSessions({ home, now });
    try {
      const previous = JSON.parse(fs.readFileSync(LATEST_FILE(home), 'utf8'));
      const elapsed = now - Date.parse(previous.at);
      if (elapsed >= 0 && elapsed < 3600000) return { ok: true, skipped: true, path: LATEST_FILE(home), activeCount: previous.activeCount, label };
    } catch {}
    const report = summarize(sessions, { home, now, label });
    writeReport(home, report);
    if (push && report.items.length) {
      const context = pushContext(report);
      if (context) {
        const output = JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context } });
        process.stdout.write(output + '\n');
      }
    }
    return { ok: true, path: LATEST_FILE(home), activeCount: report.items.length, label };
  } catch (error) {
    // fail-open: 進捗プッシュの失敗でセッション動作を止めない
    const log = path.join(home, '.claude', 'logs', 'progress-push-error.log');
    try {
      fs.mkdirSync(path.dirname(log), { recursive: true });
      fs.appendFileSync(log, `${new Date(now).toISOString()} ${String(error?.message ?? error)}\n`);
    } catch {}
    return { ok: false, error: String(error?.message ?? error).slice(0, 200) };
  }
}

async function run() {
  const args = process.argv.slice(2);
  const push = args.includes('--push');
  const home = process.env.ORGIAST_HOME || os.homedir();
  const result = main({ home, push });
  if (!result.ok) process.exitCode = 0; // fail-open
}

if (isEntry(import.meta.url)) await run();
