import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  chromeCandidates,
  resolveBrowserExecutable,
  waitForHumanLogin,
  verifyLoginCookies,
  missingLoginCookies,
  runHumanLogin,
  DEFAULT_LOGIN_TIMEOUT_MS,
} from "./human-login.mjs";

const ENV = {
  PROGRAMFILES: "C:\\PF",
  "PROGRAMFILES(X86)": "C:\\PF86",
  LOCALAPPDATA: "C:\\LAD",
};
const winChrome = (base) => path.join(base, "Google", "Chrome", "Application", "chrome.exe");

test("resolveBrowserExecutable: 正規版 Chrome を PROGRAMFILES → (X86) → LOCALAPPDATA の順に探す", () => {
  const pf = winChrome(ENV.PROGRAMFILES);
  const pf86 = winChrome(ENV["PROGRAMFILES(X86)"]);
  const lad = winChrome(ENV.LOCALAPPDATA);
  // 3つとも在るなら PROGRAMFILES が最優先
  assert.equal(resolveBrowserExecutable({ env: ENV, exists: () => true }), pf);
  // PROGRAMFILES が無ければ (X86)
  assert.equal(resolveBrowserExecutable({ env: ENV, exists: (p) => p !== pf }), pf86);
  // 上位が無ければ LOCALAPPDATA
  assert.equal(resolveBrowserExecutable({ env: ENV, exists: (p) => p === lad }), lad);
});

test("resolveBrowserExecutable: 正規版が無ければ findChromium の結果にフォールバックする", () => {
  const result = resolveBrowserExecutable({ env: ENV, exists: () => false, findChromium: () => "/fake/chromium" });
  assert.equal(result, "/fake/chromium");
  assert.equal(resolveBrowserExecutable({ env: ENV, exists: () => false, findChromium: () => null }), null);
  assert.equal(resolveBrowserExecutable({ env: ENV, exists: () => false }), null);
});

test("resolveBrowserExecutable: exists が例外を投げる候補は飛ばす", () => {
  const pf86 = winChrome(ENV["PROGRAMFILES(X86)"]);
  const result = resolveBrowserExecutable({
    env: ENV,
    exists: (p) => {
      if (p === winChrome(ENV.PROGRAMFILES)) throw new Error("boom");
      return p === pf86;
    },
  });
  assert.equal(result, pf86);
});

test("chromeCandidates: 未設定の環境変数は候補から落ち、mac の候補は残る", () => {
  const list = chromeCandidates({ PROGRAMFILES: "C:\\PF" });
  assert.deepEqual(list, [winChrome("C:\\PF"), "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]);
});

function fakeContext({ pages }) {
  const listeners = {};
  return {
    closeCalls: 0,
    pages,
    on(event, handler) {
      listeners[event] = handler;
    },
    emit(event) {
      listeners[event]?.();
    },
    async close() {
      this.closeCalls += 1;
    },
  };
}

test("waitForHumanLogin: 人がウィンドウを閉じたら closedByUser=true、close は呼ばない", async () => {
  let calls = 0;
  const context = fakeContext({ pages: () => (++calls === 1 ? [{}] : []) });
  const result = await waitForHumanLogin(context, { sleep: async () => {}, now: () => 0 });
  assert.deepEqual(result, { closedByUser: true });
  assert.equal(context.closeCalls, 0, "waitForHumanLogin が context を閉じてはいけない");
});

test("waitForHumanLogin: close イベントでも closedByUser=true", async () => {
  const context = fakeContext({ pages: () => [{}] });
  let fired = false;
  const sleep = async () => {
    if (!fired) {
      fired = true;
      context.emit("close");
    }
  };
  const result = await waitForHumanLogin(context, { sleep, now: () => 0 });
  assert.deepEqual(result, { closedByUser: true });
  assert.equal(context.closeCalls, 0);
});

test("waitForHumanLogin: タイムアウトでも閉じずに closedByUser=false で返る", async () => {
  const context = fakeContext({ pages: () => [{}] });
  let clock = 0;
  const result = await waitForHumanLogin(context, { timeoutMs: 500, sleep: async () => {}, now: () => (clock += 1000) });
  assert.deepEqual(result, { closedByUser: false });
  assert.equal(context.closeCalls, 0, "タイムアウト時に閉じてはいけない");
});

test("waitForHumanLogin: 既定タイムアウトは 20 分", () => {
  assert.equal(DEFAULT_LOGIN_TIMEOUT_MS, 20 * 60 * 1000);
});

test("verifyLoginCookies / missingLoginCookies: 必須 cookie の有無を判定する", () => {
  const cookies = [
    { name: "c_user", domain: ".facebook.com" },
    { name: "xs", domain: ".facebook.com" },
    { name: "SID", domain: ".google.com" },
  ];
  assert.equal(verifyLoginCookies(cookies, ["c_user", "xs"]), true);
  assert.equal(verifyLoginCookies(cookies, ["c_user", "datr"]), false);
  assert.deepEqual(missingLoginCookies(cookies, ["c_user", "datr"]), ["datr"]);
  assert.deepEqual(missingLoginCookies(null, ["c_user"]), ["c_user"]);
});

test("missingLoginCookies: cookieDomain を渡すと別ドメインの同名校を数えない", () => {
  const cookies = [
    { name: "SID", domain: "example.com" },
    { name: "SID", domain: ".google.com" },
  ];
  assert.deepEqual(missingLoginCookies(cookies, ["SID"], ".google.com"), []);
  assert.deepEqual(missingLoginCookies([{ name: "SID", domain: "example.com" }], ["SID"], ".google.com"), ["SID"]);
  // サブドメインの cookie も親ドメイン要求に一致する
  assert.deepEqual(missingLoginCookies([{ name: "c_user", domain: "www.facebook.com" }], ["c_user"], ".facebook.com"), []);
});

function fakeChromium({ verifyCookies, keepOpen = false, onLaunch = () => {} }) {
  const calls = [];
  const contexts = [];
  const page = { async goto() {} };
  const chromium = {
    async launchPersistentContext(_dir, options) {
      calls.push(options);
      // 1回目の pages() は画面取得用。以降は人が閉じた(空)か、keepOpen なら開いたまま。
      let pageCalls = 0;
      const context =
        options.headless === false
          ? fakeContext({ pages: () => (++pageCalls === 1 || keepOpen ? [page] : []) })
          : {
              closeCalls: 0,
              async cookies() {
                return typeof verifyCookies === "function" ? verifyCookies() : verifyCookies;
              },
              async close() {
                this.closeCalls += 1;
              },
            };
      contexts.push(context);
      onLaunch(options, context);
      return context;
    },
  };
  return { chromium, calls, contexts };
}

test("runHumanLogin: 正規版 Chrome を headless:false で開き、人が閉じたら検証して 0", async () => {
  const logs = [];
  const { chromium, calls, contexts } = fakeChromium({
    verifyCookies: [
      { name: "c_user", domain: ".facebook.com" },
      { name: "xs", domain: ".facebook.com" },
    ],
  });
  const result = await runHumanLogin({
    chromium,
    profileDir: "/tmp/profile",
    url: "https://www.facebook.com/messages/",
    requiredCookies: ["c_user", "xs"],
    cookieDomain: ".facebook.com",
    deps: { executablePath: "/fake/chrome", log: (m) => logs.push(m), sleep: async () => {}, now: () => 0 },
  });
  assert.equal(result.code, 0);
  assert.equal(result.closedByUser, true);
  assert.deepEqual(result.missing, []);
  assert.equal(calls[0].headless, false);
  assert.equal(calls[0].executablePath, "/fake/chrome");
  assert.deepEqual(calls[0].ignoreDefaultArgs, ["--no-sandbox"]);
  assert.equal(calls[1].headless, true);
  assert.ok(logs.some((line) => line.includes("こちらからは閉じません")));
  assert.ok(logs.some((line) => line === "OK: ログインを保存しました"));
  // 人のログイン画面は閉じない。自分が開いた検証用 context だけ閉じる。
  assert.equal(contexts[0].closeCalls, 0, "ログイン用ウィンドウを閉じてはいけない");
  assert.equal(contexts[1].closeCalls, 1, "検証用 headless context は閉じる");
});

test("runHumanLogin: cookie 不足なら 3 と不足名を出す", async () => {
  const logs = [];
  const { chromium, contexts } = fakeChromium({ verifyCookies: [{ name: "xs", domain: ".facebook.com" }] });
  const result = await runHumanLogin({
    chromium,
    profileDir: "/tmp/profile",
    url: "https://www.facebook.com/messages/",
    requiredCookies: ["c_user", "xs"],
    cookieDomain: ".facebook.com",
    deps: { executablePath: "/fake/chrome", log: (m) => logs.push(m), sleep: async () => {}, now: () => 0 },
  });
  assert.equal(result.code, 3);
  assert.deepEqual(result.missing, ["c_user"]);
  assert.ok(logs.some((line) => line.includes("ERROR: ログインが保存されていません") && line.includes("c_user")));
  assert.equal(contexts[0].closeCalls, 0);
});

test("runHumanLogin: 人が閉じなければ検証せず 5、ブラウザは閉じない", async () => {
  const logs = [];
  const { chromium, calls, contexts } = fakeChromium({ verifyCookies: [], keepOpen: true });
  let clock = 0;
  const result = await runHumanLogin({
    chromium,
    profileDir: "/tmp/profile",
    url: "https://www.facebook.com/messages/",
    requiredCookies: ["c_user"],
    deps: { executablePath: "/fake/chrome", log: (m) => logs.push(m), sleep: async () => {}, now: () => (clock += 1000) },
  });
  assert.equal(result.code, 5);
  assert.equal(result.closedByUser, false);
  assert.equal(calls.length, 1, "タイムアウト時は同じ profile を開き直さない");
  assert.equal(contexts[0].closeCalls, 0, "タイムアウト時もブラウザを閉じない");
  assert.ok(logs.some((line) => line.includes("タイムアウト")));
});

test("runHumanLogin: Chrome が無ければ 4 を返して起動しない", async () => {
  const logs = [];
  let launches = 0;
  const result = await runHumanLogin({
    chromium: { async launchPersistentContext() { launches += 1; return fakeContext({ pages: () => [] }); } },
    profileDir: "/tmp/profile",
    url: "https://example.com/",
    requiredCookies: ["SID"],
    cookieDomain: ".google.com",
    deps: { env: {}, exists: () => false, findChromium: () => null, log: (m) => logs.push(m) },
  });
  assert.equal(result.code, 4);
  assert.equal(launches, 0);
  assert.ok(logs.some((line) => line.includes("見つかりません")));
});

test("runHumanLogin: playwright-core が無ければ 4 を返す", async () => {
  const logs = [];
  const result = await runHumanLogin({
    chromium: null,
    profileDir: "/tmp/profile",
    url: "https://example.com/",
    requiredCookies: ["SID"],
    deps: { executablePath: "/fake/chrome", log: (m) => logs.push(m) },
  });
  assert.equal(result.code, 4);
  assert.ok(logs.some((line) => line.includes("playwright-core")));
});
