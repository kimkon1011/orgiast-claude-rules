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
    return await read(page);
  } finally { await browser.close(); }
}
