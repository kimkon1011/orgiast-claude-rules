#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isEntry } from './is-entry.mjs';
import { COMMAND_FOLDER_ID, createDriveQueue, flattenCache } from './gtasks.mjs';
import { getDriveToken, driveApi } from './lib/drive-auth.mjs';

export const FETCH_TIMEOUT_MS = 8_000;
export const MAX_ITEMS = 12;
export const defaultCacheFile = () => path.join(os.homedir(), '.claude', 'gtasks-pending-cache.json');

function oneLine(value) {
  return String(value ?? '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function truncate(value, limit = 120) {
  const text = oneLine(value);
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`;
}

function markerValue(notes, marker) {
  const line = String(notes ?? '').split(/\r?\n/).find((item) => item.includes(marker));
  if (!line) return null;
  return oneLine(line.slice(line.indexOf(marker) + marker.length).replace(/^\s*[:：]?\s*/, ''));
}

export function classifyTasks(cache) {
  const groups = { drafts: [], actions: [], questions: [] };
  for (const task of flattenCache(cache).rows) {
    if (task.status === 'completed') continue;
    const draft = markerValue(task.notes, '■ 下書き作成済み');
    const action = markerValue(task.notes, '■ kimの残り');
    const question = markerValue(task.notes, '■ 要確認');
    const entry = { ...task, detail: draft ?? action ?? question ?? '' };
    if (draft !== null) groups.drafts.push(entry);
    else if (action !== null) groups.actions.push(entry);
    else if (question !== null) groups.questions.push(entry);
  }
  return groups;
}

function formatTime(value, now) {
  const date = value ? new Date(value) : now;
  const valid = !Number.isNaN(date.getTime()) ? date : now;
  return `${String(valid.getHours()).padStart(2, '0')}:${String(valid.getMinutes()).padStart(2, '0')}`;
}

function itemLine(entry, kind) {
  if (kind === 'drafts') {
    const summary = entry.detail.replace(/^(?:（未送信）|\(未送信\))\s*[:：]?\s*/, '').replace(/\s*\/\s*下書き:.*$/, '');
    return truncate(`- **${oneLine(entry.title)}** — ${summary} → 下書き: \`~/.claude/gtasks-drafts/${entry.taskId}.md\`（**未送信**。送るなら「これ送って」と言う）`);
  }
  return truncate(`- **${oneLine(entry.title)}** — ${entry.detail}`);
}

export function formatNotice(cache, { now = new Date(), staleHours = null, maxItems = MAX_ITEMS } = {}) {
  const groups = classifyTasks(cache);
  const total = groups.drafts.length + groups.actions.length + groups.questions.length;
  if (!total) return '';
  let remaining = maxItems;
  const lines = [`## 📋 Googleタスク: kim の操作・判断待ち（${total}件 / 最終更新 ${formatTime(cache?.updatedAt, now)}${staleHours === null ? '' : ` / (${staleHours}時間前の情報)`}）`];
  for (const [kind, heading] of [['drafts', '送信待ちの下書き'], ['actions', 'kim の操作が要る'], ['questions', '情報待ち']]) {
    const entries = groups[kind];
    if (!entries.length) continue;
    const shown = entries.slice(0, remaining);
    if (!shown.length) continue;
    lines.push(`### ${heading}（${entries.length}件）`, ...shown.map((entry) => itemLine(entry, kind)));
    remaining -= shown.length;
  }
  if (total > maxItems) lines.push(`- 他${total - maxItems}件`);
  return lines.join('\n');
}

async function fetchDriveCache(signal) {
  const token = await getDriveToken({ signal });
  const abortableApi = (value, url, options = {}) => driveApi(value, url, { ...options, signal });
  return createDriveQueue({ token, api: abortableApi, folderId: COMMAND_FOLDER_ID }).readCache();
}

async function withinTimeout(work, timeoutMs) {
  let timer;
  const controller = new AbortController();
  try {
    return await Promise.race([
      Promise.resolve().then(() => work(controller.signal)),
      new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('timeout')); }, timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function readLocalCache(file) {
  const saved = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  if (!saved?.cache || !saved?.savedAt) throw new Error('invalid local cache');
  return saved;
}

export async function runPendingNotice({
  fetchCache = fetchDriveCache,
  cacheFile = defaultCacheFile(),
  now = () => new Date(),
  timeoutMs = FETCH_TIMEOUT_MS,
  stdout = (text) => process.stdout.write(`${text}\n`),
} = {}) {
  const current = now();
  let cache;
  let staleHours = null;
  try {
    cache = await withinTimeout(fetchCache, timeoutMs);
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, `${JSON.stringify({ savedAt: current.toISOString(), cache }, null, 2)}\n`, 'utf8');
  } catch {
    try {
      const saved = readLocalCache(cacheFile);
      cache = saved.cache;
      staleHours = Math.max(0, Math.floor((current.getTime() - new Date(saved.savedAt).getTime()) / 3_600_000));
    } catch {
      return '';
    }
  }
  const output = formatNotice(cache, { now: current, staleHours });
  if (output) stdout(output);
  return output;
}

if (isEntry(import.meta.url)) {
  try { await runPendingNotice(); } catch { /* SessionStart は必ず継続する。 */ }
}
