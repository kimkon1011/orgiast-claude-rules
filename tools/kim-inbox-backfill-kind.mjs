#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { isEntry } from './is-entry.mjs';
import { inboxBrief } from './lib/kim-inbox-relay-state.mjs';

// 登録側の条件を再現するための定数
const SOURCES_AUTO_PROGRESS_DONE = ['auto-progress-done'];
const SOURCES_TEXT_MATCH = ['stalled-session-resume-overdue', 'auto-progress-start-expired'];
const ASK_ACTION_PATTERN = /判断|承認|決裁|同意|支払|署名|押印|選択/;

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
      if (item.kind === 'ask' && (item.status === 'open' || item.status === 'seen')) {
        items.push(item);
      }
    } catch {
      // 破損した1件で全体を止めない
    }
  }
  return items.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || a.id.localeCompare(b.id));
}

function isDemotable(item) {
  const source = item.source || '';

  if (SOURCES_AUTO_PROGRESS_DONE.includes(source)) {
    // deliverDoneInbox の kind 判定ロジックを再現:
    // inboxBrief({ kind: 'info', text, source }) の decide が
    // falsy または '判断不要（報告のみ）' なら info へ降格可能
    const brief = inboxBrief({ kind: 'info', text: item.text, source });
    return !brief.decide || brief.decide === '判断不要（報告のみ）';
  }

  if (SOURCES_TEXT_MATCH.includes(source)) {
    // stalled-session-resume.mjs 586-592 行の判定を再現:
    // nextAction が /判断|承認|決裁|同意|支払|署名|押印|選択/ にマッチしないなら ask ではない
    return !ASK_ACTION_PATTERN.test(item.text);
  }

  return false;
}

function demotionReason(item) {
  const source = item.source || '';

  if (SOURCES_AUTO_PROGRESS_DONE.includes(source)) {
    const brief = inboxBrief({ kind: 'info', text: item.text, source });
    if (!brief.decide) return 'decide が空のため降格可';
    if (brief.decide === '判断不要（報告のみ）') return '判断不要（報告のみ）のため降格可';
    return `decide が "${brief.decide}" のため据え置き`;
  }

  if (SOURCES_TEXT_MATCH.includes(source)) {
    return 'text に判断ワードが含まれないため降格可';
  }

  return '対象外の source のため据え置き';
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
    const source = item.source || '';
    const isSupported = SOURCES_AUTO_PROGRESS_DONE.includes(source) || SOURCES_TEXT_MATCH.includes(source);

    if (!isSupported) {
      results.push({ id: item.id, source, demote: false, reason: '対象外の source', text: item.text });
      kept++;
      continue;
    }

    if (isDemotable(item)) {
      results.push({ id: item.id, source, demote: true, reason: demotionReason(item), text: item.text });
      demotable++;
    } else {
      results.push({ id: item.id, source, demote: false, reason: demotionReason(item), text: item.text });
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

    // read-back verify: 書き込み後は必ず同じファイルを読み直して kind === 'info' を assert
    const saved = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (saved.kind !== 'info') {
      // 不一致なら元に戻して非ゼロ終了
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
    `${r.id} / ${r.source} / ${r.demote ? '可' : '否'} / ${r.reason} / ${textPreview(r.text)}`
  );
  lines.push(`対象 ${total} 件 / 降格 ${demotable} 件 / 据え置き ${kept} 件`);
  return lines.join('\n');
}

export function backfillKind(directory, { apply = false } = {}) {
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

  const result = backfillKind(dir, { apply });

  if (format === 'json') {
    console.log(JSON.stringify({
      total: result.total,
      demotable: result.demotable,
      kept: result.kept,
      applied: result.applied,
      items: result.items.map(r => ({
        id: r.id,
        source: r.source,
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
