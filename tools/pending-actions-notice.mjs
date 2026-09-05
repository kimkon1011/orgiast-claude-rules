#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isEntry } from './is-entry.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;

function localDateParts(date) {
  return {
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate(),
  };
}

function parseDateParts(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;

  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const localDate = new Date(year, month - 1, day);

  if (
    localDate.getFullYear() !== year
    || localDate.getMonth() !== month - 1
    || localDate.getDate() !== day
  ) return null;

  return { year, month, day };
}

function calendarDayNumber({ year, month, day }) {
  return Date.UTC(year, month - 1, day) / DAY_MS;
}

export function parsePendingActions(text, today = new Date()) {
  if (!(today instanceof Date) || Number.isNaN(today.getTime())) return [];

  const todayParts = localDateParts(today);
  const todayDayNumber = calendarDayNumber(todayParts);
  const actions = [];

  for (const line of String(text ?? '').split(/\r?\n/)) {
    const match = /^- \[ \]\s+(.+)$/.exec(line);
    if (!match) continue;

    const fields = match[1].split('|').map((field) => field.trim());
    if (fields.length < 2 || !fields[1]) continue;

    const dueParts = parseDateParts(fields[0]);
    if (!dueParts) continue;

    const elapsedDays = todayDayNumber - calendarDayNumber(dueParts);
    if (elapsedDays < 0) continue;

    actions.push({
      dueDate: fields[0],
      subject: fields[1],
      details: fields.slice(2).filter(Boolean),
      elapsedDays,
    });
  }

  return actions;
}

export function formatPendingActions(actions) {
  const lines = [
    'この応答の冒頭で、以下をそのまま user に伝えること。',
    '',
    '未処理のユーザーアクションがあります。',
  ];

  for (const action of actions) {
    const details = action.details.length ? ` / ${action.details.join(' / ')}` : '';
    const elapsed = action.elapsedDays === 0 ? '本日期限' : `${action.elapsedDays}日経過`;
    lines.push(`- ${action.subject}${details}（期日: ${action.dueDate}、${elapsed}）`);
  }

  lines.push('', '完了したら `~/.claude/pending-user-actions.md` の該当行を `- [x]` に変えること。');
  return lines.join('\n');
}

if (isEntry(import.meta.url)) {
  try {
    const file = path.join(os.homedir(), '.claude', 'pending-user-actions.md');
    const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    const actions = parsePendingActions(text, new Date());

    if (actions.length > 0) {
      const out = formatPendingActions(actions);
      console.log(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: out,
        },
      }));
    }
  } catch {
    // SessionStart を妨げない。読み込み・パース・出力の異常時は黙って終了する。
  }
}
