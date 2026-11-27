#!/usr/bin/env node
// 過去に登録された stalled-session-hourly-preflight の ask を
// decideStalledNoticeKind の判定に基づいて info へ降格する。
// 既定は dry-run。--apply で実際に降格する。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { isEntry } from './is-entry.mjs';
import { decideStalledNoticeKind } from './lib/stalled-notice-kind.mjs';

const TARGET_SOURCE = 'stalled-session-hourly-preflight';

function inboxDir(home) {
  return path.join(home, '.claude', 'kim-inbox');
}

function validId(id) {
  return /^ki-\d{14}-[a-f0-9]{4}$/.test(id);
}

function readItems(dir) {
  let names;
  try { names = fs.readdirSync(dir); }
  catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const items = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const id = name.slice(0, -5);
    if (!validId(id)) continue;
    try {
      const item = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      if (item.source === TARGET_SOURCE && item.kind === 'ask' && (item.status === 'open' || item.status === 'seen')) {
        items.push(item);
      }
    } catch {
      // 破損した1件で全体を止めない
    }
  }
  return items.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || a.id.localeCompare(b.id));
}

function extractReasonAndNextStep(text) {
  const reasonMatch = /理由:\s*(.+?)(?:\n|$)/u.exec(text);
  const confirmMatch = /確認事項:\s*(.+?)$/um.exec(text);
  return {
    reason: (reasonMatch?.[1] ?? '').trim(),
    nextStep: (confirmMatch?.[1] ?? '').trim(),
  };
}

function isDemotable(item) {
  const { reason, nextStep } = extractReasonAndNextStep(item.text);
  return decideStalledNoticeKind({ reason, nextStep }) === 'info';
}

function demotionReason(item) {
  const { reason, nextStep } = extractReasonAndNextStep(item.text);
  const kind = decideStalledNoticeKind({ reason, nextStep });
  if (kind === 'info') return 'decideStalledNoticeKind が info を返したため降格可';
  return `decideStalledNoticeKind が ask を返したため据え置き（reason: ${reason.slice(0, 40)}, nextStep: ${nextStep.slice(0, 40)}）`;
}

function saveItemAtomic(filePath, item) {
  const dir = path.dirname(filePath);
  const temp = path.join(dir, `${item.id}.${randomBytes(8).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(temp, JSON.stringify(item, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(temp, filePath);
  } finally {
    try { fs.unlinkSync(temp); } catch { /* ignore */ }
  }
}

function classifyItems(dir) {
  const items = readItems(dir);
  const results = [];
  let demotable = 0;
  let kept = 0;

  for (const item of items) {
    const once = extractReasonAndNextStep(item.text);
    if (isDemotable(item)) {
      results.push({ id: item.id, demote: true, reason: demotionReason(item), text: item.text, ...once });
      demotable++;
    } else {
      results.push({ id: item.id, demote: false, reason: demotionReason(item), text: item.text, ...once });
      kept++;
    }
  }

  return { items: results, total: items.length, demotable, kept };
}

function applyDemotions(dir, results) {
  const applied = [];
  for (const result of results) {
    if (!result.demote) continue;
    const filePath = path.join(dir, `${result.id}.json`);
    const item = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const originalKind = item.kind;
    item.kind = 'info';
    item.kindBackfilledAt = new Date().toISOString();
    item.kindBefore = originalKind;
    saveItemAtomic(filePath, item);

    // read-back verify
    const saved = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (saved.kind !== 'info') {
      item.kind = originalKind;
      delete item.kindBackfilledAt;
      delete item.kindBefore;
      saveItemAtomic(filePath, item);
      throw new Error(`read-back verify 失敗: ${result.id} の kind が ${saved.kind}（期待 info）`);
    }
    applied.push(result.id);
  }
  return applied;
}

function textPreview(text, maxLen = 60) {
  return String(text ?? '').replace(/\s+/g, ' ').slice(0, maxLen);
}

function formatTable(results, total, demotable, kept) {
  const lines = results.map(r =>
    `${r.id} / ${r.demote ? '可' : '否'} / ${r.reason} / ${textPreview(r.text)}`
  );
  lines.push(`対象 ${total} 件 / 降格 ${demotable} 件 / 据え置き ${kept} 件`);
  return lines.join('\n');
}

export function backfillStalledKind(directory, { apply = false } = {}) {
  const { items, total, demotable, kept } = classifyItems(directory);
  let applied = [];
  if (apply) {
    applied = applyDemotions(directory, items);
  }
  return { items, total, demotable, kept, applied };
}

if (isEntry(import.meta.url)) {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const formatAt = args.indexOf('--format');
  const format = formatAt >= 0 ? args[formatAt + 1] : 'table';
  const dirAt = args.indexOf('--dir');
  const dir = dirAt >= 0 ? args[dirAt + 1] : inboxDir(os.homedir());

  if (format !== 'table' && format !== 'json') {
    console.error('--format は table または json を指定してください');
    process.exitCode = 1;
  }

  const result = backfillStalledKind(dir, { apply });

  if (format === 'json') {
    console.log(JSON.stringify({
      total: result.total,
      demotable: result.demotable,
      kept: result.kept,
      applied: result.applied,
      items: result.items.map(r => ({
        id: r.id,
        demote: r.demote,
        reason: r.reason,
        text: textPreview(r.text),
      })),
    }, null, 2));
  } else {
    console.log(formatTable(result.items.map(r => ({
      ...r,
      text: String(r.text ?? ''),
    })), result.total, result.demotable, result.kept));
  }
}