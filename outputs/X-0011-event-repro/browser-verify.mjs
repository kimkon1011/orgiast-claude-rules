import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const executablePath = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const pageUrl = new URL('./index.html', import.meta.url).href;
const browser = await chromium.launch({ executablePath, headless: true });

try {
  const desktop = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  await desktop.goto(pageUrl, { waitUntil: 'load' });
  assert.equal(await desktop.title(), '展示会ブース制作セミナー 2026 | Orgiast');
  assert.equal((await desktop.locator('h1').textContent()).replace(/\s+/g, ''), '伝わるブースは、設計から変わる。');
  await desktop.screenshot({ path: new URL('desktop-preview.png', import.meta.url).pathname.slice(1), fullPage: true });

  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
  await mobile.goto(pageUrl, { waitUntil: 'load' });
  const menu = mobile.locator('.menu-button');
  await menu.click();
  assert.equal(await menu.getAttribute('aria-expanded'), 'true');
  assert.equal(await mobile.locator('.navigation').evaluate((el) => getComputedStyle(el).display), 'flex');
  await mobile.locator('.navigation a[href="#program"]').click();
  assert.equal(await menu.getAttribute('aria-expanded'), 'false');

  await mobile.locator('button[type="submit"]').click();
  assert.match(await mobile.locator('#form-status').textContent(), /誤り/);
  await mobile.locator('#company').fill('株式会社テスト');
  await mobile.locator('#name').fill('展示 太郎');
  await mobile.locator('#email').fill('invalid');
  await mobile.locator('button[type="submit"]').click();
  assert.match(await mobile.locator('#email-error').textContent(), /形式/);
  await mobile.locator('#email').fill('taro@example.jp');
  await mobile.locator('button[type="submit"]').click();
  assert.match(await mobile.locator('#form-status').textContent(), /外部への送信は行われません/);
  assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
  await mobile.screenshot({ path: new URL('mobile-preview.png', import.meta.url).pathname.slice(1), fullPage: true });
  console.log(JSON.stringify({ desktop: '1440x1000', mobile: '390x844', menu: 'pass', form: ['empty: pass', 'invalid email: pass', 'valid: pass'], horizontalOverflow: false }));
} finally {
  await browser.close();
}
