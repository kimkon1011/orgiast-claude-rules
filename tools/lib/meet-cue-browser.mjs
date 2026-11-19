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

/**
 * Checks profile directory structure and returns detailed diagnostics.
 * Returns an object with profileDir, exists, subDirs, cookieFiles, and summary.
 */
export async function checkProfileLoggedIn(profileDir) {
  const result = {
    profileDir,
    exists: false,
    subDirs: [],
    cookieFiles: [],
    summary: 'not_found',
  };

  if (!profileDir || typeof profileDir !== 'string' || !fs.existsSync(profileDir)) {
    return result;
  }

  result.exists = true;

  // List subdirectories
  try {
    const entries = fs.readdirSync(profileDir, { withFileTypes: true });
    result.subDirs = entries.filter(e => e.isDirectory()).map(e => e.name);
  } catch { /* ignore */ }

  // Find cookie files
  const cookiePaths = [
    path.join(profileDir, 'Default', 'Cookies'),
    path.join(profileDir, 'Default', 'Network', 'Cookies'),
    path.join(profileDir, 'Cookies'),
    path.join(profileDir, 'Network', 'Cookies'),
  ];

  // Also check subdirectories for cookie files
  for (const sub of result.subDirs) {
    cookiePaths.push(path.join(profileDir, sub, 'Cookies'));
    cookiePaths.push(path.join(profileDir, sub, 'Network', 'Cookies'));
  }

  for (const cp of cookiePaths) {
    if (fs.existsSync(cp)) {
      try {
        const stat = fs.statSync(cp);
        result.cookieFiles.push({
          path: cp,
          sizeBytes: stat.size,
          mtime: stat.mtime.toISOString(),
        });
      } catch { /* ignore */ }
    }
  }

  if (result.cookieFiles.length === 0) {
    result.summary = 'no_cookie_files';
  } else {
    result.summary = 'cookie_files_present';
  }

  return result;
}

/**
 * Google ログインに必要な cookie 名の一覧。
 */
export const REQUIRED_GOOGLE_COOKIES = ['SID', 'HSID', 'SSID', '__Secure-1PSID', '__Secure-3PSID'];

/**
 * Checks if the browser profile is actually signed into Google by inspecting cookies.
 * Does NOT open a browser — safe to call anytime.
 * Returns an object with signedIn (boolean), foundCookies (string[]), missingCookies (string[]),
 * and cookieFiles (string[]).
 */
export async function isProfileSignedIn(profileDir, options = {}) {
  const result = {
    signedIn: false,
    foundCookies: [],
    missingCookies: [...REQUIRED_GOOGLE_COOKIES],
    cookieFiles: [],
  };

  if (!profileDir || typeof profileDir !== 'string' || !fs.existsSync(profileDir)) {
    return result;
  }

  // If a live browser context is provided, check via cookies API
  if (options.context) {
    try {
      const cookies = await options.context.cookies();
      const googleCookies = cookies.filter(c => (c.domain || '').includes('google.com'));
      for (const c of googleCookies) {
        if (REQUIRED_GOOGLE_COOKIES.includes(c.name) && !result.foundCookies.includes(c.name)) {
          result.foundCookies.push(c.name);
        }
      }
    } catch { /* ignore */ }
  }

  // Collect all cookie file paths
  const cookiesPaths = [
    path.join(profileDir, 'Default', 'Cookies'),
    path.join(profileDir, 'Default', 'Network', 'Cookies'),
    path.join(profileDir, 'Cookies'),
    path.join(profileDir, 'Network', 'Cookies'),
  ];

  try {
    const entries = fs.readdirSync(profileDir, { withFileTypes: true });
    for (const ent of entries) {
      if (ent.isDirectory()) {
        cookiesPaths.push(path.join(profileDir, ent.name, 'Cookies'));
        cookiesPaths.push(path.join(profileDir, ent.name, 'Network', 'Cookies'));
      }
    }
  } catch { /* ignore */ }

  // Scan cookie files for Google session cookies
  for (const cp of cookiesPaths) {
    if (!fs.existsSync(cp)) continue;
    result.cookieFiles.push(cp);
    try {
      const buf = fs.readFileSync(cp);
      const str = buf.toString('utf8');
      for (const name of REQUIRED_GOOGLE_COOKIES) {
        if (str.includes(name) && !result.foundCookies.includes(name)) {
          result.foundCookies.push(name);
        }
      }
    } catch {
      try {
        const buf = fs.readFileSync(cp);
        for (const name of REQUIRED_GOOGLE_COOKIES) {
          if (buf.includes(Buffer.from(name)) && !result.foundCookies.includes(name)) {
            result.foundCookies.push(name);
          }
        }
      } catch { /* ignore */ }
    }
  }

  result.missingCookies = REQUIRED_GOOGLE_COOKIES.filter(n => !result.foundCookies.includes(n));
  result.signedIn = result.foundCookies.length >= 2; // At least SID + one more
  return result;
}

async function checkUiReached(page) {
  const selectors = [
    ...MEET_SELECTORS.joinButtons,
    ...MEET_SELECTORS.inCallButtons,
    ...MEET_SELECTORS.guestNameInput,
    ...MEET_SELECTORS.captionToggleButtons,
    'button[aria-label*="マイク"]',
    'button[aria-label*="mic"]',
    'button[aria-label*="カメラ"]',
    'button[aria-label*="camera"]',
    'button[aria-label*="通話"]',
    '[data-unresolved-meeting-id]',
  ];

  for (const sel of selectors) {
    try {
      const loc = page.locator(sel).first();
      if (await loc.isVisible({ timeout: 300 })) {
        return true;
      }
    } catch { /* ignore */ }
  }
  return false;
}

export function copyMeetBotProfile(source, destination) {
  if (!fs.lstatSync(source).isDirectory()) {
    throw new Error(`ブラウザプロファイルのディレクトリが見つかりません: ${source}`);
  }
  fs.cpSync(source, destination, {
    recursive: true,
    filter: (entry) => {
      const name = path.basename(entry).toLowerCase();
      return !name.startsWith('singleton') && name !== 'lockfile' && !fs.lstatSync(entry).isSymbolicLink();
    },
  });
}

export async function startMeetBot({
  url,
  mode = 'profile', // 'profile' | 'guest'
  maxMinutes = 120,
  debugDom = false,
  sessionDir = '',
  botDisplayName = 'オージャストAI',
  onCaption = () => {},
  onJoinState = () => {},
  getCaptionLineCount = () => 0,
  log = console.error,
  uiTimeoutMs = 90000,
} = {}) {
  const { available, executablePath, chromium } = await checkPlaywrightAvailable();
  if (!available || !executablePath) {
    throw new Error('playwright-core または Chrome 実行ファイルが見つかりません。doctor を確認してください。');
  }

  const profileDir = sessionDir
    ? path.join(sessionDir, 'profile')
    : fs.mkdtempSync(path.join(os.tmpdir(), 'meet-bot-profile-'));
  let ownsProfile = !sessionDir;
  let context;
  const close = async () => {
    try {
      await context?.close();
    } catch (err) {
      log(`[meet-cue-browser] ブラウザ終了失敗: ${err.message}`);
    }
    if (ownsProfile) {
      try {
        fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 3 });
      } catch (err) {
        log(`[meet-cue-browser] プロファイル削除失敗: ${err.message}`);
      }
    }
  };

  try {
    try {
      if (sessionDir) {
        fs.mkdirSync(sessionDir, { recursive: true });
        fs.mkdirSync(profileDir, { mode: 0o700 });
        ownsProfile = true;
      }
      if (mode !== 'guest') {
        const home = process.env.ORGIAST_HOME || os.homedir();
        copyMeetBotProfile(path.join(home, '.claude', 'browser-profiles', 'meet-bot-seisaku'), profileDir);
      }
    } catch (err) {
      err.reason = 'profile_copy_failed';
      throw err;
    }

    log(`[meet-cue-browser] プロファイル: ${profileDir} (mode: ${mode})`);
    context = await chromium.launchPersistentContext(profileDir, {
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

    return await runMeetBot(context, close, {
      url, mode, maxMinutes, debugDom, sessionDir, botDisplayName,
      onCaption, onJoinState, getCaptionLineCount, log, uiTimeoutMs,
    });
  } catch (err) {
    await close();
    throw err;
  }
}

async function runMeetBot(context, close, {
  url, mode, maxMinutes, debugDom, sessionDir, botDisplayName,
  onCaption, onJoinState, getCaptionLineCount, log, uiTimeoutMs,
}) {
  const page = context.pages()[0] || await context.newPage();

  // Expose caption callback to browser page
  await page.exposeFunction('__meetCueOnCaption', (speaker, text) => {
    onCaption({ speaker, text, timestamp: Date.now() });
  });

  log(`[meet-cue-browser] Meet URL へ移動中: ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(3000);

  // Check URL redirect or wait up to uiTimeoutMs (default 90s) for join/meeting UI
  const uiDeadline = Date.now() + uiTimeoutMs;
  let failReason = null;
  let uiReached = false;

  while (Date.now() < uiDeadline) {
    const currentUrl = page.url();
    if (currentUrl.includes('accounts.google.com')) {
      failReason = 'signin_required';
      break;
    }
    if (!currentUrl.includes('meet.google.com')) {
      failReason = 'redirected_to_landing';
      break;
    }

    if (await checkUiReached(page)) {
      uiReached = true;
      break;
    }

    await page.waitForTimeout(1000);
  }

  if (!uiReached && !failReason) {
    failReason = 'join_ui_not_found';
  }

  if (failReason) {
    log(`[meet-cue-browser] Meet 参加失敗を検知しました (理由: ${failReason}, URL: ${page.url()})`);
    if (sessionDir) {
      try {
        fs.mkdirSync(sessionDir, { recursive: true });
        await page.screenshot({ path: path.join(sessionDir, 'join-failed.png'), fullPage: false });
        log(`[meet-cue-browser] 失敗スクリーンショット保存: ${path.join(sessionDir, 'join-failed.png')}`);
      } catch (e) {
        log(`[meet-cue-browser] スクリーンショット保存失敗: ${e.message}`);
      }
    }
    const err = new Error(`Meet 参加失敗: ${failReason}`);
    err.reason = failReason;
    throw err;
  }

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

  // The request button only enters the lobby. Wait for a visible in-call control.
  let requested = false;
  let joinedAt;
  const inCallSelector = MEET_SELECTORS.inCallButtons.map(sel => sel + ':visible').join(', ');
  const joinDeadline = Date.now() + 600000;
  while (Date.now() < joinDeadline) {
    if (await page.locator(inCallSelector).first().isVisible()) {
      joinedAt = Date.now();
      onJoinState('joined');
      break;
    }
    if (!requested) {
      for (const sel of MEET_SELECTORS.joinButtons) {
        try {
          const btn = page.locator(sel).first();
          if (!(await btn.isVisible())) continue;
          await btn.click({ timeout: 2000 });
        } catch { continue; }
        log(`[meet-cue-browser] 参加ボタンをクリック: ${sel}`);
        requested = true;
        onJoinState('waiting_in_lobby');
        break;
      }
    }
    await page.waitForTimeout(2000);
  }
  if (!joinedAt) {
    const reason = requested ? 'lobby_timeout' : 'join_button_not_found';
    if (sessionDir) {
      try {
        await page.screenshot({ path: path.join(sessionDir, 'join-failed.png'), timeout: 5000 });
      } catch (err) {
        log(`[meet-cue-browser] スクリーンショット保存失敗: ${err.message}`);
      }
    }
    throw Object.assign(new Error(`Meet 参加失敗: ${reason}`), { reason });
  }

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
  await page.evaluate((captionSelector) => {
    const observer = new MutationObserver((mutations) => {
      // Find all caption elements
      const captionNodes = document.querySelectorAll(captionSelector);
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
  }, MEET_SELECTORS.captionContainers.join(', '));

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
  const pendingShots = [1, 3, 10];
  let captionDebugPending = true;
  let isStopped = false;
  const startTime = Date.now();
  const maxMs = maxMinutes * 60 * 1000;

  const monitorPromise = (async () => {
    while (!isStopped) {
      if (Date.now() - startTime >= maxMs) {
        log('[meet-cue-browser] maxMinutes 到達により終了します。');
        break;
      }

      if (sessionDir) {
        const elapsed = Date.now() - joinedAt;
        try {
          if (captionDebugPending && elapsed >= 180000) {
            captionDebugPending = false;
            if (getCaptionLineCount() === 0) {
              await saveCaptionDebug(page, sessionDir);
            }
          }
        } catch (err) {
          log(`[meet-cue-browser] 字幕診断保存失敗: ${err.message}`);
        }
        while (!isStopped && pendingShots.length && elapsed >= pendingShots[0] * 60000) {
          const minutes = String(pendingShots.shift()).padStart(2, '0');
          try {
            await page.screenshot({ path: path.join(sessionDir, `shot-${minutes}m.png`), timeout: 5000 });
          } catch (err) {
            log(`[meet-cue-browser] スクリーンショット保存失敗: ${err.message}`);
          }
        }
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
    await close();
    log('[meet-cue-browser] Bot セッション終了');
  };

  return {
    context,
    page,
    stop,
    monitorPromise,
  };
}

async function saveCaptionDebug(page, sessionDir) {
  const captured = await page.evaluate(() => ({
    ariaLabels: [...new Set(Array.from(document.querySelectorAll('[aria-label]'),
      element => element.getAttribute('aria-label')))],
    bodyText: document.body.innerText,
  }));
  const selectorHits = {};
  for (const [group, candidates] of Object.entries(MEET_SELECTORS)) {
    selectorHits[group] = Object.fromEntries(await Promise.all(candidates.map(async candidate => [
      candidate,
      group === 'leftCallTexts'
        ? captured.bodyText.split(candidate).length - 1
        : await page.locator(candidate).count(),
    ])));
  }
  fs.writeFileSync(path.join(sessionDir, 'caption-debug.json'), JSON.stringify({
    selectorHits,
    ariaLabels: captured.ariaLabels,
  }, null, 2), 'utf8');
}
