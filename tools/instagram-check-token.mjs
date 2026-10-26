#!/usr/bin/env node
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isEntry } from './is-entry.mjs';

// Resolve from the installed script, never from the invoking shell's cwd.
export async function checkToken({ envFile = fileURLToPath(new URL('../../.env', import.meta.url)), fetchImpl = globalThis.fetch } = {}) {
  let env;
  try { env = fs.readFileSync(envFile, 'utf8'); }
  // 未配置は「まだ登録していない」であって「確認できない」ではない。
  catch (error) {
    return error.code === 'ENOENT'
      ? { status: 'pending', message: 'token_missing' }
      : { status: 'unconfirmed', message: 'instagram_check_unavailable' };
  }
  const value = env.match(/^\s*(?:export\s+)?INSTAGRAM_ACCESS_TOKEN\s*=\s*(.*)$/m)?.[1]?.trim() || '';
  const token = /^["']/.test(value) ? value.slice(1, value.indexOf(value[0], 1)) : value.replace(/\s+#.*$/, '').trim();
  if (!token) return { status: 'pending', message: 'token_missing' };
  try {
    const response = await fetchImpl('https://graph.instagram.com/v21.0/me?fields=username', {
      headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return { status: 'unconfirmed', message: `instagram_http_${response.status}` };
    const data = await response.json();
    return data.username === 'lahaina_ushimado'
      ? { status: 'done', message: 'lahaina_ushimado' }
      : { status: 'pending', message: 'account_mismatch' };
  } catch { return { status: 'unconfirmed', message: 'instagram_check_unavailable' }; }
}
if (isEntry(import.meta.url)) {
  const result = await checkToken();
  console.log(result.message);
  process.exitCode = result.status === 'unconfirmed' ? 1 : 0;
}
