#!/usr/bin/env node
// VS Code 拡張の「Claude Code process exited with code N」エラーの発生原因（process-hygiene, 拡張クローズ, 不明等）を
// 拡張ログと process-hygiene イベントログから機械的に調査・診断するツール。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { isEntry } from './is-entry.mjs';

export const DATADOG_NOTE = 'Failed to flush logs to Datadog は平常時にも出る無害行なので原因に数えない';

export function parseOptions(argv = process.argv.slice(2), now = Date.now()) {
  const json = argv.includes('--json');
  const sinceIndex = argv.indexOf('--since');
  const sinceIso = sinceIndex >= 0 ? argv[sinceIndex + 1] : new Date(now - 24 * 3600_000).toISOString();
  const sinceMs = Date.parse(sinceIso) || (now - 24 * 3600_000);

  const home = process.env.ORGIAST_HOME || process.env.USERPROFILE || os.homedir();
  const logsRootIndex = argv.indexOf('--logs-root');
  const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const logsRoot = logsRootIndex >= 0 ? argv[logsRootIndex + 1] : path.join(appData, 'Code', 'logs');

  const hygieneLogIndex = argv.indexOf('--hygiene-log');
  const hygieneLog = hygieneLogIndex >= 0 ? argv[hygieneLogIndex + 1] : path.join(home, '.claude', 'logs', 'process-hygiene-events.log');

  return { json, sinceIso, sinceMs, logsRoot, hygieneLog };
}

export function parseLogTime(str) {
  if (!str) return Number.NaN;
  const match = String(str).match(/^(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?)(Z)?/);
  if (!match) return Number.NaN;
  if (match[2] === 'Z' || String(str).endsWith('Z')) {
    return new Date(match[1] + 'Z').getTime();
  }
  const formatted = match[1].replace(' ', 'T');
  return new Date(formatted).getTime();
}

export function findClaudeLogFiles(logsRoot) {
  const results = [];
  if (!logsRoot || !fs.existsSync(logsRoot)) return results;

  function walk(dir, depth = 0) {
    if (depth > 6) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath, depth + 1);
      } else if (entry.isFile() && entry.name.toLowerCase() === 'claude vscode.log') {
        const normalized = fullPath.replaceAll('\\', '/').toLowerCase();
        if (normalized.includes('/exthost/anthropic.claude-code/')) {
          results.push(fullPath);
        }
      }
    }
  }

  walk(logsRoot);
  return results;
}

export function parseVscodeLog(content, filePath = '') {
  const events = [];
  if (!content) return events;
  const lines = String(content).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = line.match(/process exited with code\s+(-?\d+)/i);
    if (!match) continue;

    const code = match[1];
    const timestamp = parseLogTime(line);
    const timeMatch = line.match(/^(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?)/);
    const timeStr = timeMatch ? timeMatch[1] : '';

    let hasChannelClose = false;
    const startCheck = Math.max(0, i - 3);
    for (let j = startCheck; j < i; j++) {
      if (lines[j].includes('Closing Claude on channel:')) {
        hasChannelClose = true;
        break;
      }
    }

    events.push({
      filePath,
      lineIndex: i,
      timestamp,
      timeStr,
      code,
      hasChannelClose,
    });
  }
  return events;
}

export function parseHygieneLog(content) {
  const events = [];
  if (!content) return events;
  const lines = String(content).split(/\r?\n/);
  for (const line of lines) {
    if (!line.includes('category=vscode-claude-idle')) continue;
    const timestamp = parseLogTime(line);
    if (Number.isFinite(timestamp)) {
      events.push({ timestamp, raw: line });
    }
  }
  return events;
}

export function classifyExitReason({ hygieneMatch, hasChannelClose, totalSimultaneous }) {
  if (hygieneMatch) {
    return 'process-hygiene の kill';
  }
  if (hasChannelClose && totalSimultaneous >= 2) {
    return `拡張側クローズ（一斉 ${totalSimultaneous}件）`;
  }
  if (hasChannelClose) {
    return '拡張側クローズ';
  }
  return '原因不明（同じ window の exthost.log を見る）';
}

export function diagnoseExitEvents(allExitEvents, hygieneEvents) {
  const results = [];
  for (const event of allExitEvents) {
    if (!Number.isFinite(event.timestamp)) continue;

    const hygieneMatch = hygieneEvents.some(
      (h) => Math.abs(event.timestamp - h.timestamp) <= 120_000
    );

    const otherSimultaneous = allExitEvents.filter(
      (other) => other !== event && Number.isFinite(other.timestamp) && Math.abs(event.timestamp - other.timestamp) <= 5_000
    ).length;

    const totalSimultaneous = otherSimultaneous + 1;

    const diagnosis = classifyExitReason({
      hygieneMatch,
      hasChannelClose: event.hasChannelClose,
      totalSimultaneous,
    });

    results.push({
      ...event,
      hygieneMatch,
      simultaneousExits: otherSimultaneous,
      totalSimultaneous,
      diagnosis,
    });
  }
  return results;
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const opts = parseOptions(argv, deps.now ?? Date.now());
  const files = deps.files ?? findClaudeLogFiles(opts.logsRoot);

  let hygieneContent = '';
  try {
    hygieneContent = deps.hygieneContent ?? (fs.existsSync(opts.hygieneLog) ? fs.readFileSync(opts.hygieneLog, 'utf8') : '');
  } catch {}

  const hygieneEvents = parseHygieneLog(hygieneContent);

  const allRawEvents = [];
  for (const file of files) {
    let content = '';
    try {
      content = deps.readLogFile ? deps.readLogFile(file) : fs.readFileSync(file, 'utf8');
    } catch {}
    const parsed = parseVscodeLog(content, file);
    allRawEvents.push(...parsed);
  }

  const filteredEvents = allRawEvents.filter((e) => Number.isFinite(e.timestamp) && e.timestamp >= opts.sinceMs);
  const diagnosed = diagnoseExitEvents(filteredEvents, hygieneEvents);

  if (opts.json) {
    console.log(JSON.stringify({ events: diagnosed, note: DATADOG_NOTE }, null, 2));
  } else {
    for (const d of diagnosed) {
      console.log(`[${d.timeStr}] code=${d.code} channelClose=${d.hasChannelClose} hygieneMatch=${d.hygieneMatch} simultaneousExits=${d.simultaneousExits} -> 判定: ${d.diagnosis}`);
    }
    console.log(DATADOG_NOTE);
  }
  return 0;
}

if (isEntry(import.meta.url)) {
  await main();
}
