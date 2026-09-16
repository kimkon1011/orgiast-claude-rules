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

export function keyserveAuthHeaders(secret, now = Date.now(), pcId = '') {
  const ts = Math.floor(now / 1000).toString();
  return {
    'x-orgiast-ts': ts,
    'x-orgiast-auth': crypto.createHmac('sha256', secret).update(ts).digest('hex'),
    ...(pcId ? { 'x-orgiast-pc': pcId } : {}),
  };
}
