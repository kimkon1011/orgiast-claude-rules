#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isEntry } from './is-entry.mjs';
import { listItems, inboxDedupeKey, updateInboxItem, reflectInboxAnswer } from './kim-inbox.mjs';
import { readLedger, ledgerFile, escalationRowLookup, escalationDedupeKey, legacyEscalationRef, rowKey } from './auto-progress-ledger.mjs';

const terminal = item => ['answered', 'seen', 'superseded', 'dropped'].includes(item.status)
  && !(item.dailyProgress && item.status === 'seen');
const newest = (a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id);
const newestAnswer = (a, b) => String(b.answeredAt || '').localeCompare(String(a.answeredAt || '')) || newest(a, b);

function groupKey(item, findRow) {
  const ref = legacyEscalationRef(item.text);
  const row = (ref || item.dedupeKey) && findRow(item);
  if (row) return `key:${inboxDedupeKey(escalationDedupeKey(row))}`;
  if (item.dedupeKey) return `key:${item.dedupeKey}`;
  if (ref) return `ledger:${ref.sessionPrefix}:${ref.ts}`;
  const text = item.text.normalize('NFKC').replace(/判断待ち\s*\d+日/g, '判断待ち').replace(/\s+/g, ' ').trim();
  return text && `text:${text}`;
}

export function dedupeBackfill({ home = process.env.ORGIAST_HOME || os.homedir(), apply = false } = {}) {
  const items = listItems(home);
  const findRow = escalationRowLookup(readLedger(ledgerFile(home)), inboxDedupeKey);
  const groups = new Map();
  const dir = path.join(home, '.claude', 'kim-inbox');
  const activeFiles = new Set(fs.readdirSync(dir, { throwIfNoEntry: false }) ?? []);
  const archive = new Set(items.filter(terminal).map(item => item.id));
  const ledgerRows = new Set();
  const result = { dryRun: !apply, totalItems: items.length, openAsks: 0, mergedGroups: 0,
    superseded: 0, answerTransfers: 0, ledgerRows: 0, archiveMoves: 0 };
  for (const item of items) {
    if (item.kind !== 'ask' || !['open', 'answered'].includes(item.status)) continue;
    if (item.status === 'open') result.openAsks++;
    const key = groupKey(item, findRow);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }

  for (const group of groups.values()) {
    const open = group.filter(item => item.status === 'open').sort(newest);
    if (open.length === 0) continue;
    const answered = group.filter(item => item.status === 'answered' && item.answer && item.answeredAt).sort(newestAnswer)[0];
    if (!answered && open.length < 2) continue;
    result.mergedGroups++;
    for (const item of answered ? open : open.slice(1)) {
      if (answered) {
        const answer = { status: 'answered', answer: answered.answer, answeredAt: answered.answeredAt, answerSession: answered.answerSession };
        const row = findRow(item);
        if (apply) updateInboxItem(home, item.id, current => {
          if (current.status !== 'open') return;
          Object.assign(current, answer);
          reflectInboxAnswer(home, current);
        });
        if (row) ledgerRows.add(rowKey(row));
        result.answerTransfers++;
      } else {
        if (apply) updateInboxItem(home, item.id, current => {
          if (current.status === 'open') Object.assign(current, { status: 'superseded', supersededInto: open[0].id });
        });
        result.superseded++;
      }
      archive.add(item.id);
    }
  }
  result.ledgerRows = ledgerRows.size;
  for (const id of archive) {
    if (!activeFiles.has(`${id}.json`)) continue;
    if (apply && fs.existsSync(path.join(dir, `${id}.json`))) updateInboxItem(home, id, () => {});
    result.archiveMoves++;
  }
  return result;
}

if (isEntry(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.some(arg => !['--dry-run', '--apply'].includes(arg)) || (args.includes('--dry-run') && args.includes('--apply'))) {
      throw new Error('--dry-run または --apply を指定してください');
    }
    console.log(JSON.stringify(dedupeBackfill({ apply: args.includes('--apply') }), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
