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

export function keyservePcId(home, env = process.env) {
  const pcId = env.ORGIAST_KEYSERVE_PC
    || readEnvValue(path.join(home, '.claude', 'keyserve.env'), 'ORGIAST_KEYSERVE_PC')
    || os.hostname();
  return /^[A-Za-z0-9._-]{1,64}$/.test(pcId) ? pcId : '';
}

/** The server verifies the signature; this only selects the pcId claimed by the enroll request. */
export function keyserveEnrollPcId(token) {
  if (typeof token !== 'string' || !token.startsWith('ORG1.')) return '';
  const parts = token.split('.');
  if (parts.length !== 4) return '';
  try {
    const pcId = Buffer.from(parts[1], 'base64url').toString('ascii');
    return /^[A-Za-z0-9._-]{1,64}$/.test(pcId) ? pcId : '';
  } catch {
    return '';
  }
}

export function keyserveAuthHeaders(secret, now = Date.now(), pcId = '') {
  const ts = Math.floor(now / 1000).toString();
  return {
    'x-orgiast-ts': ts,
    'x-orgiast-auth': crypto.createHmac('sha256', secret).update(ts).digest('hex'),
    ...(pcId ? { 'x-orgiast-pc': pcId } : {}),
  };
}
