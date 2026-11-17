#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { isEntry } from './is-entry.mjs';

export const PROFILE_DIR = String.raw`C:\Users\user\.claude\browser-profiles\sellercentral-tetsuko`;
const CHROMIUM_EXE = String.raw`C:\Users\user\AppData\Local\ms-playwright\chromium-1255\chrome-win64\chrome.exe`;

// Only URL and input presence are inspected; input values are never read.
export function isSignInPage({ url, hasPasswordInput }) {
  return /signin/i.test(url) || Boolean(hasPasswordInput);
}

export function isInventoryPage(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && parsed.hostname === 'sellercentral.amazon.co.jp'
      && /\/(?:myinventory|inventory)(?:\/|$)/i.test(parsed.pathname)
      && !isSignInPage({ url, hasPasswordInput: false });
  } catch {
    return false;
  }
}

async function disablePasswordSaving() {
  const directory = path.win32.join(PROFILE_DIR, 'Default');
  const file = path.win32.join(directory, 'Preferences');
  await fs.mkdir(directory, { recursive: true });
  let preferences = {};
  try {
    preferences = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  preferences.credentials_enable_service = false;
  preferences.profile = { ...preferences.profile, password_manager_enabled: false };
  await fs.writeFile(file, JSON.stringify(preferences));
}

function waitForLogin(context) {
  return new Promise((resolve, reject) => {
    let inspecting = false;
    const cleanup = () => {
      clearInterval(timer);
      process.stdin.off('data', onInput);
      process.stdin.pause();
      context.off('close', onClose);
    };
    const finish = () => { cleanup(); resolve(); };
    const onInput = chunk => { if (chunk.includes(10) || chunk.includes(13)) finish(); };
    const onClose = () => { cleanup(); reject(new Error('Browser closed')); };
    const timer = setInterval(async () => {
      if (inspecting) return;
      inspecting = true;
      try {
        for (const page of context.pages()) {
          if (isInventoryPage(page.url()) && await page.locator('input[type="password"]').count() === 0) {
            finish();
            break;
          }
        }
      } catch {
        // Navigation can replace a document during inspection; retry next tick.
      } finally {
        inspecting = false;
      }
    }, 1000);
    context.once('close', onClose);
    process.stdin.on('data', onInput);
    process.stdin.resume();
  });
}

export async function main(args = process.argv.slice(2)) {
  if (args.length !== 1 || !['login', 'check'].includes(args[0])) {
    console.error('Usage: node tools/sellercentral-session.mjs login|check');
    return 2;
  }
  if (process.platform !== 'win32') {
    console.error('Windows の Node.js で実行してください。');
    return 2;
  }
  const command = args[0];
  let context;
  // A separate lock prevents this tool from rewriting preferences concurrently.
  let lock;
  const lockFile = path.win32.join(PROFILE_DIR, '.session-tool.lock');
  try {
    const { chromium } = await import('playwright-core');
    await fs.mkdir(PROFILE_DIR, { recursive: true });
    lock = await fs.open(lockFile, 'wx');
    await disablePasswordSaving();
    context = await chromium.launchPersistentContext(PROFILE_DIR, {
      executablePath: CHROMIUM_EXE,
      headless: command === 'check',
      acceptDownloads: false,
      args: ['--disable-save-password-bubble'],
    });
    const page = context.pages()[0] ?? await context.newPage();
    const response = await page.goto(command === 'login'
      ? 'https://sellercentral.amazon.co.jp/'
      : 'https://sellercentral.amazon.co.jp/inventory', {
      waitUntil: 'load', timeout: 60000,
    });
    const signedOut = isSignInPage({
      url: page.url(),
      hasPasswordInput: await page.locator('input[type="password"]').count() > 0,
    });
    // Transport/server failures are errors, not evidence of a valid session.
    if (!response || (!response.ok() && !signedOut)) throw new Error('Navigation failed');
    if (command === 'login') {
      console.log('ブラウザ画面でログインしてください。完了後、この画面で Enter を押してください（在庫管理への到達でも終了します）。');
      await waitForLogin(context);
      await context.close();
      context = undefined;
      console.log('プロファイルを保存しました。');
      return 0;
    }
    const loggedIn = !signedOut;
    await context.close();
    context = undefined;
    await fs.writeFile(path.win32.join(PROFILE_DIR, 'last-check.json'),
      JSON.stringify({ ts: new Date().toISOString(), loggedIn }) + '\n');
    console.log(loggedIn ? 'ログイン中' : 'ログイン切れ');
    return loggedIn ? 0 : 1;
  } catch {
    // Never print browser errors, URLs, page contents, or authentication data.
    console.error('実行失敗: Playwright、Chromium、通信状態とプロファイルの使用状況を確認してください。');
    return 2;
  } finally {
    if (context) await context.close().catch(() => {});
    if (lock) {
      await lock.close();
      await fs.unlink(lockFile);
    }
  }
}

if (isEntry(import.meta.url)) {
  main().then(code => { process.exitCode = code; }).catch(() => {
    console.error('プロファイルの終了処理に失敗しました。');
    process.exitCode = 2;
  });
}
