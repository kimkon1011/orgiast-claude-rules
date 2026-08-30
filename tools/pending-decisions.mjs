#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { userHome } from './batch-enqueue.mjs';
import { isEntry } from './is-entry.mjs';

export function queuePath({ home = userHome() } = {}) {
  return path.join(home, '.claude', 'pending-decisions.jsonl');
}

function readRecords(home) {
  try {
    return fs.readFileSync(queuePath({ home }), 'utf8').split(/\r?\n/).flatMap((line) => {
      try { return line.trim() ? [JSON.parse(line)] : []; } catch { return []; }
    });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

export function addDecision({ source, text, author, capturedAt, batchDate }, { home = userHome(), now = new Date() } = {}) {
  const normalized = String(text ?? '').trim();
  if (!normalized) throw new Error('判断テキストがありません');
  const file = queuePath({ home });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const stamp = now.toISOString().replace(/[-:.TZ]/g, '').slice(0, 17);
  let seq = 1;
  for (const record of readRecords(home)) {
    const id = String(record?.id || '');
    if (id.startsWith(`${stamp}-`)) seq = Math.max(seq, (parseInt(id.slice(stamp.length + 1), 10) || 0) + 1);
  }
  const record = {
    id: `${stamp}-${String(seq).padStart(3, '0')}`,
    source: String(source || ''), author: author || null, text: normalized,
    capturedAt: capturedAt || now.toISOString(), status: 'pending', batchDate: batchDate || null,
  };
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`);
  return record;
}

export function listDecisions({ home = userHome(), status } = {}) {
  const records = readRecords(home);
  return status == null ? records : records.filter((record) => record.status === status);
}

export function markDecisions(ids, { home = userHome(), status, batchDate } = {}) {
  const wanted = new Set(ids || []);
  if (!wanted.size) return [];
  const file = queuePath({ home });
  const records = readRecords(home); // Read immediately before the atomic rewrite to retain concurrent appends.
  const changed = [];
  for (const record of records) {
    if (!wanted.has(record.id)) continue;
    if (status !== undefined) record.status = status;
    if (batchDate !== undefined) record.batchDate = batchDate;
    changed.push(record);
  }
  if (!changed.length) return [];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `pending-decisions-${process.pid}-${Date.now()}.tmp`);
  fs.writeFileSync(tmp, records.map((record) => JSON.stringify(record)).join('\n') + (records.length ? '\n' : ''));
  fs.renameSync(tmp, file);
  return changed;
}

function option(args, name) { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; }

export function runCli(args = process.argv.slice(2)) {
  try {
    if (args.includes('--add')) {
      const record = addDecision({ text: option(args, '--add'), source: option(args, '--source'), author: option(args, '--author') });
      console.log(`追加: ${record.id}`);
      return 0;
    }
    if (args.includes('--list')) {
      const status = option(args, '--status');
      const records = listDecisions({ status });
      console.log(`${records.length}件${status ? ` (status=${status})` : ''}`);
      console.log(JSON.stringify(records));
      return 0;
    }
    if (args.includes('--mark')) {
      const ids = String(option(args, '--mark') || '').split(',').filter(Boolean);
      const changed = markDecisions(ids, { status: option(args, '--status') });
      console.log(`更新: ${changed.length}件`);
      return 0;
    }
    console.error('使い方: --add <text> --source <source> | --list [--status status] | --mark <id,...> --status <status>');
    return 2;
  } catch (error) { console.error(error.message); return 1; }
}

if (isEntry(import.meta.url)) process.exitCode = runCli();
