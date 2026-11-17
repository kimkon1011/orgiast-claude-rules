// Amazon Seller Central セッション管理。
// login サブコマンド: 人がブラウザでログイン → Cookie 確認。ツール側からは絶対に閉じない。
// check サブコマンド: headless で /inventory に遷移しサインイン状態を確認。
// playwright-core は動的 import（テストやヘルプ表示時には不要）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { isEntry } from "./is-entry.mjs";
import { resolveBrowserExecutable, runHumanLogin } from "./lib/human-login.mjs";
export { resolveBrowserExecutable };

// Seller Central または Amazon JP の認証 Cookie だけを数える。値は出力しない。
export function missingLoginCookies(cookies, names = REQUIRED_COOKIES) {
  return names.filter(name => !(Array.isArray(cookies) ? cookies : []).some(cookie =>
    cookie?.name === name && typeof cookie.value === "string" && cookie.value.length > 0 &&
    ["amazon.co.jp", "sellercentral.amazon.co.jp"].includes(String(cookie.domain).toLowerCase().replace(/^\./, ""))));
}
export function verifyLoginCookies(cookies, names = REQUIRED_COOKIES) {
  return missingLoginCookies(cookies, names).length === 0;
}
function isProfileLocked(error) {
  return /ProcessSingleton|SingletonLock|profile.*(?:in use|locked|lock)|lock.*profile|user data directory.*in use/i.test(String(error?.message));
}
async function browserOptions(opts) {
  const chromium = opts.chromium ?? await loadChromium();
  const executablePath = opts.executablePath ?? resolveBrowserExecutable({
    findChromium: () => {
      const bundled = chromium.executablePath?.();
      return bundled && fs.existsSync(bundled) ? bundled : null;
    },
  });
  return { chromium, executablePath };
}

// --- 定数 ---
// プロファイルディレクトリ: Playwright の launchPersistentContext が管理する。
// 人に1回ログインしてもらえば、以後は同じプロファイルを headless で開いて Cookie を確認できる。
export const PROFILE_DIR = path.join(os.homedir(), ".claude", "browser-profiles", "tetsuko-sellercentral");
/** Seller Central トップ URL（ログイン画面を開くときの起点）。 */
export const SELLERCENTRAL_URL = "https://sellercentral.amazon.co.jp";
/** Cookie のドメイン制約。サブドメインも含めるため先頭ドット。 */
export const SELLERCENTRAL_COOKIE_DOMAIN = ".amazon.co.jp";
/**
 * ログイン確認に必須の Cookie 名。
 * session-token は Amazon 認証の中核 Cookie。実際の Seller Central ログインで
 * 他にも必要と判明したら追加する（例: at-acbjp, x-acbjp, ubid-acbjp）。
 */
export const REQUIRED_COOKIES = ["session-token"];

const LAST_CHECK_FILE = "last-check.json";
const CHECK_TIMEOUT_MS = 30_000;

// --- 純関数 ---

/**
 * 与えられた URL が Amazon サインインページか判定する。
 * @param {string} url 判定対象の URL
 * @returns {boolean} サインインページなら true
 */
export function isSignInPage(url) {
  if (typeof url !== "string" || url.length === 0) return false;
  try {
    const parsed = new URL(url);
    return /^(?:[a-z0-9-]+\.)*amazon\.co\.jp$/i.test(parsed.hostname) &&
      /\/(?:ap\/sign_?in|sign-in|signin)(?:\/|$)/i.test(parsed.pathname);
  } catch { return false; }
}

/**
 * CLI 引数を解析する。
 * @param {string[]} argv
 * @returns {{ command: string }}
 */
export function parseArgs(argv) {
  return { command: String(argv[0] ?? "").toLowerCase() };
}

// --- ms-playwright 同梱 Chromium の発見（正規版 Chrome が無い場合の最終フォールバック） ---

/**
 * ms-playwright ディレクトリ内の chromium-* から chrome.exe を探す。
 * 正規版 Google Chrome がインストールされていない環境で使う。
 * @returns {string|null} chrome.exe の絶対パス、無ければ null
 */
export function findChromium() {
  let baseDir;
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) {
    baseDir = process.env.PLAYWRIGHT_BROWSERS_PATH;
  } else if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    baseDir = path.join(process.env.LOCALAPPDATA, "ms-playwright");
  } else if (process.platform === "darwin") {
    baseDir = path.join(os.homedir(), "Library", "Caches", "ms-playwright");
  } else {
    baseDir = path.join(os.homedir(), ".cache", "ms-playwright");
  }
  try {
    const entries = fs.readdirSync(baseDir, { withFileTypes: true });
    const chromiumDirs = entries
      .filter((e) => e.isDirectory() && e.name.startsWith("chromium-"))
      .map((e) => e.name)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const dir of chromiumDirs) {
      const exe = path.join(baseDir, dir, "chrome-win64", "chrome.exe");
      if (fs.existsSync(exe)) return exe;
    }
  } catch {
    // ディレクトリが無い・読めない → フォールバック無し
  }
  return null;
}

// --- playwright-core の動的ロード ---

async function loadChromium() {
  try {
    const mod = await import("playwright-core");
    const chromium = mod.chromium ?? mod.default?.chromium;
    if (chromium) return chromium;
    throw new Error("chromium not found in playwright-core");
  } catch (cause) {
    throw new Error("playwright-core が見つかりません。npm install playwright-core を実行してください", { cause });
  }
}

// --- サブコマンド: login ---

/**
 * 人が Seller Central にログインするためのブラウザを開く。
 * runHumanLogin に委譲するため、ツール側からは絶対にブラウザを閉じない。
 *
 * @param {object} opts
 * @param {object}  [opts.chromium]  playwright-core の chromium（省略時は動的 import）
 * @param {string}  [opts.profileDir=PROFILE_DIR]
 * @param {string}  [opts.executablePath]  Chrome/Chromium のパス（省略時は自動解決）
 * @returns {Promise<{ code: number, closedByUser: boolean, missing: string[] }>}
 */
export async function cmdLogin(opts = {}) {
  let browser;
  try { browser = await browserOptions(opts); }
  catch { console.error("ERROR: playwright-core が見つかりません"); return { code: 4 }; }
  // 共通処理には Cookie 名・ドメインのみ渡す。値や URL をログに出さない。
  let verificationFailed = false;
  const adapter = {
    async launchPersistentContext(dir, options) {
      let context;
      try { context = await browser.chromium.launchPersistentContext(dir, options); }
      catch (error) { if (options.headless) verificationFailed = true; throw error; }
      if (!options.headless) return context;
      return {
        cookies: async () => {
          try {
            return (await context.cookies()).filter(cookie =>
              missingLoginCookies([cookie], [cookie.name]).length === 0);
          } catch (error) { verificationFailed = true; throw error; }
        },
        close: () => context.close(),
      };
    },
  };
  const result = await runHumanLogin({
    chromium: adapter,
    profileDir: opts.profileDir ?? PROFILE_DIR,
    url: SELLERCENTRAL_URL,
    requiredCookies: REQUIRED_COOKIES,
    cookieDomain: SELLERCENTRAL_COOKIE_DOMAIN,
    deps: {
      executablePath: browser.executablePath,
      env: {}, exists: () => false,
      timeoutMs: opts.timeoutMs,
      sleep: opts.sleep, now: opts.now,
      log: message => {
        if (message.startsWith("ERROR:")) {
          if (message.includes("タイムアウト")) console.error("ERROR: タイムアウト。ブラウザは開いたままです。×で閉じてください");
          return;
        }
        if (!message.startsWith("OK:")) console.log(message);
      },
    },
  });
  if (verificationFailed) result.code = 4;
  if (result.code === 0) console.log("OK");
  if (result.code === 3) console.error(`ERROR: 不足 ${result.missing.join(", ")}`);
  if (result.code === 1 || result.code === 4) {
    console.error("ERROR: ブラウザ・playwright の起動または画面表示を確認できません");
    result.code = 4;
  }
  return result;
}

// --- サブコマンド: check ---

/**
 * headless でプロファイルを開き /inventory に遷移、サインイン状態を確認する。
 * プロファイルが別プロセスにロックされている場合は終了コード 6 を返す。
 *
 * @param {object}  opts
 * @param {object}  [opts.chromium]  playwright-core の chromium（省略時は動的 import）
 * @param {string}  [opts.profileDir=PROFILE_DIR]
 * @param {string}  [opts.executablePath]  Chrome/Chromium のパス（省略時は自動解決）
 * @param {string}  [opts.url=SELLERCENTRAL_URL]
 * @returns {Promise<{ code: number, url?: string, error?: string }>}
 */
export async function cmdCheck(opts = {}) {
  let browser;
  try { browser = await browserOptions(opts); }
  catch { console.error("ERROR: playwright-core が見つかりません"); return { code: 4 }; }
  const { chromium: pw, executablePath: exe } = browser;
  const dir = opts.profileDir ?? PROFILE_DIR;
  const targetUrl = opts.url ?? SELLERCENTRAL_URL;

  if (!exe) {
    console.error("ERROR: Chrome/Chromium が見つかりません。npm install playwright-core を実行してください");
    return { code: 4 };
  }

  let context = null;
  try {
    context = await pw.launchPersistentContext(dir, { headless: true, executablePath: exe });
  } catch (err) {
    // プロファイルロック（別プロセスがログイン中など）
    const locked = isProfileLocked(err);
    const msg = locked ? "ログイン作業中" : "ERROR: ブラウザを起動できません";
    console.error(msg);
    return { code: locked ? 6 : 4, error: msg };
  }

  try {
    const pages = context.pages();
    const page = pages[0] ?? (await context.newPage());

    await page.goto(targetUrl + "/inventory", { waitUntil: "domcontentloaded", timeout: CHECK_TIMEOUT_MS });

    const currentUrl = typeof page.url === "function" ? page.url() : page.url;
    const isSignIn = isSignInPage(currentUrl);

    // last-check.json を保存（プロファイルディレクトリが無ければ作成）
    const lastCheck = {
      checkedAt: new Date().toISOString(),
      status: isSignIn ? "expired" : "ok",
      url: new URL(currentUrl).origin + new URL(currentUrl).pathname,
    };
    try {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, LAST_CHECK_FILE), JSON.stringify(lastCheck, null, 2) + "\n", "utf8");
    } catch {
      // last-check.json の保存失敗は致命的ではない
    }

    if (isSignIn) {
      console.error("ログイン切れ");
      return { code: 1, url: currentUrl };
    }

    console.log("ログイン中");
    return { code: 0, url: currentUrl };
  } finally {
    if (context) {
      try { await context.close(); } catch { /* 検証用の headless context だけ閉じる */ }
    }
  }
}

// --- メイン ---

const USAGE = `使用方法:
  node tools/sellercentral-session.mjs login    — ブラウザで Seller Central にログイン（人が × で閉じる）
  node tools/sellercentral-session.mjs check   — headless でログイン状態を確認

終了コード:
  login: 0=OK  3=Cookie不足  4=環境不足  5=タイムアウト
  check: 0=ログイン中  1=ログイン切れ  6=ログイン作業中  4=環境不足`;

/**
 * CLI エントリポイント。コマンドライン引数に応じてサブコマンドを実行する。
 * @param {string[]} argv process.argv のサブコマンド以降
 * @returns {Promise<{ code: number }>}
 */
export async function main(argv) {
  const args = parseArgs(argv);
  const cmd = args.command;

  if (cmd === "login") return await cmdLogin();
  if (cmd === "check") return await cmdCheck();

  console.error(USAGE);
  return { code: 1 };
}

// --- エントリポイントガード ---
if (isEntry(import.meta.url)) {
  try {
    const result = await main(process.argv.slice(2));
    if (typeof result?.code === "number") process.exitCode = result.code;
  } catch (err) {
    console.error("ERROR: 処理に失敗しました");
    process.exitCode = 1;
  }
}
