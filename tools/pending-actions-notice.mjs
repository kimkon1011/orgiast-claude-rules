#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readStdinWithTimeout } from './lib/hook-stdin.mjs';
import { isEntry } from './is-entry.mjs';
import { FINAL_ONLY_INSTRUCTION, isLoopWake } from './lib/inbox-display-policy.mjs';

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
    FINAL_ONLY_INSTRUCTION,
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

export function pendingActionsContext(input = {}, { home = process.env.ORGIAST_HOME || os.homedir(), now = Date.now() } = {}) {
  try {
    if (isLoopWake(input, { home, now, hook: 'pending-actions-notice' })) return null;
    const file = path.join(home, '.claude', 'pending-user-actions.md');
    const actions = parsePendingActions(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''), new Date(now));
    return actions.length ? { hookSpecificOutput: {
      hookEventName: input.hook_event_name || 'SessionStart', additionalContext: formatPendingActions(actions),
    } } : null;
  } catch { return null; }
}
if (isEntry(import.meta.url)) {
  try {
    const out = pendingActionsContext(JSON.parse((await readStdinWithTimeout(500)) || '{}'));
    if (out) console.log(JSON.stringify(out));
  } catch { /* SessionStart を妨げない。 */ }
}
