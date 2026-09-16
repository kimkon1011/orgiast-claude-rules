// Google ログイン付きページ取得。playwright-core は動的 import（未インストールでも
// node --test/--check がここで落ちないように、main() 実行時にだけ解決する）。
// 事前準備: npm install playwright-core && npx playwright install chromium
import { readdirSync, existsSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { isEntry } from "./is-entry.mjs";

export function parseArgs(argv) {
  const args = { url: null, login: false, json: false, links: false, out: null, timeout: 60000 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--login") {
      args.login = true;
    } else if (arg === "--json") {
      args.json = true;
    } else if (arg === "--links") {
      args.links = true;
    } else if (arg === "--out") {
      args.out = argv[++i] || null;
    } else if (arg === "--timeout") {
      const val = parseInt(argv[++i], 10);
      if (!isNaN(val)) args.timeout = val;
    } else if (!arg.startsWith("-")) {
      args.url = arg;
    }
  }
  return args;
}

export function isLoginUrl(u) {
  return typeof u === "string" && (u.includes("accounts.google.com") || u.includes("ServiceLogin"));
}

export function findChromium(baseDir, readdirFn = readdirSync, existsFn = existsSync) {
  if (!baseDir) return null;
  let entries;
  try {
    entries = readdirFn(baseDir, { withFileTypes: true });
  } catch {
    return null;
  }
  const chromiumDirs = entries
    .filter((e) => (typeof e.isDirectory === "function" ? e.isDirectory() : Boolean(e.isDirectory)) && e.name.startsWith("chromium-"))
    .map((e) => e.name)
    .sort((a, b) => b.localeCompare(a));

  for (const dir of chromiumDirs) {
    const base = path.join(baseDir, dir);
    // Playwright のバージョンによって配置が変わる(実測: 1228 は chrome-win64)。既知の候補を全部見る。
    const candidates = [
      path.join(base, "chrome-win64", "chrome.exe"),
      path.join(base, "chrome-win", "chrome.exe"),
      path.join(base, "chrome-mac-arm64", "Chromium.app", "Contents", "MacOS", "Chromium"),
      path.join(base, "chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"),
      path.join(base, "chrome-linux64", "chrome"),
      path.join(base, "chrome-linux", "chrome")
    ];
    for (const p of candidates) {
      try {
        if (existsFn(p)) return p;
      } catch {
        // ignore
      }
    }
  }
  return null;
}

function getBrowsersBaseDir() {
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) return process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (process.platform === "win32") {
    return process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "ms-playwright") : null;
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Caches", "ms-playwright");
  }
  return path.join(os.homedir(), ".cache", "ms-playwright");
}

async function main() {
  const { chromium } = await import("playwright-core");
  const args = parseArgs(process.argv.slice(2));
  const baseDir = getBrowsersBaseDir();
  const executablePath = findChromium(baseDir);
  const profileDir = path.join(os.homedir(), ".claude", "google-profile");

  if (!executablePath) {
    console.error("Chromium が見つかりません。npx playwright install chromium を実行してください");
    process.exit(4);
  }

  if (!args.url && !args.login) {
    console.error("使い方: node gpage-fetch.mjs <url> [--json] [--links] [--out path] [--timeout ms]");
    console.error("        node gpage-fetch.mjs --login");
    process.exit(2);
  }

  let context = null;
  let code = 0;
  try {
    if (args.login) {
      context = await chromium.launchPersistentContext(profileDir, {
        headless: false,
        executablePath,
      });
      const page = context.pages()[0] || (await context.newPage());
      await page.goto("https://accounts.google.com/", { waitUntil: "networkidle", timeout: 60000 });
      const start = Date.now();
      while (Date.now() - start < 15 * 60 * 1000) {
        await new Promise((r) => setTimeout(r, 30000));
        const currentUrl = page.url();
        if (!isLoginUrl(currentUrl)) {
          console.log("ログインを保存しました");
          return;
        }
        try {
          await page.goto("https://myaccount.google.com/", { waitUntil: "networkidle", timeout: 60000 });
        } catch {
          // ignore
        }
      }
      console.error("ログインが完了しませんでした。タイムアウトしました");
      code = 5;
      return;
    } else {
      context = await chromium.launchPersistentContext(profileDir, {
        headless: true,
        executablePath,
      });
      const page = context.pages()[0] || (await context.newPage());
      await page.goto(args.url, { waitUntil: "networkidle", timeout: args.timeout });
      const finalUrl = page.url();
      if (isLoginUrl(finalUrl)) {
        console.error("未ログインです。先に node tools/gpage-fetch.mjs --login を実行してください");
        code = 3;
        return;
      }
      const text = await page.evaluate(() => {
        const main = document.querySelector("[role=main]");
        const mainText = main ? main.innerText.trim() : "";
        // 見出しだけのハブページでは [role=main] が数十文字しか返らないので body に落とす
        const raw = mainText.length >= 100 ? mainText : document.body.innerText;
        return raw.replace(/\n{3,}/g, "\n\n").trim();
      });
      const links = args.links
        ? await page.evaluate(() =>
            Array.from(document.querySelectorAll("a[href]"))
              .map((a) => ({ text: a.innerText.trim(), href: a.href }))
              .filter((l) => l.href.startsWith("http"))
          )
        : null;
      const title = await page.title();
      let output;
      if (args.json) {
        output = JSON.stringify({ url: finalUrl, title, text, ...(links ? { links } : {}) }, null, 2);
      } else if (args.links) {
        const seen = new Set();
        output = links
          .filter((l) => (seen.has(l.href) ? false : seen.add(l.href)))
          .map((l) => l.text + "\t" + l.href)
          .join("\n");
      } else {
        output = text;
      }
      if (args.out) {
        writeFileSync(args.out, output, "utf8");
        console.log(args.out);
      } else {
        console.log(output);
      }
      return;
    }
  } catch (err) {
    console.error("エラー:", err.message || err);
    code = 1;
  } finally {
    if (context) {
      try {
        await context.close();
      } catch {
        // ignore
      }
    }
  }
  process.exit(code);
}

if (isEntry(import.meta.url)) {
  main();
}
