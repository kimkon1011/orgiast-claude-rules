#!/usr/bin/env node
// UserPromptSubmit hook: 「この後の自動進行:」を宣言しなかったセッションも台帳へ載せる。
// 台帳に載らないと watch/digest が何も報告できず、user が「進捗どう？」と聞く羽目になる（2026-10-26 実害）。
// fail-open: どんな失敗でも exit 0・標準出力なし。
import os from 'node:os';
import path from 'node:path';
import { isEntry } from './is-entry.mjs';
import { readStdinWithTimeout } from './lib/hook-stdin.mjs';
import { ledgerFile, readLedger, writeLedger, OPEN_STATUSES } from './auto-progress-ledger.mjs';
import { resolveOwner } from './notify-owner.mjs';

export const MIN_PROMPT_LENGTH = 20;
const SYSTEM_PROMPT = /^\s*(?:<task-notification>|<command-message>|<command-name>|<system-reminder>|Stop hook feedback|\[Subagent hand-back\])/;

export function isHumanRequest(prompt) {
  const text = String(prompt ?? '').trim();
  return text.length >= MIN_PROMPT_LENGTH && !SYSTEM_PROMPT.test(text);
}

export function autoRegister(input, { home = process.env.ORGIAST_HOME || os.homedir(), now = Date.now(), hostname = os.hostname(), user, owner } = {}) {
  const prompt = input?.prompt;
  if (!isHumanRequest(prompt)) return null;
  const transcriptPath = input?.transcript_path || input?.transcriptPath || '';
  const sessionId = input?.session_id || input?.sessionId || (transcriptPath ? path.basename(transcriptPath, '.jsonl') : '');
  if (!sessionId) return null;
  const file = ledgerFile(home);
  const rows = readLedger(file);
  if (rows.some(row => row.sessionId === sessionId && OPEN_STATUSES.has(row.status))) return null;
  const head = String(prompt).trim().replace(/\s+/g, ' ').slice(0, 100);
  const row = {
    ts: new Date(now).toISOString(), pc: hostname, user: user ?? safeUser(), owner: owner ?? resolveOwner({ home }),
    sessionId, cwd: input?.cwd || process.cwd(), transcriptPath,
    promise: `「${head}」の依頼を進める（user 依頼・自動登録）`, nextKim: 'なし', status: 'open',
    label: head.slice(0, 40), origin: 'user-request', autoRegistered: true,
  };
  rows.push(row);
  writeLedger(file, rows);
  return row;
}

function safeUser() { try { return os.userInfo().username; } catch { return ''; } }

async function main() {
  try {
    const raw = await readStdinWithTimeout();
    if (!raw.trim()) return;
    autoRegister(JSON.parse(raw));
  } catch { /* fail-open */ }
}

if (isEntry(import.meta.url)) { await main(); process.exitCode = 0; }
