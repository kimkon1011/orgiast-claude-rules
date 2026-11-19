#!/usr/bin/env node
// 一回限りの整理スクリプト: 同じ台帳行・同じ dedupeKey・正規化本文が同じ open ask を
// 最新1件に集約し、残りは status='superseded'（ファイル削除禁止）。
// 同グループに answered があれば open 側も answered にして回答を引き継ぎ、台帳へ反映。
// --dry-run 既定、--apply で実行。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isEntry } from './is-entry.mjs';
import { listItems, answerItem } from './kim-inbox.mjs';
import { updateLedgerRow, ledgerFile } from './auto-progress-ledger.mjs';

const home = process.env.ORGIAST_HOME || os.homedir();
const inboxDir = path.join(home, '.claude/kim-inbox');

function normalizationKey(text) {
  return text.replace(/^【[^\r\n]*】[^\S\r\n]*(?:\r?\n|$)/, '')
    .replace(/\d{4}[-/]\d{1,2}[-/]\d{1,2}(?:[T ]\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?/g, '#')
    .replace(/\b(?:0x[a-f0-9]+|[a-f0-9]{8,})\b/gi, '#')
    .replace(/\d+/g, '#').slice(0, 120);
}

function ledgerKey(item) {
  const m = item.text.match(/セッション\s+([a-f0-9]{8})\s*\/\s*台帳\s+ts\s+(\S+)/i);
  return m ? `${m[1]}|${m[2]}` : null;
}

function newestFirst(a, b) {
  return (b.lastAt || b.createdAt).localeCompare(a.lastAt || a.createdAt) || b.id.localeCompare(a.id);
}

async function dedupeBackfill({ dryRun = true, apply = false } = {}) {
  const run = apply || !dryRun;
  const allItems = listItems(home);
  const openItems = allItems.filter(i => i.status === 'open');
  const nonOpenItems = allItems.filter(i => i.status !== 'open');

  // Group 1: by dedupeKey
  const byDedupeKey = new Map();
  // Group 2: by ledgerKey (extracted from text)
  const byLedgerKey = new Map();
  // Group 3: by normalized text (for items without dedupeKey or ledgerKey)
  const byNormalized = new Map();

  for (const item of openItems) {
    if (item.dedupeKey) {
      if (!byDedupeKey.has(item.dedupeKey)) byDedupeKey.set(item.dedupeKey, []);
      byDedupeKey.get(item.dedupeKey).push(item);
      continue;
    }
    const lk = ledgerKey(item);
    if (lk) {
      if (!byLedgerKey.has(lk)) byLedgerKey.set(lk, []);
      byLedgerKey.get(lk).push(item);
      continue;
    }
    const nk = normalizationKey(item.text);
    if (!byNormalized.has(nk)) byNormalized.set(nk, []);
    byNormalized.get(nk).push(item);
  }

  let supersededCount = 0;
  let answerTransferCount = 0;
  let ledgerUpdateCount = 0;
  let archiveMoveCount = 0;

  // Process each group: keep the latest, supersede the rest
  const groups = [byDedupeKey, byLedgerKey, byNormalized];
  for (const group of groups) {
    for (const [key, items] of group) {
      if (items.length < 2) continue;
      const sorted = [...items].sort(newestFirst);
      const [kept, ...duplicates] = sorted;

      // Check if any duplicate has an answer (shouldn't happen for open items, but check)
      // Actually, open items don't have answers. But we need to check if any item in the
      // group has a corresponding answered item (same dedupeKey or ledgerKey).
      // For dedupeKey groups, check non-open items too.
      let answeredItem = null;
      if (item.dedupeKey) {
        answeredItem = nonOpenItems.find(i => i.dedupeKey === key && i.status === 'answered' && i.answer);
      }

      for (const dup of duplicates) {
        if (run) {
          const file = path.join(inboxDir, `${dup.id}.json`);
          const archiveFile = path.join(inboxDir, '.archive', `${dup.id}.json`);
          const actualFile = fs.existsSync(file) ? file : (fs.existsSync(archiveFile) ? archiveFile : null);
          if (actualFile) {
            const item = JSON.parse(fs.readFileSync(actualFile, 'utf8'));
            item.status = 'superseded';
            item.supersededInto = kept.id;
            const temp = `${actualFile}.${createHash('md5').update(dup.id).digest('hex').slice(0, 8)}.tmp`;
            fs.writeFileSync(temp, JSON.stringify(item, null, 2) + '\n', { mode: 0o600 });
            fs.renameSync(temp, actualFile);
            // Move to archive if not already there
            if (actualFile === file) {
              const archiveDir = path.join(inboxDir, '.archive');
              fs.mkdirSync(archiveDir, { recursive: true });
              try { fs.renameSync(actualFile, path.join(archiveDir, `${dup.id}.json`)); archiveMoveCount++; }
              catch { /* 競合 */ }
            }
          }
        }
        supersededCount++;
      }

      // If there's an answered item with the same key, transfer the answer to the kept item
      if (answeredItem) {
        if (run) {
          answerItem(home, kept.id, answeredItem.answer, answeredItem.answerSession || '');
          // answerItem already handles ledger update via text pattern matching
        }
        answerTransferCount++;
      }
    }
  }

  // Also move all non-open items to .archive/ if they're still in the main directory
  if (run) {
    const archiveDir = path.join(inboxDir, '.archive');
    for (const item of nonOpenItems) {
      const file = path.join(inboxDir, `${item.id}.json`);
      if (fs.existsSync(file)) {
        fs.mkdirSync(archiveDir, { recursive: true });
        try { fs.renameSync(file, path.join(archiveDir, `${item.id}.json`)); archiveMoveCount++; }
        catch { /* 競合 */ }
      }
    }
  } else {
    // Count how many non-open items are still in the main directory
    for (const item of nonOpenItems) {
      if (fs.existsSync(path.join(inboxDir, `${item.id}.json`))) archiveMoveCount++;
    }
  }

  return {
    totalOpen: openItems.length,
    totalNonOpen: nonOpenItems.length,
    dedupeKeyGroups: byDedupeKey.size,
    ledgerKeyGroups: byLedgerKey.size,
    normalizedGroups: byNormalized.size,
    superseded: supersededCount,
    answerTransfers: answerTransferCount,
    ledgerUpdates: ledgerUpdateCount,
    archiveMoves: archiveMoveCount,
    dryRun: !run,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const result = await dedupeBackfill({ dryRun: !apply, apply });
  console.log(JSON.stringify(result, null, 2));
}

if (isEntry(import.meta.url)) main().catch(err => { console.error(err.message); process.exitCode = 1; });