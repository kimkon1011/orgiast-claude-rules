#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import { isEntry } from './is-entry.mjs';
import { addItem } from './kim-inbox.mjs';

const COMPANIES_URL = 'https://api.freee.co.jp/api/1/companies';
const TOKEN_URL = 'https://accounts.secure.freee.co.jp/public_api/token';
const TIMEOUT_MS = 15_000;

export function parseEnvFile(file) {
  if (!file) return {};
  const values = {};
  for (const rawLine of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

function timeoutSignal() {
  return AbortSignal.timeout(TIMEOUT_MS);
}

function supabaseHeaders(key, extra = {}) {
  return { apikey: key, Authorization: `Bearer ${key}`, ...extra };
}

async function inspectRow(row, { env, fetchImpl }) {
  let response;
  try {
    response = await fetchImpl(COMPANIES_URL, {
      headers: { Authorization: `Bearer ${row.access_token}` },
      signal: timeoutSignal(),
    });
  } catch {
    return { state: 'unconfirmed', reason: 'freee request failed' };
  }
  if (response.status === 200) return { state: 'ok' };
  if (response.status !== 401) return { state: 'unconfirmed', reason: `freee HTTP ${response.status}` };

  if (!env.FREEE_CLIENT_ID || !env.FREEE_CLIENT_SECRET || !row.refresh_token) {
    return { state: 'broken' };
  }

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: env.FREEE_CLIENT_ID,
    client_secret: env.FREEE_CLIENT_SECRET,
    refresh_token: row.refresh_token,
  });
  let refreshResponse;
  try {
    refreshResponse = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: timeoutSignal(),
    });
  } catch {
    return { state: 'unconfirmed', reason: 'freee refresh request failed' };
  }
  if (refreshResponse.status !== 200) {
    return refreshResponse.status === 400 || refreshResponse.status === 401
      ? { state: 'broken' }
      : { state: 'unconfirmed', reason: `freee refresh HTTP ${refreshResponse.status}` };
  }

  let refreshed;
  try { refreshed = await refreshResponse.json(); } catch { return { state: 'unconfirmed', reason: 'freee refresh response invalid' }; }
  if (!refreshed.access_token || !refreshed.refresh_token) return { state: 'unconfirmed', reason: 'freee refresh response incomplete' };

  const saved = {
    access_token: refreshed.access_token,
    refresh_token: refreshed.refresh_token,
    updated_at: new Date().toISOString(),
  };
  const url = `${env.SUPABASE_URL.replace(/\/$/, '')}/rest/v1/freee_tokens?id=eq.${encodeURIComponent(row.id)}`;
  let patchResponse;
  try {
    patchResponse = await fetchImpl(url, {
      method: 'PATCH',
      headers: supabaseHeaders(env.SUPABASE_SERVICE_ROLE_KEY, {
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      }),
      body: JSON.stringify(saved),
    });
  } catch {
    return { state: 'broken' };
  }
  if (!patchResponse.ok) return { state: 'broken' };
  let rows;
  try { rows = await patchResponse.json(); } catch { return { state: 'broken' }; }
  const stored = rows.find(candidate => String(candidate.id) === String(row.id));
  if (!stored || stored.access_token !== saved.access_token || stored.refresh_token !== saved.refresh_token || stored.updated_at !== saved.updated_at) {
    return { state: 'broken' };
  }
  return { state: 'ok' };
}

export async function runFreeeTokenHealth({
  env = process.env,
  fetchImpl = globalThis.fetch,
  notify = true,
  addItemImpl = addItem,
  stdout = line => console.log(line),
  home = env.ORGIAST_HOME || os.homedir(),
} = {}) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    stdout('freee-token-health: unconfirmed: missing Supabase configuration');
    return 0;
  }
  const url = `${env.SUPABASE_URL.replace(/\/$/, '')}/rest/v1/freee_tokens?select=id,access_token,refresh_token,updated_at`;
  let response;
  try {
    response = await fetchImpl(url, { headers: supabaseHeaders(env.SUPABASE_SERVICE_ROLE_KEY) });
  } catch {
    stdout('freee-token-health: unconfirmed: Supabase request failed');
    return 0;
  }
  if (!response.ok) {
    stdout(`freee-token-health: unconfirmed: Supabase HTTP ${response.status}`);
    return 0;
  }
  let rows;
  try { rows = await response.json(); } catch {
    stdout('freee-token-health: unconfirmed: Supabase response invalid');
    return 0;
  }
  if (!Array.isArray(rows) || rows.length === 0) {
    stdout('freee-token-health: pending');
    return 0;
  }

  const results = [];
  for (const row of rows) results.push({ row, result: await inspectRow(row, { env, fetchImpl }) });
  const broken = results.filter(item => item.result.state === 'broken');
  if (broken.length) {
    if (notify) {
      for (const { row } of broken) {
        try {
          await addItemImpl(home, {
            kind: 'ask',
            source: 'freee-token-health',
            text: '【freee 認可切れ】keiri-hub の freee 接続が切れています（再認可が必要）。' +
              `対象: id=${row.id}。復旧手順: 内蔵ブラウザで keiri2@orgiast.jp にログインして「許可する」→ ` +
              'keiri-hub で `node scripts/freee-reauth.mjs --code=<コード>` を実行（playbook freee.md の再認可手順）。',
            dedupeKey: `freee-auth-broken-${row.id}`,
          }, { drain: false });
        } catch { /* The health result remains broken even if inbox delivery fails. */ }
      }
    }
    stdout(`freee-token-health: broken ${broken.map(({ row }) => `id=${row.id}`).join(' ')}`);
    return 1;
  }
  const uncertain = results.find(item => item.result.state === 'unconfirmed');
  if (uncertain) {
    stdout(`freee-token-health: unconfirmed: ${uncertain.result.reason}`);
    return 0;
  }
  stdout('freee-token-health: ok');
  return 0;
}

function parseArgs(argv) {
  const options = { envFile: null, check: false, notify: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--env-file') {
      if (!argv[index + 1]) throw new Error('--env-file requires a path');
      options.envFile = argv[++index];
    } else if (arg === '--check') options.check = true;
    else if (arg === '--notify') options.notify = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const env = { ...parseEnvFile(args.envFile), ...process.env };
  const notify = args.notify || !args.check;
  return runFreeeTokenHealth({ env, notify });
}

if (isEntry(import.meta.url)) {
  try { process.exitCode = await main(); }
  catch { console.error('freee-token-health: unconfirmed: invalid configuration'); process.exitCode = 0; }
}
