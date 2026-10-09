import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readEnvValue } from './env-kv.mjs';

export function keyserveSecret(home, env = process.env) {
  return env.ORGIAST_KEYSERVE_SECRET
    || readEnvValue(path.join(home, '.claude', 'keyserve.env'), 'ORGIAST_KEYSERVE_SECRET')
    || '';
}

export const PC_ID_ERROR = 'PC名を決められないため keyserve に接続しません。ORGIAST_KEYSERVE_PC に ASCII のPC名（例: cr-PC）を設定してください。';
export const validKeyservePcId = value => typeof value === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(value);
export const isEnrollToken = value => typeof value === 'string' && value.startsWith('ORG1.');

export function keyservePcId(home, env = process.env, hostname = os.hostname()) {
  // Keep existing explicit overrides, including the identity saved by the server.
  const explicit = env.ORGIAST_KEYSERVE_PC
    || readEnvValue(path.join(home, '.claude', 'keyserve.env'), 'ORGIAST_KEYSERVE_PC');
  if (explicit) return validKeyservePcId(explicit) ? explicit : '';
  if (validKeyservePcId(hostname)) return hostname;
  const reporter = readEnvValue(path.join(home, '.claude', 'cost-reporter.env'), 'REPORTER_LABEL');
  if (validKeyservePcId(reporter)) return reporter;
  let saved = '';
  try { saved = fs.readFileSync(path.join(home, '.claude', 'keyserve-pc.txt'), 'utf8').trim(); } catch {}
  return validKeyservePcId(saved) ? saved : '';
}

export function requireKeyservePcId(home, env = process.env) {
  const pc = keyservePcId(home, env);
  if (!pc) throw Object.assign(new Error(PC_ID_ERROR), { code: 'KEYSERVE_PC_UNRESOLVED' });
  return pc;
}

export function keyserveAuthHeaders(secret, now = Date.now(), pcId = '') {
  const ts = Math.floor(now / 1000).toString();
  return {
    'x-orgiast-ts': ts,
    'x-orgiast-auth': crypto.createHmac('sha256', secret).update(ts).digest('hex'),
    ...(pcId ? { 'x-orgiast-pc': pcId } : {}),
  };
}
