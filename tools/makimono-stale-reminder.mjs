#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isEntry } from './is-entry.mjs';
import { appendLedger } from './dead-fallback-invariant.mjs';
import { checkSubmissions } from './makimono-publish.mjs';
import { acquireLock } from './lib/single-instance.mjs';

/**
 * Periodically checks for makimono submissions that are pending review
 * and sends alerts if any of them are stale.
 * 
 * @param {object} [options]
 * @param {string} [options.home] Default is process.env.ORGIAST_HOME || os.homedir()
 * @param {Date} [options.now] Default is new Date()
 * @param {number} [options.throttleMs] Default is 4 * 60 * 60 * 1000 (4 hours)
 * @param {number} [options.staleDays] Default is 3
 * @param {string} [options.ledgerFile] Default is process.env.ORGIAST_SELFHEAL_LEDGER or home/.claude/hook-selfheal-ledger.jsonl
 * @param {string} [options.stateFile] Default is process.env.ORGIAST_MAKIMONO_REMINDER_STATE or home/.claude/makimono-stale-reminder-state.json
 * @param {typeof fetch} [options.fetchImpl] Default is fetch
 * @returns {Promise<{ ran: boolean, reason?: string, result?: any }>}
 */
export async function runCheck({
  home = process.env.ORGIAST_HOME || os.homedir(),
  now = new Date(),
  throttleMs = 4 * 60 * 60 * 1000,
  staleDays = 3,
  ledgerFile = process.env.ORGIAST_SELFHEAL_LEDGER || path.join(home, '.claude', 'hook-selfheal-ledger.jsonl'),
  stateFile = process.env.ORGIAST_MAKIMONO_REMINDER_STATE || path.join(home, '.claude', 'makimono-stale-reminder-state.json'),
  fetchImpl = fetch,
} = {}) {
  let lastRunAt;
  try {
    if (fs.existsSync(stateFile)) {
      const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      lastRunAt = state.lastRunAt;
    }
  } catch (error) {
    // Ignore reading or parsing errors to remain robust.
  }

  if (lastRunAt) {
    const lastTime = new Date(lastRunAt).getTime();
    if (Number.isFinite(lastTime) && (now.getTime() - lastTime) < throttleMs) {
      return { ran: false, reason: 'throttled' };
    }
  }

  const args = ['--notify', '--stale-days', String(staleDays)];
  const result = await checkSubmissions(args, { compact: true, home, fetchImpl, now });
  if (!result) {
    return { ran: false, reason: 'no-log' };
  }

  // Update state file
  try {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify({ lastRunAt: now.toISOString() }) + '\n');
  } catch (error) {
    console.error(`[makimono-stale-reminder] state file write failed: ${error.message}`);
  }

  // Write to ledger
  appendLedger(ledgerFile, {
    tool: 'makimono-stale-reminder',
    pending: result.pending,
    stale: result.stale,
    rejected: result.rejected,
  });

  return { ran: true, result };
}

if (isEntry(import.meta.url)) {
  const lock = acquireLock('makimono-stale-reminder');
  if (!lock.acquired) console.error(`[makimono-stale-reminder] already running pid=${lock.ownerPid ?? 'unknown'}`);
  else runCheck().catch((error) => {
      console.error(`[makimono-stale-reminder] Execution failed: ${error.message}`);
    });
}
