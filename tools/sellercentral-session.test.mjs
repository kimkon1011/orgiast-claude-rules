import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  resolveBrowserExecutable,
  missingLoginCookies,
  isSignInPage,
  parseArgs,
  findChromium,
  cmdLogin,
  cmdCheck,
  PROFILE_DIR,
  SELLERCENTRAL_URL,
  REQUIRED_COOKIES,
  SELLERCENTRAL_COOKIE_DOMAIN,
} from "./sellercentral-session.mjs";

const tempProfiles = [];
function temporaryProfile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sellercentral-test-"));
  tempProfiles.push(dir);
  return dir;
}
after(() => { for (const dir of tempProfiles) fs.rmSync(dir, { recursive: true, force: true }); });

// ===== 純関数のテスト =====

test("isSignInPage: Amazon サインイン URL を検出する", () => {
  assert.ok(isSignInPage("https://sellercentral.amazon.co.jp/ap/signin?ref=nav"));
  assert.ok(isSignInPage("https://sellercentral.amazon.co.jp/ap/sign_in?ref=nav"));
  assert.ok(isSignInPage("https://sellercentral.amazon.co.jp/sign-in"));
  assert.ok(isSignInPage("https://www.amazon.co.jp/ap/signin?openid.return_to=..."));
  assert.ok(isSignInPage("https://sellercentral.amazon.co.jp/signin"));
});

test("isSignInPage: 通常ページは false", () => {
  assert.ok(!isSignInPage("https://sellercentral.amazon.co.jp/inventory"));
  assert.ok(!isSignInPage("https://sellercentral.amazon.co.jp/orders"));
  assert.ok(!isSignInPage("https://sellercentral.amazon.co.jp/"));
  assert.ok(!isSignInPage("https://www.amazon.co.jp/"));
});

test("isSignInPage: 境界値は false", () => {
  assert.ok(!isSignInPage(""));
  assert.ok(!isSignInPage(null));
  assert.ok(!isSignInPage(undefined));
  assert.ok(!isSignInPage(42));
});

test("parseArgs: サブコマンドを小文字で抽出する", () => {
  assert.deepEqual(parseArgs(["login"]), { command: "login" });
  assert.deepEqual(parseArgs(["check"]), { command: "check" });
  assert.deepEqual(parseArgs(["LOGIN"]), { command: "login" });
  assert.deepEqual(parseArgs([]), { command: "" });
  assert.deepEqual(parseArgs(["login", "--extra"]), { command: "login" });
});

test("findChromium: 環境変数が無いときはエラーにならず null か文字列", () => {
  const result = findChromium();
  // null（chromium が見つからない環境）か string（見つかる環境）
  assert.ok(result === null || typeof result === "string");
});

// ===== 定数の確認 =====

test("PROFILE_DIR は ~/.claude/browser-profiles/tetsuko-sellercentral", () => {
  assert.ok(PROFILE_DIR.endsWith(path.join(".claude", "browser-profiles", "tetsuko-sellercentral")));
});

test("REQUIRED_COOKIES は session-token を含む", () => {
  assert.ok(REQUIRED_COOKIES.includes("session-token"));
  assert.ok(REQUIRED_COOKIES.length > 0);
});

test("SELLERCENTRAL_COOKIE_DOMAIN は .amazon.co.jp", () => {
  assert.equal(SELLERCENTRAL_COOKIE_DOMAIN, ".amazon.co.jp");
});

// ===== fake ブラウザユーティリティ =====

/** playwright-core の chromium を模した fake */
function makeFakeChromium({ onLaunch } = {}) {
  const launchCalls = [];
  let contextIndex = 0;
  return {
    launchCalls,
    // chromium 本体: launchPersistentContext だけ持つ
    chromium: {
      async launchPersistentContext(dir, options) {
        const ctx = makeFakeContext({ id: contextIndex++ });
        launchCalls.push({ dir, options });
        if (typeof onLaunch === "function") onLaunch(options, ctx);
        return ctx;
      },
    },
    // ヘルパー
    lastLaunch() { return launchCalls[launchCalls.length - 1]; },
  };
}

/** Playwright の BrowserContext を模した fake */
function makeFakeContext({ id = 0, pages } = {}) {
  const closeCalls = [];
  const cookies = [];
  return {
    id,
    closeCalls,
    cookies,
    pages() { return pages ?? [makeFakePage()]; },
    on(event, handler) { this._listeners ??= {}; this._listeners[event] = handler; },
    async cookies() { return this._cookieResult ?? []; },
    async close() { closeCalls.push("close"); },
    _setCookieResult(arr) { this._cookieResult = arr; },
  };
}

/** Playwright の Page を模した fake */
function makeFakePage({ url = "https://example.com/" } = {}) {
  return {
    _url: url,
    get url() { return this._url; },
    set url(v) { this._url = v; },
    async goto(_target, _opts) {},
  };
}

// ===== cmdCheck のテスト =====

test("cmdCheck: ログイン中なら 0", async () => {
  const fake = makeFakeChromium();
  const page = makeFakePage({ url: "https://sellercentral.amazon.co.jp/inventory" });
  const context = makeFakeContext({ pages: [page] });
  // launchPersistentContext がこの context を返すように上書き
  fake.chromium.launchPersistentContext = async (_dir, _opts) => context;

  const result = await cmdCheck({
    chromium: fake.chromium,
    profileDir: temporaryProfile(),
    executablePath: "/test/chrome.exe",
  });

  assert.equal(result.code, 0, "ログイン中のはずが code=" + result.code);
  assert.ok(result.url.includes("inventory"), "inventory の URL が返る");
  // 検証用の headless context は閉じる
  assert.equal(context.closeCalls.length, 1, "検証用 context は閉じる");
});

test("cmdCheck: ログイン切れなら 1", async () => {
  const fake = makeFakeChromium();
  const page = makeFakePage({ url: "https://sellercentral.amazon.co.jp/ap/signin?ref=nav" });
  const context = makeFakeContext({ pages: [page] });
  fake.chromium.launchPersistentContext = async (_dir, _opts) => context;

  const result = await cmdCheck({
    chromium: fake.chromium,
    profileDir: temporaryProfile(),
    executablePath: "/test/chrome.exe",
  });

  assert.equal(result.code, 1, "ログイン切れのはずが code=" + result.code);
  assert.ok(result.url.includes("signin"), "signin URL が返る");
  assert.equal(context.closeCalls.length, 1);
});

test("cmdCheck: プロファイルロック（launch が throw）なら 6", async () => {
  const context = makeFakeContext();
  const chromium = {
    async launchPersistentContext(_dir, _opts) {
      throw new Error("Failed to lock profile");
    },
  };

  const result = await cmdCheck({
    chromium,
    profileDir: temporaryProfile(),
    executablePath: "/test/chrome.exe",
  });

  assert.equal(result.code, 6);
  assert.equal(result.error, "ログイン作業中");
  // context が作成されなかったので close 呼ばれない
  assert.equal(context.closeCalls.length, 0);
});

test("cmdCheck: last-check.json を保存する", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sellercentral-check-"));
  try {
    const fake = makeFakeChromium();
    const page = makeFakePage({ url: "https://sellercentral.amazon.co.jp/inventory" });
    const context = makeFakeContext({ pages: [page] });
    fake.chromium.launchPersistentContext = async (_dir, _opts) => context;

    const result = await cmdCheck({
      chromium: fake.chromium,
      profileDir: tmpDir,
      executablePath: "/test/chrome.exe",
    });

    assert.equal(result.code, 0);

    const checkPath = path.join(tmpDir, "last-check.json");
    assert.ok(fs.existsSync(checkPath), "last-check.json が存在");
    const data = JSON.parse(fs.readFileSync(checkPath, "utf8"));
    assert.equal(data.status, "ok");
    assert.ok(typeof data.checkedAt === "string");
    assert.ok(data.url.includes("inventory"));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("cmdCheck: ログイン切れでも last-check.json を保存する", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sellercentral-check2-"));
  try {
    const fake = makeFakeChromium();
    const page = makeFakePage({ url: "https://sellercentral.amazon.co.jp/ap/signin" });
    const context = makeFakeContext({ pages: [page] });
    fake.chromium.launchPersistentContext = async (_dir, _opts) => context;

    const result = await cmdCheck({
      chromium: fake.chromium,
      profileDir: tmpDir,
      executablePath: "/test/chrome.exe",
    });

    assert.equal(result.code, 1);

    const checkPath = path.join(tmpDir, "last-check.json");
    assert.ok(fs.existsSync(checkPath), "ログイン切れでも last-check.json を作る");
    const data = JSON.parse(fs.readFileSync(checkPath, "utf8"));
    assert.equal(data.status, "expired");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// 人のログイン画面を close したら、記録して必ずテストを失敗させる。
for (const scenario of ["ok", "missing", "timeout", "navigation-error", "close-event"]) {
  test(`cmdLogin: ${scenario} / 人の context を閉じない`, async () => {
    let humanCloseCalls = 0;
    let verifyCloseCalls = 0;
    let tick = 0;
    let closed = false;
    let closeHandler;
    const launches = [];
    const human = {
      pages: () => closed ? [] : [page],
      on: (event, handler) => { if (event === "close") closeHandler = handler; },
      close: async () => { humanCloseCalls++; assert.fail("人の context.close() が呼ばれた"); },
    };
    const page = {
      url: () => { assert.fail("login で URL を推測してはいけない"); },
      goto: async target => {
        assert.equal(target, SELLERCENTRAL_URL);
        if (scenario === "navigation-error") throw new Error("navigation failed");
      },
    };
    const chromium = {
      launchPersistentContext: async (dir, options) => {
        launches.push({ dir, options });
        if (!options.headless) return human;
        assert.ok(closed);
        return {
          cookies: async () => scenario === "missing" ? [] : [
            { name: "session-token", domain: ".amazon.co.jp", value: "test-only" },
          ],
          close: async () => { verifyCloseCalls++; },
        };
      },
    };
    const result = await cmdLogin({
      chromium, executablePath: "/fake/chrome", profileDir: "fake-profile",
      timeoutMs: 10, now: () => tick,
      sleep: async () => {
        tick += 5;
        if (scenario !== "timeout") {
          closed = true;
          if (scenario === "close-event") closeHandler();
        }
      },
    });
    assert.equal(result.code, { ok: 0, missing: 3, timeout: 5, "navigation-error": 4, "close-event": 0 }[scenario]);
    assert.equal(humanCloseCalls, 0);
    const verified = ["ok", "missing", "close-event"].includes(scenario);
    assert.equal(verifyCloseCalls, verified ? 1 : 0);
    assert.equal(launches.length, verified ? 2 : 1);
    assert.equal(launches[0].options.headless, false);
    assert.ok(launches.every(call => call.dir === "fake-profile" && call.options.executablePath === "/fake/chrome"));
  });
}

test("resolveBrowserExecutable: 環境変数の優先順位と fallback", () => {
  const env = { PROGRAMFILES: "PF", "PROGRAMFILES(X86)": "PF86", LOCALAPPDATA: "LOCAL" };
  const expected = Object.values(env).map(base => path.join(base, "Google", "Chrome", "Application", "chrome.exe"));
  for (let i = 0; i < expected.length; i++) {
    assert.equal(resolveBrowserExecutable({ env, exists: candidate => expected.slice(i).includes(candidate), findChromium: () => "bundled" }), expected[i]);
  }
  assert.equal(resolveBrowserExecutable({ env, exists: () => false, findChromium: () => "bundled" }), "bundled");
  assert.equal(resolveBrowserExecutable({ env: {}, exists: () => false }), null);
});

test("missingLoginCookies: Amazon JP の session-token のみを許容", () => {
  for (const domain of [".amazon.co.jp", "sellercentral.amazon.co.jp", ".sellercentral.amazon.co.jp"]) {
    assert.deepEqual(missingLoginCookies([{ name: "session-token", domain, value: "test" }]), []);
  }
  for (const domain of ["co.jp", "evilamazon.co.jp", "amazon.com", "amazon.co.jp.evil.test", "other.amazon.co.jp"]) {
    assert.deepEqual(missingLoginCookies([{ name: "session-token", domain, value: "test" }]), ["session-token"]);
  }
  assert.deepEqual(missingLoginCookies([{ name: "session-token", domain: ".amazon.co.jp", value: "" }]), ["session-token"]);
});

test("isSignInPage: query 内の signin や他ドメインを誤検知しない", () => {
  assert.equal(isSignInPage("https://sellercentral.amazon.co.jp/inventory?next=/ap/signin"), false);
  assert.equal(isSignInPage("https://example.com/ap/signin"), false);
});

test("cmdCheck: ロック以外の起動失敗は 4", async () => {
  const result = await cmdCheck({ executablePath: "/fake/chrome", chromium: {
    launchPersistentContext: async () => { throw new Error("Executable does not exist"); },
  } });
  assert.equal(result.code, 4);
});
