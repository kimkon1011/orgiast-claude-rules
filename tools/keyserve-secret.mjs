import os from 'node:os';
import path from 'node:path';
import { readEnvValue } from './env-kv.mjs';

export function resolveKeyserveSecret({ home = os.homedir(), env = process.env } = {}) {
  const primary = env.ORGIAST_KEYSERVE_SECRET || readEnvValue(path.join(home, '.claude', 'keyserve.env'), 'ORGIAST_KEYSERVE_SECRET');
  if (primary) return { source: 'primary', secret: primary };
  const enroll = env.ORGIAST_ENROLL_TOKEN || readEnvValue(path.join(home, '.claude', 'enroll.env'), 'ORGIAST_ENROLL_TOKEN');
  if (enroll) return { source: 'enroll', secret: enroll };
  const legacy = readEnvValue(path.join(home, '.claude', 'cost-reporter.env'), 'DISCORD_COST_WEBHOOK');
  return legacy ? { source: 'legacy', secret: legacy } : { source: 'none', secret: '' };
}

export function reportKeyserveSource(source) {
  if (source === 'enroll') console.error('enroll token を使用中（初回登録）');
  if (source === 'none') console.error('keyserve に認証する秘密がありません（配布コマンドに -EnrollToken が無い）');
}
