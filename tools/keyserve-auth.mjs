import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readEnvValue } from './env-kv.mjs';

export function keyserveSecret(home, env = process.env) {
  return env.ORGIAST_KEYSERVE_SECRET
    || readEnvValue(path.join(home, '.claude', 'keyserve.env'), 'ORGIAST_KEYSERVE_SECRET')
    || '';
}

export function keyserveAuthHeaders(secret, now = Date.now()) {
  const ts = Math.floor(now / 1000).toString();
  return {
    'x-orgiast-ts': ts,
    'x-orgiast-auth': crypto.createHmac('sha256', secret).update(ts).digest('hex'),
  };
}
