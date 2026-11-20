import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const WINDOW_MS = 24 * 60 * 60 * 1000;

export class SendDedupeError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'SendDedupeError';
    this.exitCode = 4;
    Object.assign(this, details);
  }
}

export function normalizeBody(value) {
  return String(value ?? '').replace(/\r\n?/gu, '\n').replace(/[ \t]+$/gmu, '').replace(/\n{3,}/gu, '\n\n').trim();
}

export function bodyDigest(body) {
  return crypto.createHash('sha256').update(normalizeBody(body), 'utf8').digest('hex');
}

export function normalizeRecipients(values) {
  const found = [];
  for (const value of Array.isArray(values) ? values : [values]) {
    for (const match of String(value ?? '').matchAll(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu)) found.push(match[0].toLowerCase());
  }
  return [...new Set(found)].sort();
}

const refusal = sentAt => `同じ宛先へ ${sentAt} に送信済み。続けて送る正当な理由があれば --allow-repeat "<理由>" を付ける`;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Hold the lock until success is recorded (or release is called), preventing parallel check/send races. */
export async function acquireSendDedupe({ recipients, body, allowRepeat, home = os.homedir(), now = () => new Date(), lockTimeoutMs = 30000 } = {}) {
  const to = normalizeRecipients(recipients);
  if (!to.length) throw new SendDedupeError('送信先メールアドレスを特定できないため送信を拒否しました');
  if (allowRepeat !== undefined && !String(allowRepeat).trim()) throw new SendDedupeError('--allow-repeat には正当な理由が必要です');
  const dir = path.join(home, '.claude');
  const ledger = path.join(dir, 'send-ledger.jsonl');
  const lock = `${ledger}.lock`;
  fs.mkdirSync(dir, { recursive: true });
  const started = Date.now();
  while (true) {
    try { fs.mkdirSync(lock); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (Date.now() - started >= lockTimeoutMs) throw new SendDedupeError('送信重複チェックが使用中のため送信を拒否しました');
      await wait(50);
    }
  }
  let held = true;
  const release = () => { if (held) { held = false; fs.rmSync(lock, { recursive: true, force: true }); } };
  try {
    const current = now();
    const at = current instanceof Date ? current : new Date(current);
    const cutoff = at.getTime() - WINDOW_MS;
    let rows = [];
    try { rows = fs.readFileSync(ledger, 'utf8').split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line)); }
    catch (error) { if (error.code !== 'ENOENT') throw new SendDedupeError('送信台帳を検証できないため送信を拒否しました'); }
    const duplicate = rows.findLast(row => Date.parse(row.sentAt) >= cutoff && row.to?.some(address => to.includes(String(address).toLowerCase())));
    if (duplicate && allowRepeat === undefined) throw new SendDedupeError(refusal(duplicate.sentAt), { sentAt: duplicate.sentAt });
    return {
      duplicate,
      recordSuccess(extra = {}) {
        const row = { sentAt: at.toISOString(), to, bodyHash: bodyDigest(body), ...(allowRepeat !== undefined ? { allowRepeatReason: String(allowRepeat).trim() } : {}), ...extra };
        fs.appendFileSync(ledger, `${JSON.stringify(row)}\n`, { encoding: 'utf8', flush: true });
        release();
        return row;
      },
      release,
    };
  } catch (error) { release(); throw error; }
}

export function duplicateMessage(sentAt) { return refusal(sentAt); }
