#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isEntry } from './is-entry.mjs';
import { listInboxMatches, supersedeAsk, withInboxGroupLock } from './kim-inbox.mjs';
import { parseEscalation, syncEscalationAnswer } from './lib/escalation-answer-sync.mjs';

function groupKey(item) {
  const row = parseEscalation(item);
  if (row) return JSON.stringify(['escalation', row.session, row.ts]);
  if (item.dedupeKey) return JSON.stringify(['key', item.dedupeKey]);
  const text = item.text.normalize('NFKC').replace(/判断待ち\s*\d+\s*日/g, '判断待ち 日').replace(/\s+/g, ' ').trim();
  return JSON.stringify(['text', text]);
}

const byNewest = timestamp => (a, b) => Date.parse(timestamp(b)) - Date.parse(timestamp(a)) || b.id.localeCompare(a.id);
const byActivity = byNewest(item => item.lastAt || item.createdAt);
// Older drops have no answeredAt. Use their last recorded activity.
const byResolution = byNewest(item => item.answeredAt || item.lastAt || item.createdAt);

function reconcile(home, apply) {
  const groups = new Map();
  const result = { openAsks: 0, groups: 0, superseded: 0, answerInherited: 0, ledgerRowsSynced: 0, backupDir: null };
  for (const item of listInboxMatches(home, item => item.kind === 'ask' && ['open', 'answered', 'dropped'].includes(item.status))) {
    const key = groupKey(item);
    if (!groups.has(key)) groups.set(key, { open: [], resolved: [] });
    const group = groups.get(key);
    if (item.status === 'open') {
      result.openAsks++;
      group.open.push(item);
    } else group.resolved.push(item);
  }

  const changes = [];
  for (const { open, resolved } of groups.values()) {
    if (!open.length) continue;
    result.groups++;
    const resolution = resolved.sort(byResolution)[0];
    const target = resolution || open.sort(byActivity).shift();
    if (!open.length) continue;
    changes.push({ open, target, resolution });
  }
  if (apply && changes.length) {
    const claudeDir = path.join(home, '.claude');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    result.backupDir = fs.mkdtempSync(path.join(claudeDir, `kim-inbox-backup-${stamp}-`));
    for (const { open } of changes) {
      for (const item of open) {
        const filename = `${item.id}.json`;
        fs.copyFileSync(path.join(claudeDir, 'kim-inbox', filename), path.join(result.backupDir, filename));
      }
    }
  }

  for (const { open, target, resolution } of changes) {
    if (resolution && parseEscalation(target) && syncEscalationAnswer(home, target, apply ? undefined : {
      io: { writeLedger: () => {} },
    })) result.ledgerRowsSynced++;
    for (const item of open) {
      if (apply && !supersedeAsk(home, item.id, target)) continue;
      result.superseded++;
      if (resolution) result.answerInherited++;
    }
  }
  return result;
}

export function backfill(home, { apply = false } = {}) {
  return apply ? withInboxGroupLock(home, () => reconcile(home, true)) : reconcile(home, false);
}

if (isEntry(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length > 1 || args.some(arg => !['--dry-run', '--apply'].includes(arg))) {
    console.error('Usage: node tools/kim-inbox-dedupe-backfill.mjs [--dry-run | --apply]');
    process.exitCode = 1;
  } else {
    const home = process.env.ORGIAST_HOME || os.homedir();
    console.log(JSON.stringify(backfill(home, { apply: args.includes('--apply') }), null, 2));
  }
}
