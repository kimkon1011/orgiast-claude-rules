#!/usr/bin/env node
// Archive the complete source before replacing the active queue. Never discard history.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isEntry } from './is-entry.mjs';
import { defaultMemoryDirs, scanMemory } from './learning-ledger.mjs';
export const MAX_BYTES = 24_000;
const marker = '<!-- NEXT-SESSION v1 -->';
const hash = (text) => createHash('sha256').update(text).digest('hex');

export function planRotation(source, { now = new Date(), maxBytes = MAX_BYTES, archiveRef = 'archive/next-session.md', promotionPendingCount = null } = {}) {
  const items = [];
  const seen = new Set();
  let date = '';
  let cwd = '';
  let active = false;
  let current;
  let fence = false;
  const flush = () => { if (current) items.push(current); current = undefined; };
  for (const line of source.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) { if (current) current.lines.push(line); fence = !fence; continue; }
    if (fence) { if (current) current.lines.push(line); continue; }
    if (line === marker) { flush(); date = ''; cwd = ''; active = false; }
    const stamp = line.match(/^<!--.*更新:\s*(\d{4}-\d{2}-\d{2})/);
    if (stamp) date = stamp[1];
    const location = line.match(/^<!--.*cwd:\s*(.*?)(?:\s*\/\s*model:|\s*-->)/);
    if (location) cwd = location[1].trim();
    if (/^##\s/.test(line)) {
      flush(); active = /^##\s+(?:残TODO|次の1目的|未決|朝バッチ取り込み|🔁)/.test(line); continue;
    }
    if (!active) continue;
    const task = line.match(/^(?:\d+[.)、]|[-*](?:\s+\[[ xX]\])?)\s+(.+)/);
    if (task) { flush(); current = { lines: [line], date, cwd }; }
    else if (current && (/^\s+\S/.test(line) || !line.trim())) current.lines.push(line);
    else if (line.trim() && !/^(?:<!--|---|>)/.test(line)) { flush(); current = { lines: [line], date, cwd }; }
  }
  flush();
  const stats = { completed: 0, duplicate: 0, old: 0, context: 0, pending: 0, overflow: 0, stale: 0 };
  const pending = [];
  for (const item of items) {
    const text = item.lines.join('\n').trim();
    const first = item.lines[0].replace(/^(?:\d+[.)、]|[-*])\s+/, '');
    // Only explicit completion on the task's first line counts; a completed substep is not the task.
    if (/^(?:~~|\[[xX]\]|✅)|~~\s*(?:→\s*)?✅/.test(first)) { stats.completed++; continue; }
    if (/^(?:未定|なし|（なし|以下は既存|上の「|下の既存)/.test(first)) { stats.context++; continue; }
    const explicit = [...first.matchAll(/(?:起票|更新)\s*[:：]?\s*(\d{4}-\d{2}-\d{2})/g)].at(-1)?.[1];
    const age = now - Date.parse(explicit || item.date);
    if (age > 30 * 86400000 && !/着手中/.test(text)) { stats.old++; continue; }
    const key = text.replace(/^\d+[.)、]\s+/, '').replace(/\s+/g, ' ').trim();
    if (seen.has(key)) { stats.duplicate++; continue; }
    // Stale items remain reachable in the complete source snapshot archived by rotate().
    if (promotionPendingCount === 0 && /^PROMOTE 待ち\s*\d+\s*件/.test(first)) { stats.stale++; continue; }
    seen.add(key); pending.push({ text: first + text.slice(item.lines[0].length), date: explicit || item.date, cwd: item.cwd });
  }
  const header = `${marker}\n<!-- rotated queue v1 -->\n> 原文・完了・重複・30日超・詳細文脈: [退避先](${archiveRef})\n## 次の1目的\n未定（残TODOの先頭から確認）\n## 残TODO\n`;
  let output = header;
  const overflow = [];
  const continuations = [];
  for (const item of pending) {
    if (item.text.startsWith('[継続キュー:')) { continuations.push(item); continue; }
    const entry = `${stats.pending + 1}. ${item.text}${item.cwd ? ` （作業場所: ${item.cwd}）` : ''}${item.date && !/更新:/.test(item.text) ? ` （更新: ${item.date}）` : ''}\n`;
    if (Buffer.byteLength(output + entry) > maxBytes - 1000) { overflow.push(item); continue; }
    output += entry; stats.pending++;
  }
  // Continuations (references into a prior overflow queue) must also pass the byte budget check,
  // otherwise they accumulate across rotations and push the header over maxBytes (see history).
  for (const item of continuations) {
    const entry = `${stats.pending + 1}. ${item.text}\n`;
    if (Buffer.byteLength(output + entry) > maxBytes - 1000) { overflow.push(item); continue; }
    output += entry; stats.pending++;
  }
  if (overflow.length) {
    stats.overflow = overflow.length;
    output += `${stats.pending + 1}. [継続キュー: 未完了 ${overflow.length}件](${archiveRef}.pending.md) — このファイルの項目を消化後に確認する。\n`;
  }
  if (Buffer.byteLength(output) > maxBytes) throw new Error('next-session header exceeds byte budget');
  return { text: output, overflow, stats, beforeBytes: Buffer.byteLength(source), afterBytes: Buffer.byteLength(output) };
}

export function rotate(file, { now = new Date(), maxBytes = MAX_BYTES, source: supplied, promotionPendingCount } = {}) {
  if (!fs.existsSync(file) && supplied === undefined) return { changed: false, reason: 'absent' };
  const original = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const source = supplied ?? original;
  if (promotionPendingCount === undefined) {
    promotionPendingCount = null;
    if (source.includes('PROMOTE 待ち')) {
      try { promotionPendingCount = scanMemory(defaultMemoryDirs(), { onError: () => {} }).targets.length; }
      catch { promotionPendingCount = null; }
    }
  }
  // Re-evaluate completion/age even after normalization; unchanged queues are byte-stable.
  const oldRef = source.match(/\[退避先\]\(([^)]+)\)/)?.[1];
  if (oldRef && source === original && planRotation(source, { now, maxBytes, archiveRef: oldRef, promotionPendingCount }).text === source) return { changed: false, beforeBytes: Buffer.byteLength(source), afterBytes: Buffer.byteLength(source) };
  const month = now.toISOString().slice(0, 7).replace('-', '');
  const archive = path.join(path.dirname(file), 'archive', `next-session-${month}.md`);
  const digest = hash(source);
  const ref = `archive/next-session-${month}.md#snapshot-${digest}`;
  const result = planRotation(source, { now, maxBytes, archiveRef: ref, promotionPendingCount });
  fs.mkdirSync(path.dirname(archive), { recursive: true });
  const previousArchive = fs.existsSync(archive) ? fs.readFileSync(archive, 'utf8') : '';
  if (!previousArchive.includes(`<!-- snapshot:${digest} -->`)) {
    fs.appendFileSync(archive, `\n<!-- snapshot:${digest} -->\n<a id="snapshot-${digest}"></a>\n${source}\n<!-- end:${digest} -->\n`);
  }
  // Keep overflow as a separate pending queue, never silently drop open work.
  if (result.overflow.length) {
    const pendingFile = `${archive}.${digest}.pending.md`;
    if (!fs.existsSync(pendingFile)) fs.writeFileSync(pendingFile, result.overflow.map((x, i) => `${i + 1}. ${x.text}${x.cwd ? ` （作業場所: ${x.cwd}）` : ''}${x.date ? ` （更新: ${x.date}）` : ''}\n`).join(''), { flag: 'wx' });
    result.text = result.text.replace(`${ref}.pending.md`, `archive/${path.basename(pendingFile)}`);
  }
  const feedbackFile = path.join(path.dirname(archive), 'next-session-feedback.json');
  const feedback = fs.existsSync(feedbackFile) ? JSON.parse(fs.readFileSync(feedbackFile, 'utf8')) : [];
  const ids = [...new Set([...feedback, ...source.matchAll(/\[FB:([^\]]+)\]/g)].map((x) => typeof x === 'string' ? x : x[1]))];
  if (ids.length !== feedback.length) fs.writeFileSync(feedbackFile, JSON.stringify(ids) + '\n');
  if (!fs.readFileSync(archive, 'utf8').includes(source)) throw new Error('archive read-back mismatch');
  // Detect concurrent edits before replacing the active queue. Archive remains useful if aborted.
  if ((fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '') !== original) throw new Error('next-session changed concurrently; retry with the latest content');
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, result.text, { flag: 'wx' });
  fs.renameSync(temp, file);
  if (fs.readFileSync(file, 'utf8') !== result.text) throw new Error('next-session read-back mismatch');
  return { ...result, afterBytes: Buffer.byteLength(result.text), changed: true, archive };
}

// Writers pass their complete proposed content; archiving happens before the write above the cap.
export function writeHandoff(file, text) {
  if (Buffer.byteLength(text) > MAX_BYTES) return rotate(file, { source: text });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return { changed: true };
}
if (isEntry(import.meta.url)) {
  try {
    const i = process.argv.indexOf('--file');
    const file = i < 0 ? path.join(os.homedir(), '.claude', 'next-session.md') : process.argv[i + 1];
    const result = rotate(file);
    console.log(JSON.stringify({ ...result, text: undefined, overflow: undefined }));
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
