#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isEntry } from './is-entry.mjs';

export function queueFile(home = process.env.ORGIAST_HOME || os.homedir()) {
  return path.join(home, '.claude', 'mobile-push-queue.jsonl');
}

export function readQueue(home) {
  const file = queueFile(home);
  try {
    return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
  } catch { return []; }
}

export function writeQueue(home, items) {
  const file = queueFile(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, items.map(JSON.stringify).join('\n') + '\n');
}

export function enqueue({ owner, title, body, home }) {
  const items = readQueue(home);
  const now = new Date().toISOString();
  const id = `${now}-${Math.random().toString(36).slice(2, 8)}`;
  items.push({ id, ts: now, owner, title, body, sent: false });
  writeQueue(home, items);
  return id;
}

export function markSent(id, home) {
  const items = readQueue(home);
  const idx = items.findIndex(item => item.id === id);
  if (idx === -1) return false;
  items[idx].sent = true;
  items[idx].sentAt = new Date().toISOString();
  writeQueue(home, items);
  return true;
}

export function listPending(home) {
  return readQueue(home).filter(item => !item.sent);
}

export function main(args = process.argv.slice(2), options = {}) {
  const home = options.home || process.env.ORGIAST_HOME || os.homedir();
  const flag = args[0];
  if (flag === '--list') {
    const pending = listPending(home);
    console.log(JSON.stringify(pending));
    return 0;
  }
  if (flag === '--mark-sent') {
    const id = args[1];
    if (!id) { console.error('--mark-sent requires an id argument'); return 1; }
    if (markSent(id, home)) { console.log(JSON.stringify({ ok: true, id })); return 0; }
    console.error(`push request not found: ${id}`);
    return 1;
  }
  console.error('Usage: mobile-push-queue.mjs --list | --mark-sent <id>');
  return 1;
}

if (isEntry(import.meta.url)) process.exitCode = main();
