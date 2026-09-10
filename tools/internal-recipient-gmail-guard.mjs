#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isEntry } from './is-entry.mjs';
import { readStdin } from './transcript-tail.mjs';

const TARGET = /^mcp__claude_ai_Gmail(?:_\d+)?__(create_draft|send_message|update_draft|reply|forward)$/;
const RECIPIENT_FIELD = /^(?:to|cc|bcc|recipients?|to_?recipients?|cc_?recipients?|bcc_?recipients?|to_?addresses?|cc_?addresses?|bcc_?addresses?)$/i;
const ADDRESS_FIELD = /^(?:email|email_?address|address|value)$/i;

export function extractAddresses(toolInput) {
  const addresses = new Set();
  function visit(value, recipient = false) {
    if (typeof value === 'string') {
      if (recipient) for (const match of value.matchAll(/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+/gi)) addresses.add(match[0].toLowerCase());
    } else if (Array.isArray(value)) {
      for (const item of value) visit(item, recipient);
    } else if (value && typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) visit(item, RECIPIENT_FIELD.test(key) || (recipient && ADDRESS_FIELD.test(key)));
    }
  }
  visit(toolInput);
  return [...addresses];
}

export function isInternal(addr, ledger) {
  const normalized = String(addr).trim().toLowerCase();
  const domain = normalized.slice(normalized.lastIndexOf('@') + 1);
  return ledger.addresses.some((item) => item.trim().toLowerCase() === normalized)
    || (normalized.includes('@') && ledger.domains.some((item) => item.trim().toLowerCase() === domain));
}

export function judge(hookInput, ledger) {
  if (!TARGET.test(hookInput?.tool_name || '')) return { decision: 'pass', addresses: [], internal: [] };
  const addresses = extractAddresses(hookInput.tool_input);
  const internal = addresses.filter((addr) => isInternal(addr, ledger));
  if (!internal.length) return { decision: 'pass', addresses, internal };
  const reason = `[INTERNAL-RECIPIENT] ${internal.join(', ')} は内部（社内・グループ会社・スタッフ）宛です。kim の内部連絡はリモートデスクトップ／LINE／Discord で、Gmail は見に行きません（2026-09-11 厳命）。Gmail の下書き・送信は作らず、チャット本文に「宛先／用件／本文」をコピペできる完成形で表示してください。Gmail 下書きは顧客・取引先・外部の人宛だけ有効です。台帳: ~/.claude/internal-recipients.json`;
  return { decision: 'block', addresses, internal, reason };
}

export function loadLedger({ home = process.env.ORGIAST_HOME || os.homedir() } = {}) {
  const read = (file) => {
    const ledger = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    if (!ledger || !['domains', 'addresses'].every((key) => Array.isArray(ledger[key]) && ledger[key].every((item) => typeof item === 'string'))) throw new Error('台帳の形式が不正です');
    return ledger;
  };
  try {
    return read(path.join(home, '.claude', 'internal-recipients.json'));
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('[INTERNAL-RECIPIENT] 台帳を読めないため default 台帳を使用します。');
    return read(new URL('./internal-recipients.default.json', import.meta.url));
  }
}

async function main() {
  try {
    const raw = await readStdin();
    if (!raw.trim()) return;
    const input = JSON.parse(raw);
    if (!TARGET.test(input?.tool_name || '')) return;
    const result = judge(input, loadLedger());
    if (result.decision === 'block') console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: result.reason } }));
  } catch {
    console.error('[INTERNAL-RECIPIENT] 入力または台帳を読めないため判定をスキップしました。');
  }
}

if (isEntry(import.meta.url)) await main();
