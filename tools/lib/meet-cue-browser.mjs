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

function parseMeetUrl(value) {
  const url = URL.canParse(value) ? new URL(value) : null;
  return url?.origin === 'https://meet.google.com' ? url : null;
}

function meetingCode(value) {
  return parseMeetUrl(value)?.pathname.match(/^\/([a-z]{3}-[a-z]{4}-[a-z]{3})(?:\/|$)/i)?.[1].toLowerCase();
}

const inCallSelector = MEET_SELECTORS.inCallButtons.map(sel => sel + ':visible').join(', ');

export async function detectMeetJoinState(page, code) {
  if (!code || meetingCode(page.url()) !== code) return 'home';
  if (await page.locator(inCallSelector).first().isVisible()) return 'in_call';

  // ボタンの「Ask to join」は待機メッセージに含めない。
  const lobbyText = page.getByText(MEET_SELECTORS.lobbyTexts[0]);
  for (const element of await lobbyText.all()) {
    if (!(await element.isVisible())) continue;
    if (await element.evaluate(node => !node.closest('button, [role="button"]'))) {
      return 'in_lobby';
    }
  }
  return 'prejoin';
}

export async function findMeetJoinButton(page, code, { requireEnabled = true } = {}) {
  if (!code || meetingCode(page.url()) !== code) return null;

  for (const label of MEET_SELECTORS.joinButtons) {
    const buttons = page.getByRole('button').filter({ hasText: new RegExp(`^\\s*${label}\\s*$`) });
    for (const button of await buttons.all()) {
      if (!(await button.isVisible()) || (requireEnabled && !(await button.isEnabled()))) continue;
      if ((await button.innerText({ timeout: 1000 })).trim() !== label) continue;
      if (label === '参加') {
        const box = await button.boundingBox();
        const viewport = page.viewportSize();
        if (!box || !viewport) continue;
        const x = box.x + box.width / 2;
        const y = box.y + box.height / 2;
        if (x < viewport.width / 4 || x > viewport.width * 3 / 4 ||
            y < viewport.height / 4 || y > viewport.height * 3 / 4) continue;
      }
      return { button, label };
    }
  }
  return null;
}

export async function dismissMeetPopups(page) {
  for (const name of MEET_SELECTORS.dismissibleDialogs) {
    const close = page.getByRole('dialog', { name, exact: true })
      .getByRole('button', { name: '閉じる', exact: true }).first();
    if (await close.isVisible()) await close.click({ timeout: 1500 }).catch(() => {});
  }
}

export async function enableMeetCaptions(page) {
  const buttons = 'button, [role="button"]';
  const enableCandidates = page.locator(buttons).filter({
    hasText: /^(字幕をオンにする|Turn on captions)$/,
  }).or(page.locator(MEET_SELECTORS.captionsEnable.map(label =>
    `:is(${buttons})[aria-label="${label}"]`).join(', '))).and(page.locator(':visible'));
  const toggles = MEET_SELECTORS.captionToggles;
  const enable = enableCandidates.or(page.locator(toggles.map(selector =>
    `${selector}[aria-pressed="false"]:visible`).join(', '))).first();
  const enabled = page.locator([
    ...toggles.map(selector => `${selector}[aria-pressed="true"]:visible`),
    ...MEET_SELECTORS.captionsDisable.map(label => `:is(${buttons})[aria-label="${label}"]:visible`),
  ].join(', ')).or(enableCandidates.and(page.locator('[aria-pressed="true"]'))).first();

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (await enabled.isVisible()) return true;
      if (attempt !== 1 && await enable.isVisible()) {
        await enable.click({ timeout: 2000 });
      } else {
        await page.evaluate(() => {
          const body = document.body;
          if (!body.hasAttribute('tabindex')) body.tabIndex = -1;
          body.focus();
        });
        await page.keyboard.press('c');
      }
      await enabled.waitFor({ state: 'visible', timeout: 3000 });
      return true;
    } catch { /* 次の試行で状態を再確認する */ }
  }
  return false;
}

const excludedCaptionContainer = 'button, [role="button"], [role="toolbar"], [aria-hidden="true"]';

export function readMeetCaptions(root, selectors, excludedContainer, identifyRow) {
  const selector = selectors.captionContainers.join(', ');
  const speakerSelector = '.zs5S2e, .bh44bd, [data-sender-name]';
  const ignored = 'button, [role="button"], i, .material-icons, .google-symbols, [aria-hidden="true"]';
  const rows = [];
  const regions = Array.from(root.querySelectorAll(selector))
    .filter(region => !region.closest(excludedContainer));
  const addRow = (speaker, text, element, index = 0) => {
    const row = { speaker, text };
    if (identifyRow) row.rowId = identifyRow(element, index);
    rows.push(row);
  };
  for (const region of regions) {
    if (regions.some(other => other !== region && other.contains(region))) continue;
    const captionRows = region.querySelectorAll(selectors.captionRows.join(', '));
    if (captionRows.length) {
      for (const row of captionRows) {
        if (row.closest(excludedContainer)) continue;
        const speaker = row.querySelector(selectors.captionSpeakers.join(', '))?.textContent.trim() || '参加者';
        const body = row.querySelector(selectors.captionTexts.join(', '));
        if (!body || body.closest(excludedContainer)) continue;
        const content = body.cloneNode(true);
        content.querySelectorAll(ignored).forEach(child => child.remove());
        const text = content.textContent.trim();
        if (text) addRow(speaker, text, row);
      }
      continue;
    }

    let speaker = '参加者';
    let chunks = [];
    let index = 0;
    const flush = () => {
      const text = chunks.join('').trim();
      if (text && !/^[a-z0-9_]+$/.test(text)) addRow(speaker, text, region, index);
      chunks = [];
    };
    const visit = (node) => {
      if (node.nodeType === 3) {
        chunks.push(node.textContent);
      } else if (node.nodeType === 1 && !node.matches(ignored)) {
        if (node.matches(speakerSelector)) {
          flush();
          index++;
          const name = node.cloneNode(true);
          name.querySelectorAll(ignored).forEach(child => child.remove());
          speaker = name.textContent.trim() || node.getAttribute('data-sender-name')?.trim() || '参加者';
        } else {
          node.childNodes.forEach(visit);
        }
      }
    };
    visit(region);
    flush();
  }
  return rows;
}

export async function joinMeetPage(page, {
  url, preparePrejoin, onJoinState, log, uiTimeoutMs,
}) {
  let meetingUrl = url;
  let code = meetingCode(url);
  const createsMeeting = parseMeetUrl(url)?.pathname === '/new';
  let previousState;
  for (let attempt = 0; attempt < 2; attempt++) {
    log(`[meet-cue-browser] Meet URL へ移動中: ${meetingUrl}`);
    await page.goto(meetingUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    let uiDeadline = Date.now() + uiTimeoutMs;
    let lobbyDeadline;
    let prepared = false;
    let clicked = false;

    while (true) {
      const currentUrl = page.url();
      if (!code && createsMeeting) {
        code = meetingCode(currentUrl);
        if (code) meetingUrl = currentUrl;
      }
      const state = await detectMeetJoinState(page, code);
      if (state !== previousState) {
        onJoinState(state);
        previousState = state;
      }
      if (state === 'home') {
        if (parseMeetUrl(currentUrl)?.pathname === '/new' && createsMeeting && !code &&
            Date.now() < uiDeadline) {
          await page.waitForTimeout(250);
          continue;
        }
        if (attempt === 0 && !clicked && URL.canParse(currentUrl) &&
            new URL(currentUrl).hostname === 'accounts.google.com') {
          return 'signin_required';
        }
        if (attempt === 0 && (code || createsMeeting)) break;
        return 'left_meeting_page';
      }
      if (state === 'in_call') return null;
      if (state === 'in_lobby') {
        lobbyDeadline ??= Date.now() + 600000;
        if (Date.now() >= lobbyDeadline) return 'lobby_timeout';
      } else {
        if (lobbyDeadline) uiDeadline = Date.now() + uiTimeoutMs;
        lobbyDeadline = undefined;
        if (Date.now() >= uiDeadline) return clicked ? 'join_confirmation_timeout' : 'join_button_not_found';
        if (!clicked) {
          const choice = await findMeetJoinButton(page, code, { requireEnabled: prepared });
          if (choice && !prepared) {
            prepared = true;
            await preparePrejoin();
            continue;
          }
          if (choice && meetingCode(page.url()) === code) {
            try {
              await choice.button.click({ timeout: 2000 });
              clicked = true;
              log(`[meet-cue-browser] 参加ボタンをクリック: ${choice.label}`);
            } catch (err) {
              log(`[meet-cue-browser] 参加ボタンのクリック失敗: ${err.message}`);
            }
            // クリック直後の遷移を次の判定で確認する。
            continue;
          }
        }
      }
      await page.waitForTimeout(500);
    }
  }
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
  testAudio,
  mode = 'profile', // 'profile' | 'guest'
  maxMinutes = 120,
  debugDom = false,
  sessionDir = '',
  botDisplayName = 'オージャストAI',
  onCaption = () => {},
  onJoinState = () => {},
  onCaptionsOn = () => {},
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
        ...(testAudio ? [
          '--use-fake-device-for-media-stream',
          `--use-file-for-fake-audio-capture=${testAudio}`,
        ] : []),
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-notifications',
        '--disable-infobars',
        '--disable-session-crashed-bubble',
      ],
    });

    return await runMeetBot(context, close, {
      url, mode, maxMinutes, debugDom, sessionDir, botDisplayName, testAudio,
      onCaption, onJoinState, onCaptionsOn, getCaptionLineCount, log, uiTimeoutMs,
    });
  } catch (err) {
    await close();
    throw err;
  }
}

async function runMeetBot(context, close, {
  url, mode, maxMinutes, debugDom, sessionDir, botDisplayName, testAudio,
  onCaption, onJoinState, onCaptionsOn, getCaptionLineCount, log, uiTimeoutMs,
}) {
  const page = context.pages()[0] || await context.newPage();

  const enableTestMic = async () => {
    const mutedMic = page.getByRole('button', {
      name: /^(Turn on microphone|Unmute microphone|マイクをオンにする|マイクのミュートを解除)(?:$|[（( ])/i,
    }).and(page.locator(':visible')).first();
    if (await mutedMic.isVisible()) await mutedMic.click({ timeout: 2000 });
  };
  const preparePrejoin = async () => {
    try {
      if (!testAudio) await page.keyboard.press('Control+d');
      await page.waitForTimeout(500);
      await page.keyboard.press('Control+e');
    } catch { /* 無効なショートカットは無視する */ }

    if (testAudio) await enableTestMic();

    if (mode === 'guest') {
      for (const selector of MEET_SELECTORS.guestNameInput) {
        const input = page.locator(selector).first();
        if (!(await input.isVisible())) continue;
        await input.fill(botDisplayName, { timeout: 2000 });
        log(`[meet-cue-browser] ゲスト名を「${botDisplayName}」に設定`);
        break;
      }
    }
  };
  const reason = await joinMeetPage(page, { url, preparePrejoin, onJoinState, log, uiTimeoutMs });
  if (reason) {
    log(`[meet-cue-browser] Meet 参加失敗 (理由: ${reason}, URL: ${page.url()})`);
    if (sessionDir) {
      try {
        await page.screenshot({ path: path.join(sessionDir, 'join-failed.png'), timeout: 5000 });
      } catch (err) {
        log(`[meet-cue-browser] スクリーンショット保存失敗: ${err.message}`);
      }
    }
    throw Object.assign(new Error(`Meet 参加失敗: ${reason}`), { reason });
  }

  const joinedAt = Date.now();
  await dismissMeetPopups(page);
  const captionsOn = await enableMeetCaptions(page);
  onCaptionsOn(captionsOn);
  log(`[meet-cue-browser] 字幕オンの確認: ${captionsOn}`);

  if (testAudio) await enableTestMic();
  const stopCaptions = await watchMeetCaptions(page, { onCaption, log });

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
        await dismissMeetPopups(page);
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
    await stopCaptions();
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

export async function watchMeetCaptions(page, { onCaption, log, pollMs = 1500 }) {
  let latestSequence = 0;
  let previous = new Map();
  const receive = ({ sequence, rows }) => {
    if (sequence <= latestSequence) return;
    latestSequence = sequence;
    const current = new Map(rows.map(row => [row.rowId, row]));
    const timestamp = Date.now();
    for (const rowId of previous.keys()) {
      if (!current.has(rowId)) onCaption({ rowId, text: '', timestamp });
    }
    for (const row of rows) {
      const old = previous.get(row.rowId);
      if (old?.text !== row.text || old.speaker !== row.speaker) onCaption({ ...row, timestamp });
    }
    previous = current;
  };

  await page.exposeFunction('__meetCueOnCaption', receive);
  await page.evaluate(`(({ selectors, excludedContainer }) => {
    const readCaptions = ${readMeetCaptions.toString()};
    const containerSelector = selectors.captionContainers.join(', ');
    const ids = new WeakMap();
    let nextId = 0;
    let sequence = 0;
    let regions = [];
    const snapshot = () => ({
      sequence: ++sequence,
      rows: readCaptions(document, selectors, excludedContainer, (element, index) => {
        if (!ids.has(element)) ids.set(element, ++nextId);
        return ids.get(element) + ':' + index;
      }),
    });
    let observerError;
    const observer = new MutationObserver(() => {
      window.__meetCueOnCaption(snapshot()).catch(error => { observerError = String(error); });
    });
    window.__meetCueReadCaptions = (stop) => {
      const current = Array.from(document.querySelectorAll(containerSelector))
        .filter(region => !region.closest(excludedContainer));
      if (stop || current.length !== regions.length || current.some((region, i) => region !== regions[i])) {
        observer.disconnect();
        regions = current;
        if (!stop) {
          for (const region of regions) {
            observer.observe(region, { childList: true, subtree: true, characterData: true, attributes: true });
          }
        }
      }
      const result = { ...snapshot(), observerError };
      observerError = undefined;
      return result;
    };
  })(${JSON.stringify({ selectors: MEET_SELECTORS, excludedContainer: excludedCaptionContainer })})`);

  const poll = async (stop = false) => {
    try {
      const result = await page.evaluate(stop => window.__meetCueReadCaptions(stop), stop);
      if (result.observerError) log(`[meet-cue-browser] 字幕 Observer の通知に失敗: ${result.observerError}`);
      receive(result);
    } catch (err) {
      if (!page.isClosed()) log(`[meet-cue-browser] 字幕の読み取りに失敗: ${err.message}`);
    }
  };
  await poll();
  let pendingPoll;
  const interval = setInterval(() => {
    pendingPoll ??= poll().finally(() => { pendingPoll = undefined; });
  }, pollMs);

  return async () => {
    clearInterval(interval);
    await pendingPoll;
    await poll(true);
  };
}

async function saveCaptionDebug(page, sessionDir) {
  const captured = await page.evaluate(({ selector, excludedContainer }) => ({
    captionCandidates: Array.from(document.querySelectorAll(selector), element => ({
      outerHTML: element.outerHTML.slice(0, 2000),
      excluded: Boolean(element.closest(excludedContainer)),
    })),
    ariaLabels: [...new Set(Array.from(document.querySelectorAll('[aria-label]'),
      element => element.getAttribute('aria-label')))],
    bodyText: document.body.innerText,
  }), { selector: MEET_SELECTORS.captionContainers.join(', '), excludedContainer: excludedCaptionContainer });
  const selectorHits = {};
  for (const [group, candidates] of Object.entries(MEET_SELECTORS)) {
    selectorHits[group] = Object.fromEntries(await Promise.all(candidates.map(async candidate => [
      candidate,
      group === 'leftCallTexts'
        ? captured.bodyText.split(candidate).length - 1
        : ['joinButtons', 'captionsEnable', 'captionsDisable'].includes(group)
          ? await page.getByRole('button', { name: candidate, exact: true }).count()
          : group === 'dismissibleDialogs'
            ? await page.getByRole('dialog', { name: candidate, exact: true }).count()
            : group === 'lobbyTexts'
              ? await page.getByText(candidate).count()
              : await page.locator(candidate).count(),
    ])));
  }
  fs.writeFileSync(path.join(sessionDir, 'caption-debug.json'), JSON.stringify({
    selectorHits,
    ariaLabels: captured.ariaLabels,
    captionCandidates: captured.captionCandidates,
  }, null, 2), 'utf8');
}
