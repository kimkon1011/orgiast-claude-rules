/**
 * meet-cue-browser.mjs
 * Playwright 操作（Meet 参加・字幕取得・MutationObserver 監視・セレクタ修理用 DOM 保存）
 * playwright-core は動的 import
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolveBrowserExecutable, runHumanLogin } from './human-login.mjs';
import { findChromium } from '../gpage-fetch.mjs';
import { MEET_SELECTORS } from './meet-cue-core.mjs';

function getBrowsersBaseDir() {
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) return process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (process.platform === 'win32') {
    return process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'ms-playwright') : null;
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright');
  }
  return path.join(os.homedir(), '.cache', 'ms-playwright');
}

async function loadPlaywrightCore() {
  try {
    const mod = await import('playwright-core');
    const chromium = mod.chromium || mod.default?.chromium;
    if (chromium) return chromium;
  } catch { /* try fallbacks */ }

  const fallbackDirs = [
    path.join(os.homedir(), '.claude', 'nightly-repo', 'node_modules', 'playwright-core'),
    path.join(os.homedir(), '.claude', 'tools', 'node_modules', 'playwright-core'),
  ];

  for (const fb of fallbackDirs) {
    if (!fs.existsSync(fb)) continue;
    try {
      const fileUrl = pathToFileURL(path.join(fb, 'index.js')).href;
      const mod = await import(fileUrl);
      const chromium = mod.chromium || mod.default?.chromium;
      if (chromium) return chromium;
    } catch { /* try require */ }

    try {
      const req = createRequire(import.meta.url);
      const mod = req(fb);
      const chromium = mod.chromium || mod.default?.chromium;
      if (chromium) return chromium;
    } catch { /* next */ }
  }

  return null;
}

export async function checkPlaywrightAvailable() {
  const baseDir = getBrowsersBaseDir();
  const executablePath = resolveBrowserExecutable({ findChromium: () => findChromium(baseDir) });

  let chromium = null;
  let error = null;
  try {
    chromium = await loadPlaywrightCore();
  } catch (e) {
    error = e.message;
  }

  return {
    available: Boolean(chromium),
    executablePath: executablePath || null,
    chromium,
    ...(error ? { error } : {}),
  };
}

export async function checkProfileLoggedIn(profileDir) {
  // Check cookies or profile existence
  if (!fs.existsSync(profileDir)) return false;
  const cookiePath = path.join(profileDir, 'Default', 'Cookies');
  const networkCookiePath = path.join(profileDir, 'Default', 'Network', 'Cookies');
  return fs.existsSync(cookiePath) || fs.existsSync(networkCookiePath);
}

export async function startMeetBot({
  url,
  mode = 'profile', // 'profile' | 'guest'
  maxMinutes = 120,
  debugDom = false,
  sessionDir = '',
  botDisplayName = 'オージャストAI',
  onCaption = () => {},
  log = console.error,
} = {}) {
  const { available, executablePath, chromium } = await checkPlaywrightAvailable();
  if (!available || !executablePath) {
    throw new Error('playwright-core または Chrome 実行ファイルが見つかりません。doctor を確認してください。');
  }

  const profileDir = mode === 'guest'
    ? fs.mkdtempSync(path.join(os.tmpdir(), 'meet-guest-profile-'))
    : path.join(os.homedir(), '.claude', 'browser-profiles', 'meet-bot-seisaku');

  fs.mkdirSync(profileDir, { recursive: true });

  log(`[meet-cue-browser] プロファイル: ${profileDir} (mode: ${mode})`);

  const context = await chromium.launchPersistentContext(profileDir, {
    executablePath,
    headless: false,
    viewport: { width: 1280, height: 720 },
    args: [
      '--use-fake-ui-for-media-stream',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-notifications',
      '--disable-infobars',
    ],
  });

  const page = context.pages()[0] || await context.newPage();

  // Expose caption callback to browser page
  await page.exposeFunction('__meetCueOnCaption', (speaker, text) => {
    onCaption({ speaker, text, timestamp: Date.now() });
  });

  log(`[meet-cue-browser] Meet URL へ移動中: ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(3000);

  // Turn off mic & camera via keyboard shortcuts
  try {
    await page.keyboard.press('Control+d');
    await page.waitForTimeout(500);
    await page.keyboard.press('Control+e');
    await page.waitForTimeout(1000);
  } catch { /* ignore */ }

  // Check if mode is profile but page redirected to login
  if (mode === 'profile' && page.url().includes('accounts.google.com')) {
    log('[meet-cue-browser] 警告: 未ログイン状態を検知しました。ゲストモードで継続します。');
  }

  // Handle guest mode name entry
  if (mode === 'guest' || page.url().includes('accounts.google.com')) {
    for (const sel of MEET_SELECTORS.guestNameInput) {
      try {
        const input = page.locator(sel).first();
        if (await input.isVisible({ timeout: 1000 })) {
          await input.fill(botDisplayName);
          log(`[meet-cue-browser] ゲスト名を「${botDisplayName}」に設定`);
          break;
        }
      } catch { /* try next */ }
    }
  }

  // Join meeting by clicking join / request button
  let joined = false;
  const joinDeadline = Date.now() + 600000; // 10 minutes wait for approval

  while (Date.now() < joinDeadline && !joined) {
    for (const sel of MEET_SELECTORS.joinButtons) {
      try {
        const btn = page.locator(sel).first();
        if (await btn.isVisible({ timeout: 1000 })) {
          await btn.click();
          log(`[meet-cue-browser] 参加ボタンをクリック: ${sel}`);
          joined = true;
          break;
        }
      } catch { /* try next */ }
    }
    if (joined) break;
    await page.waitForTimeout(2000);
  }

  await page.waitForTimeout(3000);

  // Turn on captions
  log('[meet-cue-browser] 字幕をオンに設定中...');
  let captionOn = false;
  for (const sel of MEET_SELECTORS.captionToggleButtons) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 1000 })) {
        await btn.click();
        log(`[meet-cue-browser] 字幕ボタンをクリック: ${sel}`);
        captionOn = true;
        break;
      }
    } catch { /* try next */ }
  }

  if (!captionOn) {
    try {
      await page.keyboard.press('c');
      log('[meet-cue-browser] ショートカット "c" キーで字幕トグルを試行');
    } catch { /* ignore */ }
  }

  // Inject MutationObserver script for subtitle extraction
  await page.evaluate(() => {
    const observer = new MutationObserver((mutations) => {
      // Find all caption elements
      const captionNodes = document.querySelectorAll('.a7238b, [aria-label*="字幕"], [data-caption-tracks], div[role="region"][aria-label*="caption"], .aG928e, .T4L22b, .yg3S7d');
      if (captionNodes.length > 0) {
        captionNodes.forEach(node => {
          const text = node.textContent || '';
          if (text.trim()) {
            // Attempt speaker identification
            const speakerNode = node.querySelector('.zs5S2e, .bh44bd, [data-sender-name]');
            const speaker = speakerNode ? speakerNode.textContent.trim() : '参加者';
            window.__meetCueOnCaption(speaker, text.trim());
          }
        });
      } else {
        // Fallback: search for floating caption overlay text
        const spans = document.querySelectorAll('div[style*="position"] span, div[class*="caption"]');
        spans.forEach(span => {
          const txt = span.textContent || '';
          if (txt.length > 5 && txt.length < 500) {
            window.__meetCueOnCaption('話者', txt.trim());
          }
        });
      }
    });

    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  });

  // Debug DOM Timer
  let debugInterval = null;
  if (debugDom && sessionDir) {
    const domDir = path.join(sessionDir, 'dom');
    fs.mkdirSync(domDir, { recursive: true });

    debugInterval = setInterval(async () => {
      try {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const html = await page.content();
        fs.writeFileSync(path.join(domDir, `dom-${ts}.html`), html, 'utf8');
        await page.screenshot({ path: path.join(domDir, `shot-${ts}.png`), fullPage: false });
        log(`[meet-cue-browser] --debug-dom: DOM & スキャンショット保存 (${ts})`);
      } catch (e) {
        log(`[meet-cue-browser] --debug-dom エラー: ${e.message}`);
      }
    }, 30000);
  }

  // Monitor loop for exit conditions
  let isStopped = false;
  const startTime = Date.now();
  const maxMs = maxMinutes * 60 * 1000;

  const monitorPromise = (async () => {
    while (!isStopped) {
      if (Date.now() - startTime >= maxMs) {
        log('[meet-cue-browser] maxMinutes 到達により終了します。');
        break;
      }

      // Check if left call
      try {
        const bodyText = await page.evaluate(() => document.body.innerText || '');
        if (MEET_SELECTORS.leftCallTexts.some(t => bodyText.includes(t))) {
          log('[meet-cue-browser] 通話から退出した画面を検知しました。');
          break;
        }
      } catch {
        // Page closed
        log('[meet-cue-browser] ページ閉鎖を検知しました。');
        break;
      }

      await new Promise(r => setTimeout(r, 5000));
    }
  })();

  const stop = async () => {
    isStopped = true;
    if (debugInterval) clearInterval(debugInterval);
    try {
      await context.close();
    } catch { /* ignore */ }
    if (mode === 'guest') {
      try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    log('[meet-cue-browser] Bot セッション終了');
  };

  return {
    context,
    page,
    stop,
    monitorPromise,
  };
}
