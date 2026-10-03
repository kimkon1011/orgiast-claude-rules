#!/usr/bin/env node
// freee 会計を読むだけのツール（GET のみ）。
// トークンは購買部アプリの Neon DB（freee_tokens, id='default'）にあり、期限切れなら
// アプリと同じ方式で更新して書き戻す（freee の refresh_token はローテーションする）。
// 接続文字列は repo 直下 .env.local の PURCHASING_APP_DATABASE_URL。トークン類は一切出力しない。
//
// 使い方:
//   node tools/freee-query.mjs --partners "クラフトフィックス"
//   node tools/freee-query.mjs --partner "クラフトフィックス|*" --from 2025-10-01 --to 2026-09-30 [--type income|expense] [--out path.json]

import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { isEntry } from './is-entry.mjs';

const COMPANY_ID = 11975741;
const API = 'https://api.freee.co.jp';
const TOKEN_URL = 'https://accounts.secure.freee.co.jp/public_api/token';
const EXPIRY_MARGIN_MS = 120 * 1000;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function loadDbUrl() {
  if (process.env.PURCHASING_APP_DATABASE_URL) return process.env.PURCHASING_APP_DATABASE_URL;
  const text = readFileSync(join(ROOT, '.env.local'), 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?PURCHASING_APP_DATABASE_URL\s*=\s*(.*)$/);
    if (m) return m[1].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  throw new Error('PURCHASING_APP_DATABASE_URL が .env.local に見つかりません');
}

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) a[argv[i].slice(2)] = argv[i + 1]?.startsWith('--') || argv[i + 1] === undefined ? true : argv[++i];
  }
  return a;
}

async function getAccessToken() {
  const sql = postgres(loadDbUrl(), { max: 1, ssl: 'require', onnotice: () => {} });
  try {
    const [row] = await sql`select client_id, client_secret, refresh_token, access_token, access_expires_at
      from freee_tokens where id = 'default' limit 1`;
    if (!row) throw new Error('freee_tokens に default 行がありません');
    if (row.access_token && row.access_expires_at && new Date(row.access_expires_at).getTime() > Date.now() + EXPIRY_MARGIN_MS) {
      return row.access_token;
    }
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: row.client_id,
        client_secret: row.client_secret,
        refresh_token: row.refresh_token,
      }),
    });
    if (!res.ok) throw new Error(`freee トークン更新に失敗: HTTP ${res.status}`);
    const j = await res.json();
    const expiresAt = new Date(Date.now() + j.expires_in * 1000);
    await sql`update freee_tokens set refresh_token = ${j.refresh_token}, access_token = ${j.access_token},
      access_expires_at = ${expiresAt}, updated_at = now() where id = 'default'`;
    return j.access_token;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function freeeGet(token, path, params) {
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
  const res = await fetch(url, { method: 'GET', headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`freee API ${path} HTTP ${res.status}`);
  return res.json();
}

async function listPartners(token, keyword) {
  const out = [];
  for (let offset = 0; ; offset += 100) {
    const j = await freeeGet(token, '/api/1/partners', { company_id: COMPANY_ID, keyword, limit: 100, offset });
    const ps = j.partners ?? [];
    out.push(...ps.map((p) => ({ id: p.id, name: p.name })));
    if (ps.length < 100) break;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const token = await getAccessToken();

  if (args.partners) {
    const ps = await listPartners(token, args.partners);
    console.log(`partners: ${ps.length}`);
    for (const p of ps) console.log(`${p.id}\t${p.name}`);
    return;
  }

  if (!args.partner || !args.from || !args.to) {
    console.error('usage: --partners "<name>" | --partner "<name>|*" --from YYYY-MM-DD --to YYYY-MM-DD [--type income|expense] [--out file.json]');
    process.exit(2);
  }

  let partnerId;
  if (args.partner !== '*') {
    const ps = await listPartners(token, args.partner);
    const hit = ps.find((p) => p.name === args.partner) ?? ps[0];
    if (!hit) throw new Error(`取引先が見つかりません: ${args.partner}`);
    if (ps.length > 1) console.error(`注意: ${ps.length} 件ヒット。先頭 ${hit.id} ${hit.name} を使用`);
    partnerId = hit.id;
  }

  const deals = [];
  for (let offset = 0; ; offset += 100) {
    const j = await freeeGet(token, '/api/1/deals', {
      company_id: COMPANY_ID,
      partner_id: partnerId,
      start_issue_date: args.from,
      end_issue_date: args.to,
      type: args.type === true ? undefined : args.type,
      limit: 100,
      offset,
    });
    const ds = j.deals ?? [];
    deals.push(...ds);
    if (ds.length < 100) break;
  }

  const sum = { income: 0, expense: 0 };
  for (const d of deals) if (d.type in sum) sum[d.type] += Number(d.details?.reduce((s, x) => s + (x.amount ?? 0), 0) ?? d.amount ?? 0);
  console.log(`deals: ${deals.length}${partnerId ? ` (partner_id ${partnerId})` : ' (all partners)'} ${args.from}..${args.to}`);
  console.log(`income合計: ${sum.income}  expense合計: ${sum.expense}`);
  if (args.out && args.out !== true) {
    await writeFile(args.out, JSON.stringify(deals, null, 2), 'utf8');
    console.log(`out: ${args.out}`);
  }
}

if (isEntry(import.meta.url)) {
  main().catch((e) => {
    console.error(`ERROR: ${e.message}`);
    process.exit(1);
  });
}
