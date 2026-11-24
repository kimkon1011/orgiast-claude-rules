#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isEntry } from './is-entry.mjs';

const TABLES = ['deals', 'customers'];

function parseEnvFile(file) {
  if (!fs.existsSync(file)) return {};
  const result = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    result[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return result;
}

export function loadSalesCredentials(env = process.env, home = os.homedir()) {
  const fileEnv = parseEnvFile(path.join(home, '.claude', 'secrets', 'sales-app.env'));
  return {
    url: env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL || fileEnv.SUPABASE_URL || fileEnv.NEXT_PUBLIC_SUPABASE_URL,
    key: env.SUPABASE_SERVICE_ROLE_KEY || fileEnv.SUPABASE_SERVICE_ROLE_KEY,
  };
}

async function getRows(table, params, credentials, fetchImpl) {
  const url = new URL(`/rest/v1/${table}`, credentials.url.replace(/\/$/, '') + '/');
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: { apikey: credentials.key, Authorization: `Bearer ${credentials.key}`, Accept: 'application/json' },
  });
  if (!response.ok) throw Object.assign(new Error(`Supabase ${table} GET ${response.status}: ${(await response.text()).slice(0, 200)}`), { status: response.status });
  return response.json();
}

async function getAllRows(table, params, credentials, fetchImpl) {
  const rows = [];
  for (let offset = 0; ; offset += 1000) {
    const page = await getRows(table, { ...params, limit: '1000', offset: String(offset) }, credentials, fetchImpl);
    rows.push(...page);
    if (page.length < 1000) return rows;
  }
}

export async function tableColumns({ credentials, fetchImpl = fetch }) {
  const result = {};
  for (const table of TABLES) {
    const rows = await getRows(table, { select: '*', limit: '1' }, credentials, fetchImpl);
    result[table] = rows[0] ? Object.keys(rows[0]) : [];
  }
  return result;
}

export async function staleDeals({ days = 7, now = new Date(), credentials, fetchImpl = fetch }) {
  const cutoff = new Date(now.getTime() - days * 86400000).toISOString();
  const today = now.toISOString().slice(0, 10);
  const deals = await getAllRows('deals', {
    select: 'id,deal_no,customer_id,deal_title,status,next_contact_date,updated_at',
    or: `(next_contact_date.lt.${today},updated_at.lt.${cutoff})`,
    archived_at: 'is.null',
    order: 'updated_at.asc',
  }, credentials, fetchImpl);
  const ids = [...new Set(deals.map(row => row.customer_id).filter(Boolean))];
  let customers = [];
  for (let offset = 0; offset < ids.length; offset += 100) {
    customers.push(...await getRows('customers', {
      select: 'id,company_name',
      id: `in.(${ids.slice(offset, offset + 100).join(',')})`,
    }, credentials, fetchImpl));
  }
  const companyById = new Map(customers.map(row => [row.id, row.company_name]));
  return deals.map(row => ({ ...row, company_name: companyById.get(row.customer_id) || null }));
}

export async function runSalesDealsRead(args, { env = process.env, home = os.homedir(), fetchImpl = fetch, stdout = console.log, stderr = console.error, now = new Date() } = {}) {
  const credentials = loadSalesCredentials(env, home);
  if (!credentials.url || !credentials.key) {
    stderr('sales-deals-read: Supabase URL または service role key がありません');
    return 2;
  }
  if (args.includes('--tables')) {
    stdout(JSON.stringify(await tableColumns({ credentials, fetchImpl }), null, 2));
    return 0;
  }
  if (args.includes('--stale')) {
    const index = args.indexOf('--days');
    const days = index >= 0 ? Number(args[index + 1]) : 7;
    if (!Number.isFinite(days) || days < 0) throw new Error('--days は0以上の数値を指定してください');
    stdout(JSON.stringify(await staleDeals({ days, now, credentials, fetchImpl }), null, 2));
    return 0;
  }
  throw new Error('使い方: node tools/sales-deals-read.mjs --tables | --stale [--days N]');
}

if (isEntry(import.meta.url)) {
  runSalesDealsRead(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
