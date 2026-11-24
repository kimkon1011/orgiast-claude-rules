import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { runSalesDealsRead, staleDeals } from './sales-deals-read.mjs';

test('stale deals uses GET only and attaches company names', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), method: options.method });
    assert.equal(options.method, 'GET');
    const pathname = new URL(url).pathname;
    if (pathname.endsWith('/deals')) return Response.json([{ id: 'd1', customer_id: 'c1', deal_title: '展示会', updated_at: '2026-11-01T00:00:00Z' }]);
    return Response.json([{ id: 'c1', company_name: 'Example社' }]);
  };
  const rows = await staleDeals({ days: 7, now: new Date('2026-11-24T00:00:00Z'), credentials: { url: 'https://example.supabase.co', key: 'secret' }, fetchImpl });
  assert.equal(rows[0].company_name, 'Example社');
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /or=/);
});

test('customer lookup is split to keep GET URLs bounded', async () => {
  let customerCalls = 0;
  const deals = Array.from({ length: 101 }, (_, i) => ({ id: `d${i}`, customer_id: `c${i}` }));
  const fetchImpl = async url => {
    if (new URL(url).pathname.endsWith('/deals')) return Response.json(deals);
    customerCalls++;
    return Response.json([]);
  };
  await staleDeals({ credentials: { url: 'https://example.supabase.co', key: 'secret' }, fetchImpl });
  assert.equal(customerCalls, 2);
});

test('stale deal reads continue past the Supabase 1000-row page', async () => {
  let dealCalls = 0;
  const fetchImpl = async url => {
    const parsed = new URL(url);
    if (!parsed.pathname.endsWith('/deals')) return Response.json([]);
    dealCalls++;
    return Response.json(dealCalls === 1 ? Array.from({ length: 1000 }, (_, i) => ({ id: `d${i}` })) : [{ id: 'last' }]);
  };
  const rows = await staleDeals({ credentials: { url: 'https://example.supabase.co', key: 'secret' }, fetchImpl });
  assert.equal(rows.length, 1001);
  assert.equal(dealCalls, 2);
});

test('missing credentials exits 2 without fetching', async t => {
  const home = mkdtempSync(`${os.tmpdir()}${process.platform === 'win32' ? '\\' : '/'}sales-read-`);
  t.after(() => rmSync(home, { recursive: true, force: true }));
  let fetched = false, message = '';
  const code = await runSalesDealsRead(['--tables'], { env: {}, home, fetchImpl: async () => { fetched = true; }, stdout: () => {}, stderr: value => { message = value; } });
  assert.equal(code, 2);
  assert.equal(fetched, false);
  assert.match(message, /ありません/);
});
