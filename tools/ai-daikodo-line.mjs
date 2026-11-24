#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { isEntry } from './is-entry.mjs';

export function parseArgs(argv) {
  const result = { json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--status' || arg === '--inbox') {
      if (result.command) throw new Error('choose --status or --inbox');
      result.command = arg.slice(2);
    } else if (arg === '--json') result.json = true;
    else if (arg === '--since') {
      const value = argv[++i];
      if (!value || !Number.isFinite(Date.parse(value))) throw new Error('--since requires a valid date');
      result.since = value;
    } else throw new Error(`unknown argument: ${arg}`);
  }
  if (!result.command) throw new Error('use --status or --inbox');
  if (result.command === 'inbox') result.since ??= new Date(Date.now() - 7 * 864e5).toISOString();
  return result;
}
export function configuration({ env = process.env, home = os.homedir(), readFile = fs.readFileSync } = {}) {
  let saved = {};
  try { saved = parseEnv(readFile(path.join(home, '.claude', 'tanom-admin.env'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  // The protected local file is the rotation source of truth. Long-lived parent
  // processes can retain an obsolete inherited variable after a key rotation.
  const key = saved.TANOM_ADMIN_KEY || env.AI_DAIKODO_ADMIN_API_KEY || env.TANOM_ADMIN_KEY;
  const base = env.AI_DAIKODO_BASE_URL || env.TANOM_BASE || saved.TANOM_BASE || 'https://ai-daikodo.com';
  return { key, base };
}
export async function callAdmin(apiPath, { fetchImpl = fetch, key, base = 'https://ai-daikodo.com', method = 'GET', body } = {}) {
  if (!key) throw new Error('Set AI_DAIKODO_ADMIN_API_KEY or ~/.claude/tanom-admin.env');
  const url = new URL(base);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Admin base must be an HTTPS URL without credentials');
  const response = await fetchImpl(new URL(apiPath, url), {
    ...(method === 'GET' ? {} : { method }), headers: { Authorization: `Bearer ${key}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(120000),
  });
  const text = await response.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new Error(`admin API HTTP ${response.status}: invalid JSON`); }
  // Keep partial inbox data and diagnostics, but return a failing exit code.
  if (parsed?.incomplete === true && Array.isArray(parsed.threads) && [206, 503].includes(response.status)) return parsed;
  if (!response.ok) throw new Error(`admin API HTTP ${response.status}: ${JSON.stringify(parsed).split(key).join('[REDACTED]')}`);
  return parsed;
}
export async function pushLine({ userId, text, retryKey }, options = {}) {
  if (!/^U[0-9a-f]+$/i.test(userId || '') || typeof text !== 'string' || !text.trim() ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(retryKey || '')) throw new Error('push requires userId, text and UUID v5 retryKey');
  const result = await callAdmin('/api/admin/line/push', { ...options, method: 'POST', body: { userId, text, retryKey } });
  if (result?.lineStatus !== 200 && !(result?.lineStatus === 409 && result?.duplicate === true)) throw new Error('LINE push acknowledgement missing');
  return result;
}
export async function run(argv, options = {}) {
  const args = parseArgs(argv);
  const apiPath = args.command === 'status' ? '/api/admin/line/webhook-status'
    : `/api/admin/line/inbox?since=${encodeURIComponent(args.since)}`;
  const body = await callAdmin(apiPath, options);
  const degraded = body?.incomplete === true || (args.command === 'status' &&
    [body?.storage, body?.discord?.channel, body?.discord?.archivedThreads, body?.test].some(item => item?.ok === false));
  return { args, body, exitCode: degraded ? 2 : 0 };
}
export async function main(argv, options = {}) {
  const { out = console.log, err = console.error } = options;
  try {
    const result = await run(argv, { ...configuration(options), ...options });
    out(JSON.stringify(result.body, null, 2));
    if (result.exitCode) err('受信箱の取得に障害があります。空配列を「メッセージなし」と判断しないでください。');
    return result.exitCode;
  } catch (error) { err(error.message); return 1; }
}
if (isEntry(import.meta.url)) process.exitCode = await main(process.argv.slice(2));

