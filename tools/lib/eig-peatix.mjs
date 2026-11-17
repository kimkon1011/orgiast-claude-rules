import { chromium } from 'playwright-core';
import { searchGmail } from '../gmail-search.mjs';

export const EVENT_URL = 'https://peatix.com/event/5269635/manage/';

// Ported from peatix-cafe212-final-20261117b.mjs. No scratchpad dependency,
// event edits, attendee messaging, or persistent browser credentials.
export async function withPeatixPage(read) {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(30_000);
    await page.goto('https://peatix.com/signin', { waitUntil: 'networkidle' });
    await page.fill('input[name="username"]', 'seisaku-team@orgiast.jp');
    await page.click('#next-button');
    await page.waitForSelector('#send-passcode-button');
    const since = Date.now();
    await page.click('#send-passcode-button');
    let code;
    for (let n = 0; n < 40 && !code; n++) {
      const result = await searchGmail({ user: 'seisaku-team@orgiast.jp', query: `from:noreply@peatix.com subject:認証コード after:${Math.floor(since / 1000)}`, max: 10 });
      code = result.messages.filter(m => Number(m.internalDate) >= since - 1000)
        .sort((a,b) => Number(b.internalDate)-Number(a.internalDate))
        .map(m => m.subject.match(/^(\d{6})\s*-/)?.[1]).find(Boolean);
      if (!code) await new Promise(resolve => setTimeout(resolve, 3000));
    }
    if (!code) throw new Error('Peatix authentication code timeout');
    for (let i = 0; i < 6; i++) await page.fill(`#otp-field${i}`, code[i]);
    await page.click('#verify-button');
    await page.waitForTimeout(4000);
    await page.goto(EVENT_URL, { waitUntil: 'networkidle' });
    await page.route('**/*', route => {
      const req = route.request();
      return /peatix\.com$/.test(new URL(req.url()).hostname) && !['GET', 'HEAD'].includes(req.method()) ? route.abort() : route.continue();
    });
    return await read(page);
  } finally { await browser.close(); }
}

export function parseTickets(rows, body) {
  const tickets = rows.filter(row => row.length >= 4 && /^\s*[\d,]+\s*\//.test(row[0])).map(row => {
    const match = row[0].match(/^\s*([\d,]+)\s*\/\s*([\d,]+)\s*$/);
    if (!match || !row[1].trim()) throw new Error('Peatix ticket table changed');
    return { name: row[1].trim(), count: Number(match[1].replaceAll(',', '')), capacity: Number(match[2].replaceAll(',', '')) };
  });
  const total = body.match(/([\d,]+)\s*\/\s*([\d,]+)\s*申し込み数/);
  if (!tickets.length || !total) throw new Error('Peatix sales data missing (not zero)');
  const registrations = tickets.reduce((sum,t) => sum + t.count, 0);
  const capacity = tickets.reduce((sum,t) => sum + t.capacity, 0);
  if (registrations !== Number(total[1].replaceAll(',', '')) || capacity !== Number(total[2].replaceAll(',', ''))) throw new Error('Peatix totals mismatch');
  return { tickets, registrations, capacity, presenters: tickets.filter(t => /登壇/.test(t.name)).reduce((sum,t) => sum+t.count,0) };
}
export async function collectPeatix() {
  return withPeatixPage(async page => {
    const publicBody = await page.locator('body').innerText();
    const dashboard = await page.locator('a').evaluateAll(es => es.map(e => e.href).find(h => h === 'https://peatix.com/event/5269635/dashboard'));
    if (!dashboard) throw new Error('Peatix authenticated dashboard missing');
    await page.goto(dashboard, { waitUntil: 'networkidle' });
    await page.waitForSelector('table.sales-data');
    const rows = await page.locator('table.sales-data tr').evaluateAll(es => es.map(e => [...e.querySelectorAll('td')].map(c => c.innerText)));
    return { ...parseTickets(rows, await page.locator('body').innerText()), cafe212: /課題の概要[\s\S]{0,50}Cafe\s*212/.test(publicBody) ? 1 : null, source: dashboard };
  });
}
