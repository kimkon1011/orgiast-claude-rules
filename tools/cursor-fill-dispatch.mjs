#!/usr/bin/env node
// Cursor Ultra への夜間追加回しを制御する。cursor-usage-pace の判定結果を受け、
// 有効なら有効フラグ・キュー・次回セッションTODOを書き込む。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isEntry } from './is-entry.mjs';
import { cursorFillEnabledPath, cursorFillQueuePath, readPaceState } from './lib/cursor-usage-pace.mjs';

export const CURSOR_FILL_TODO = '- [ ] 【夜間】[CURSOR-FILL] 待ち作業を Cursor Ultra で進める（夜間キュー・内部点検・コード改善PR・調べ物）。品質格下げ禁止。従量近くなら halt を尊重。';

export function dispatchCursorFill({ home, now = Date.now(), state } = {}) {
  const pace = state && typeof state === 'object' ? state : readPaceState(home);
  const enabledPath = cursorFillEnabledPath(home);
  const queuePath = cursorFillQueuePath(home);

  // Ensure parent dirs exist
  fs.mkdirSync(path.dirname(enabledPath), { recursive: true });

  if (pace.halt === true || pace.fill !== true) {
    fs.writeFileSync(enabledPath, '0\n', 'utf8');
    return {
      filled: false,
      reason: pace.halt === true ? 'halt' : 'not-fill',
      decision: pace.decision || null,
      enabledPath,
      todoAppended: false,
    };
  }

  // fill === true and halt !== true
  fs.writeFileSync(enabledPath, '1\n', 'utf8');

  // Append queue line
  fs.mkdirSync(path.dirname(queuePath), { recursive: true });
  const queueLine = JSON.stringify({
    t: new Date(now).toISOString(),
    decision: pace.decision || 'behind',
    actions: ['nightly-queue', 'internal-audit', 'code-improve', 'research'],
  });
  fs.appendFileSync(queuePath, `${queueLine}\n`, 'utf8');

  // Append to next-session.md if [CURSOR-FILL] not already present as open todo
  const nextSessionPath = path.join(home, '.claude', 'next-session.md');
  let todoAppended = false;
  try {
    const existing = fs.readFileSync(nextSessionPath, 'utf8');
    const hasOpenCursorFill = /^- \[ \].*\[CURSOR-FILL\]/m.test(existing);
    if (!hasOpenCursorFill) {
      fs.appendFileSync(nextSessionPath, `\n${CURSOR_FILL_TODO}\n`, 'utf8');
      todoAppended = true;
    }
  } catch {
    // File doesn't exist yet
    fs.mkdirSync(path.dirname(nextSessionPath), { recursive: true });
    fs.writeFileSync(nextSessionPath, `${CURSOR_FILL_TODO}\n`, 'utf8');
    todoAppended = true;
  }

  return {
    filled: true,
    reason: 'fill',
    decision: pace.decision || 'behind',
    enabledPath,
    queuePath,
    todoAppended,
  };
}

if (isEntry(import.meta.url)) {
  const home = process.env.ORGIAST_HOME || os.homedir();
  const result = dispatchCursorFill({ home });
  console.log(JSON.stringify(result));
  process.exitCode = 0;
}