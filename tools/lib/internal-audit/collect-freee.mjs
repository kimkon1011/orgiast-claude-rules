import { createHmac, randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { DAY, dateOnly, getJson, maskNumbers, auditError } from './common.mjs';
export const COMPANY_ID = 11975741;
// The shared getAccessToken refreshes OAuth and UPDATEs the database. Audit must not do either.
export async function getReadOnlyToken(databaseUrl) {
  if (!databaseUrl) throw auditError('freee 未接続: PURCHASING_APP_DATABASE_URL がありません');
  const sql = postgres(databaseUrl, { max: 1, ssl: 'require', connect_timeout: 15, idle_timeout: 5,
    connection: { statement_timeout: 20000, default_transaction_read_only: 'on' }, onnotice: () => {} });
  try {
    const [row] = await sql`select access_token, access_expires_at from freee_tokens where id='default' limit 1`;
    if (!row?.access_token || !Number.isFinite(Date.parse(row.access_expires_at)) || Date.parse(row.access_expires_at) <= Date.now() + 120000 || !row.access_expires_at)
      throw auditError('freee 未接続: 保存済みトークンが失効。購買部アプリで更新後に再実行（監査から更新しません）');
    return row.access_token;
  } finally { await sql.end({ timeout: 5 }); }
}
export function normalizeFreee(raw, { now = new Date(), windowDays = 180, bankSalt = randomBytes(32) } = {}) {
  const start = dateOnly(+now - windowDays * DAY), end = dateOnly(now);
  const unique = rows => [...new Map(rows.map(row => [String(row.id), row])).values()];
  const partners = unique(raw.partners).map(p => {
    const b = p.partner_bank_account_attributes || {};
    const account = String(b.account_number ?? '').normalize('NFKC').replace(/\s/g, '');
    return { id: String(p.id), name: maskNumbers(p.name), name_kana: maskNumbers(p.name_kana), email: p.email || '', created_at: p.created_at || null,
      bank: { bank_code: b.bank_code || '', branch_code: b.branch_code || '', account_type: b.account_type || '',
        account_number: account ? `****${account.slice(-4)}` : '', account_name: maskNumbers(b.long_account_name || b.account_name),
        key: b.bank_code && b.branch_code && account ? createHmac('sha256', bankSalt).update(JSON.stringify([String(b.bank_code), String(b.branch_code), account])).digest('hex') : '' } };
  });
  const payments = [], deals = [];
  for (const d of unique(raw.deals).filter(d => d.type === 'expense')) {
    deals.push({ id: String(d.id), partner_id: String(d.partner_id ?? ''), issue_date: d.issue_date, amount: Number(d.amount),
      account_item_ids: [...new Set((d.details || []).map(x => String(x.account_item_id)))], payment_count: d.payments?.length || 0 });
    for (const p of unique(d.payments || [])) if (p.date && Number(p.amount) > 0) payments.push({ id: String(p.id), deal_id: String(d.id), partner_id: String(p.partner_id || d.partner_id || ''), date: p.date, amount: Number(p.amount) });
  }
  return { version: 1, fetchedAt: now.toISOString(), window: { start, end, days: windowDays }, partners, deals, payments,
    wallet_txns: raw.wallet_txns.filter(w => w.entry_side === 'expense').map(w => ({ id: String(w.id), date: w.date, amount: Number(w.amount), status: Number(w.status), entry_side: w.entry_side, description: maskNumbers(w.description), walletable_id: String(w.walletable_id), walletable_type: w.walletable_type })),
    walletables: raw.walletables.map(w => ({ id: String(w.id), type: w.type, name: maskNumbers(w.name) })),
    account_items: raw.account_items.map(a => ({ id: String(a.id), name: a.name })),
    coverage: { paymentBasis: 'deals.payments（経費計上額ではなく実決済）', historyStart: raw.historyStart, historyComplete: true,
      limitations: ['created_at がない取引先は初回実行の R01 判定不能。', 'issue_date の取得開始より古い経費取引に対する期間内決済は取得対象外。'] } };
}
export async function collectFreee({ token, windowDays = 180, now = new Date(), fetchImpl = fetch, signal, sleep } = {}) {
  const jst = new Date(+now + 9 * 3600000);
  const history = new Date(Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth() - 6, 1));
  const start = dateOnly(Math.min(+history, +now - windowDays * DAY));
  const raw = { historyStart: start };
  for (const kind of ['partners', 'deals', 'wallet_txns', 'walletables', 'account_items']) {
    raw[kind] = [];
    for (let offset = 0; ; offset += 100) {
      const url = new URL(`https://api.freee.co.jp/api/1/${kind}`);
      const params = { company_id: COMPANY_ID, limit: 100, offset };
      if (kind === 'deals') Object.assign(params, { type: 'expense', start_issue_date: start, end_issue_date: dateOnly(now) });
      if (kind === 'wallet_txns') Object.assign(params, { entry_side: 'expense', start_date: dateOnly(+now - windowDays * DAY), end_date: dateOnly(now) });
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
      const page = await getJson(url, { headers: { Authorization: `Bearer ${token}` }, fetchImpl, signal, sleep });
      if (!Array.isArray(page[kind])) throw auditError(`freee ${kind}: 配列がありません`);
      for (const row of page[kind]) raw[kind].push(row);
      // These two master endpoints return their entire collection (no pagination contract).
      if (['walletables', 'account_items'].includes(kind) || page[kind].length < 100) break;
      if (offset >= 99900) throw auditError(`freee ${kind}: ページ上限に到達（不完全）`);
    }
  }
  return normalizeFreee(raw, { now, windowDays });
}
