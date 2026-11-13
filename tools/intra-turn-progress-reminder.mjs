#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isEntry } from './is-entry.mjs';
import { readStdinWithTimeout } from './lib/hook-stdin.mjs';
import { isUnattendedSession } from './lib/unattended-session.mjs';
import { fileURLToPath } from 'node:url';
import { mobilePushInstruction } from './lib/mobile-push-queue.mjs';
import { resolveOwner } from './lib/fleet-owner.mjs';

export const REMINDER = '【進捗報告リマインダー】user 向けチャットに1行の進捗（「X/Y 完了」「次に Z 処理」等）を出してください。memory intra-turn-progress-updates のルール。この後も3ツール呼出ごとに再提示されます。';

export function resolveThreshold(env = process.env) {
  const value = Number(env.INTRA_TURN_PROGRESS_THRESHOLD ?? 3);
  return Number.isInteger(value) && value >= 1 && value <= 20 ? value : 3;
}

export function counterFile(home, sessionId) {
  return path.join(home, '.claude', '.intra-turn-progress-counter', `${encodeURIComponent(String(sessionId))}.json`);
}

export function tickCounter(file, threshold, now = Date.now()) {
  let state = { count: 0, lastReminderAt: null };
  try {
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Number.isInteger(stored.count) && stored.count >= 0) state.count = stored.count;
    if (typeof stored.lastReminderAt === 'number') state.lastReminderAt = stored.lastReminderAt;
  } catch {}
  state.updatedAt = now;
  state.count += 1;
  const fired = state.count >= threshold;
  if (fired) state = { count: 0, lastReminderAt: now, updatedAt: now };
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(file), 0o700);
  fs.writeFileSync(file, JSON.stringify(state), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return { fired, ...state };
}

export function main(input, { home = os.homedir(), env = process.env, now = Date.now() } = {}) {
  const skipped = { fired: false, count: 0 };
  try {
    if (env.INTRA_TURN_PROGRESS_DISABLED === '1') return { emitted: null, state: skipped };
    const sessionId = input?.session_id || input?.sessionId;
    if (!sessionId || isUnattendedSession(input, { home, env })) return { emitted: null, state: skipped };
    const state = tickCounter(counterFile(home, sessionId), resolveThreshold(env), now);
    const pushContext = mobilePushInstruction(home, {
      now, owner: resolveOwner({ home }),
      cliPath: fileURLToPath(new URL('./mobile-push-queue.mjs', import.meta.url)),
    });
    return { emitted: state.fired ? REMINDER : null, state, pushContext };
  } catch {
    return { emitted: null, state: skipped };
  }
}

async function run() {
  try {
    const raw = await readStdinWithTimeout(1000);
    const result = main(raw.trim() ? JSON.parse(raw) : {});
    if (result.pushContext) {
      process.stdout.write(JSON.stringify({ hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: [result.emitted, result.pushContext].filter(Boolean).join('\n'),
      } }));
    } else if (result.emitted) process.stdout.write(result.emitted);
  } catch {}
}

if (isEntry(import.meta.url)) await run();
