#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readEnvValue } from './env-kv.mjs';

const jsonOutput = process.argv.slice(2).includes('--json');
const home = process.env.ORGIAST_HOME || os.homedir();
const keyserveUrl = process.env.ORGIAST_KEYSERVE_URL || 'https://orgiast-keyserve.vercel.app/api/keys';


function resolveSecret() {
  if (process.env.ORGIAST_KEYSERVE_SECRET) return { source: 'primary', secret: process.env.ORGIAST_KEYSERVE_SECRET };
  const primary = readEnvValue(path.join(home, '.claude', 'keyserve.env'), 'ORGIAST_KEYSERVE_SECRET');
  if (primary) return { source: 'primary', secret: primary };
  const legacy = readEnvValue(path.join(home, '.claude', 'cost-reporter.env'), 'DISCORD_COST_WEBHOOK');
  if (legacy) return { source: 'legacy', secret: legacy };
  return { source: '未設定', secret: '' };
}

const resolved = resolveSecret();
const result = { auth: resolved.source, success: false, status: null, files: [] };

if (resolved.secret) {
  try {
    const ts = Math.floor(Date.now() / 1000).toString();
    const auth = crypto.createHmac('sha256', resolved.secret).update(ts).digest('hex');
    const response = await fetch(keyserveUrl, {
      method: 'POST',
      headers: { 'x-orgiast-ts': ts, 'x-orgiast-auth': auth },
      signal: AbortSignal.timeout(15000),
    });
    result.status = response.status;
    result.success = response.ok;
    if (response.ok) {
      const payload = await response.json();
      if (payload && payload.files && typeof payload.files === 'object' && !Array.isArray(payload.files)) {
        result.files = Object.keys(payload.files);
      }
    }
  } catch (error) {
    result.error = error.message;
  }
}

if (jsonOutput) {
  console.log(JSON.stringify(result));
} else {
  console.log(`認証経路: ${result.auth}`);
  if (resolved.secret) console.log(`keyserve: ${result.success ? '成功' : '失敗'}${result.status === null ? '' : ` (HTTP ${result.status})`}`);
  else console.log('keyserve: 未実行（秘密が未設定）');
  console.log(`配布ファイル: ${result.files.length ? result.files.join(', ') : 'なし'}`);
  if (result.error) console.log(`エラー: ${result.error}`);
  if (result.status === 401) console.log('401 = この PC の秘密が keyserve に登録されていません。kim に enroll トークンの発行を依頼してください。');
}
