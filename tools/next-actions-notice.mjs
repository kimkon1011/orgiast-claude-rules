#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isEntry } from './is-entry.mjs';

const BEGIN = '<!-- NEXT-ACTIONS:BEGIN -->';
const END = '<!-- NEXT-ACTIONS:END -->';
const MAX_AGE_MS = 30 * 60 * 60 * 1000;

function extractSection(text) {
  const start = text.indexOf(BEGIN);
  if (start < 0) return null;
  const end = text.indexOf(END, start + BEGIN.length);
  if (end < 0) return null;
  return text.slice(start + BEGIN.length, end);
}

function parseGeneratedAt(section) {
  const match = section.match(/^##\s+明日の推奨アクション（(\d{4}\/\d{1,2}\/\d{1,2}\s+\d{1,2}:\d{2}:\d{2})）\s*$/m);
  if (!match) return { text: null, date: null };
  const text = match[1];
  const parts = text.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})$/);
  if (!parts) return { text, date: null };
  const [, year, month, day, hour, minute, second] = parts.map(Number);
  const valid = month >= 1 && month <= 12 && day >= 1 &&
    day <= new Date(Date.UTC(year, month, 0)).getUTCDate() &&
    hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59 && second >= 0 && second <= 59;
  if (!valid) return { text, date: null };
  const date = new Date(Date.UTC(year, month - 1, day, hour - 9, minute, second));
  return { text, date };
}

function parseActions(section) {
  const actions = [];
  let current = null;
  for (const line of section.split(/\r?\n/)) {
    const item = line.match(/^\s*\d+[.)]\s+(.+?)(?:\s+\[([^\]]+)\])\s*$/);
    if (item) {
      current = { title: item[1].trim(), source: item[2].trim(), first_step: '' };
      actions.push(current);
      continue;
    }
    const firstStep = line.match(/^\s*-\s*first_step:\s*(.+?)\s*$/i);
    if (current && firstStep) current.first_step = firstStep[1].trim();
  }
  return actions.filter((action) => action.title && action.source && action.first_step);
}

function emptyResult(generatedAt = null) {
  return { fresh: false, generatedAt, actions: [] };
}

function openWorkNotice(home, now) {
  const file = path.join(home, '.claude', 'open-work.md');
  try {
    if (now.getTime() - fs.statSync(file).mtimeMs > MAX_AGE_MS || now.getTime() < fs.statSync(file).mtimeMs) return '';
    const match = fs.readFileSync(file, 'utf8').match(/^ok:PR(\d+) ブランチ(\d+) タスク\d+\(P1 (\d+)\) TODO\d+ 夜間異常\d+(?:\s*\/.*)?$/m);
    return match ? `未処理の在庫: PR${match[1]}件 / 取り残しブランチ${match[2]}件 / P1タスク${match[3]}件 → ~/.claude/open-work.md` : '';
  } catch { return ''; }
}

export function runNextActionsNotice(options = {}) {
  const home = options.home || os.homedir();
  const now = options.now instanceof Date ? options.now :
    (typeof options.now === 'function' ? options.now() : new Date());
  const args = options.args || [];
  const log = options.log || console.log;
  const error = options.error || console.error;
  const json = args.includes('--json');
  let result = emptyResult();

  try {
    const file = path.join(home, '.claude', 'next-actions.md');
    let text;
    try { text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''); }
    catch (readError) {
      if (readError?.code !== 'ENOENT') error(`next-actions-notice: 読み込み失敗: ${readError?.message || readError}`);
      if (json) log(JSON.stringify(result));
      return result;
    }

    const section = extractSection(text);
    if (section === null) {
      if (json) log(JSON.stringify(result));
      return result;
    }

    const generated = parseGeneratedAt(section);
    result = emptyResult(generated.text);
    if (!generated.date) {
      error('next-actions-notice: 生成日時を解釈できないため表示を省略');
      if (json) log(JSON.stringify(result));
      return result;
    }

    const age = now.getTime() - generated.date.getTime();
    if (!Number.isFinite(age) || age < 0 || age > MAX_AGE_MS) {
      if (json) log(JSON.stringify(result));
      return result;
    }

    const actions = parseActions(section).slice(0, 6);
    result = { fresh: true, generatedAt: generated.text, actions };
    if (json) {
      log(JSON.stringify(result));
      return result;
    }

    const inventory = openWorkNotice(home, now);
    log([
      `## 明日の推奨アクション（${generated.text}・夜間の作り置き）`,
      ...actions.map((action, index) => `${index + 1}. ${action.title} [${action.source}] — ${action.first_step}`),
      '詳細: ~/.claude/next-actions.md',
      ...(inventory ? [inventory] : [])
    ].join('\n'));
    return result;
  } catch (unexpected) {
    error(`next-actions-notice: 予期しないエラー: ${unexpected?.message || unexpected}`);
    if (json) log(JSON.stringify(result));
    return result;
  }
}

if (isEntry(import.meta.url)) runNextActionsNotice({ args: process.argv.slice(2) });
