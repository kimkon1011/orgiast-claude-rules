// 人が手でログインする必要があるブラウザ操作の共通部品。
// 2026-10-10 の実害: --login が Facebook の 2 段階認証(checkpoint)の途中 URL を
// 「ログイン済み」と誤判定してツール側からブラウザを閉じてしまい、kim にログインを 3 回
// やらせた。さらに Playwright 同梱 Chromium と playwright-core の revision ずれで落ちた。
// ここでは「ツール側からは絶対に閉じない」「正規版 Google Chrome を優先」を唯一の実装に固定し、
// 静的ガード(tools/human-login-guard.test.mjs)で再発を防ぐ。
// playwright-core には依存しない(chromium は呼び出し側から注入する)。純粋関数 + 依存注入。
import { existsSync } from "node:fs";
import path from "node:path";

export const DEFAULT_LOGIN_TIMEOUT_MS = 20 * 60 * 1000;
export const LOGIN_POLL_MS = 2000;

// 正規版 Google Chrome の候補を優先順に返す。
export function chromeCandidates(env = {}) {
  const win = (base) => (base ? path.join(base, "Google", "Chrome", "Application", "chrome.exe") : null);
  const candidates = [
    win(env?.PROGRAMFILES),
    win(env?.["PROGRAMFILES(X86)"]),
    win(env?.LOCALAPPDATA),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ];
  return candidates.filter(Boolean);
}

// 実在する正規版 Chrome を優先し、無ければ Playwright 同梱 Chromium にフォールバックする。
// revision ずれで同梱 Chromium が落ちるため、正規版があれば必ずそちらを使う。
export function resolveBrowserExecutable({ env = process.env, exists = existsSync, findChromium = () => null } = {}) {
  for (const candidate of chromeCandidates(env)) {
    try {
      if (exists(candidate)) return candidate;
    } catch {
      // 判定できない候補は飛ばす
    }
  }
  try {
    return (typeof findChromium === "function" ? findChromium() : null) ?? null;
  } catch {
    return null;
  }
}

function contextClosed(context) {
  if (!context || typeof context.pages !== "function") return false;
  try {
    return context.pages().length === 0;
  } catch {
    return false;
  }
}

// 人がウィンドウ(全ページ)を閉じるか context の close イベントまで待つだけ。
// **この関数は context を絶対に close しない**(誤判定で閉じてログインをやり直させた実害の再発防止)。
export async function waitForHumanLogin(context, { timeoutMs = DEFAULT_LOGIN_TIMEOUT_MS, sleep, now = Date.now, log = () => {}, pollMs = LOGIN_POLL_MS } = {}) {
  const wait = typeof sleep === "function" ? sleep : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  let closed = false;
  if (context && typeof context.on === "function") {
    try {
      context.on("close", () => {
        closed = true;
      });
    } catch {
      // close イベントが取れない実装でも pages() で判定する
    }
  }
  const start = now();
  while (!closed) {
    if (now() - start >= timeoutMs) return { closedByUser: false };
    await wait(pollMs);
    if (closed) break;
    if (contextClosed(context)) {
      closed = true;
      break;
    }
  }
  return { closedByUser: true };
}

function normalizeDomain(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase().replace(/^\./, "");
  return trimmed || null;
}

// cookie の domain が要求ドメインに一致するか(前方一致の逆方向も許す)。
function domainMatches(cookieDomain, wanted) {
  const actual = normalizeDomain(cookieDomain);
  if (actual === null) return false;
  return actual === wanted || actual.endsWith(`.${wanted}`) || wanted.endsWith(`.${actual}`);
}

// requiredNames のうち cookie 配列に無いものを返す。
// cookieDomain を渡すと、そのドメインの cookie だけを数える(別サービスに同名校の cookie がある場合の誤判定防止)。
export function missingLoginCookies(cookies, requiredNames, cookieDomain = null) {
  const list = Array.isArray(cookies) ? cookies : [];
  const wanted = Array.isArray(requiredNames) ? requiredNames : [];
  const domain = normalizeDomain(cookieDomain);
  return wanted.filter(
    (name) => !list.some((cookie) => cookie && cookie.name === name && (domain === null || domainMatches(cookie.domain, domain))),
  );
}

export function verifyLoginCookies(cookies, requiredNames, cookieDomain = null) {
  return missingLoginCookies(cookies, requiredNames, cookieDomain).length === 0;
}

// 人がログインする一連の流れ。戻り値は { code, closedByUser, missing }。
//   code 0 = ログインを保存できた / 3 = ログインが保存されていない(cookie 不足)
//        4 = Chrome か playwright-core が無い / 5 = 人が閉じなかった(タイムアウト)
//        1 = 起動・遷移などの実行失敗
// どの経路でも、こちらの都合でログイン用ウィンドウを閉じることはしない。
export async function runHumanLogin({ chromium, profileDir, url, requiredCookies = [], cookieDomain = null, deps = {} } = {}) {
  const log = typeof deps.log === "function" ? deps.log : () => {};
  const exists = typeof deps.exists === "function" ? deps.exists : existsSync;
  const env = deps.env ?? process.env;
  const findChromium = typeof deps.findChromium === "function" ? deps.findChromium : () => null;
  const sleep = deps.sleep;
  const now = deps.now ?? Date.now;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS;
  const executablePath = deps.executablePath ?? resolveBrowserExecutable({ env, exists, findChromium });

  if (!executablePath) {
    log("ERROR: Chrome/Chromium が見つかりません。npx playwright install chromium を実行してください");
    return { code: 4, closedByUser: false, missing: [...requiredCookies] };
  }
  if (!chromium || typeof chromium.launchPersistentContext !== "function") {
    log("ERROR: playwright-core が見つかりません。npm install playwright-core を実行してください");
    return { code: 4, closedByUser: false, missing: [...requiredCookies] };
  }

  let loginContext = null;
  try {
    // 正規版 Chrome を使い、同梱 Chromium の revision ずれを避ける。
    loginContext = await chromium.launchPersistentContext(profileDir, {
      headless: false,
      executablePath,
      ignoreDefaultArgs: ["--no-sandbox"],
    });
  } catch (err) {
    log(`ERROR: ブラウザを起動できませんでした (${err?.message ?? err})`);
    return { code: 1, closedByUser: false, missing: [...requiredCookies] };
  }

  try {
    const page = loginContext.pages?.()[0] ?? (await loginContext.newPage());
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  } catch (err) {
    log(`ERROR: ログイン画面を開けませんでした (${err?.message ?? err})`);
    return { code: 1, closedByUser: false, missing: [...requiredCookies] };
  }

  log("ログインして、確認ステップも最後まで進め、画面が表示されたら × で閉じてください。こちらからは閉じません");
  const { closedByUser } = await waitForHumanLogin(loginContext, { timeoutMs, sleep, now, log });
  if (!closedByUser) {
    // まだ開いている。ここでは検証できない(同じ profile を二重に開けない)ので、閉じずに返す。
    log("ERROR: タイムアウトしました。ブラウザは開いたままです（こちらからは閉じません）");
    return { code: 5, closedByUser: false, missing: [...requiredCookies] };
  }

  let verifyContext = null;
  try {
    verifyContext = await chromium.launchPersistentContext(profileDir, { headless: true, executablePath });
    const cookies = await verifyContext.cookies();
    const missing = missingLoginCookies(cookies, requiredCookies, cookieDomain);
    if (missing.length === 0) {
      log("OK: ログインを保存しました");
      return { code: 0, closedByUser: true, missing: [] };
    }
    log(`ERROR: ログインが保存されていません（不足: ${missing.join(", ")}）`);
    return { code: 3, closedByUser: true, missing };
  } catch (err) {
    log(`ERROR: ログインの確認に失敗しました (${err?.message ?? err})`);
    return { code: 3, closedByUser: true, missing: [...requiredCookies] };
  } finally {
    // 検証用に自分で開いた headless context だけは閉じる(人のログイン画面は閉じない)。
    if (verifyContext) {
      try {
        await verifyContext.close();
      } catch {
        // ignore
      }
    }
  }
}
