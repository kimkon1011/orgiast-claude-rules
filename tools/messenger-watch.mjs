#!/usr/bin/env node
// kim の個人 Facebook Messenger の未読を、ログイン済みの専用ブラウザプロファイルで
// 「読むだけ」で取得し、新着を kim に Discord DM で通知する。
// 公式 API は無いため、gpage-fetch.mjs と同じ playwright-core の persistent context を使う。
// playwright-core は動的 import（未インストールでも node --test/--check がここで落ちないように）。
// 事前準備: npm install playwright-core && npx playwright install chromium
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { readdirSync, existsSync } from "node:fs";
import { isEntry } from "./is-entry.mjs";
import { notifyKim } from "./notify-kim.mjs";
import { resolveBrowserExecutable, runHumanLogin } from "./lib/human-login.mjs";

export const MESSAGES_URL = "https://www.facebook.com/messages/";
export const MAX_SEEN = 500;
export const SNIPPET_LIMIT = 80;

export function parseArgs(argv) {
  const args = { login: false, dryRun: false };
  for (const arg of argv) {
    if (arg === "--login") args.login = true;
    else if (arg === "--dry-run") args.dryRun = true;
  }
  return args;
}

// ログイン画面へリダイレクトされたか。URL に login を含む / パスワード欄がある、のいずれか。
export function isLoginUrl(url, hasPasswordField = false) {
  if (hasPasswordField) return true;
  return typeof url === "string" && (/(^|[/.])login([/?#.]|$)/i.test(url) || /\/(checkpoint|two_step_verification)(\/|\?|$)/i.test(url));
}

// 会話一覧の1行から未読かどうかを判定する。aria-label・太字・「未読」表示のいずれか。
export function isUnread(row) {
  if (!row) return false;
  const aria = String(row.ariaLabel ?? "");
  if (/unread|未読/i.test(aria)) return true;
  if (row.bold === true) return true;
  const text = String(row.text ?? "");
  if (/(^|\s)(unread|未読)(\s|$)/i.test(text)) return true;
  return false;
}

// href を正規化する。クエリ・ハッシュを落とし、末尾スラッシュを揃える。
export function normalizeHref(href) {
  if (typeof href !== "string" || href.length === 0) return "";
  let value = href;
  try {
    const parsed = new URL(href, "https://www.facebook.com");
    value = parsed.pathname;
  } catch {
    value = href.split(/[?#]/)[0];
  }
  value = value.split(/[?#]/)[0];
  if (!value.startsWith("/")) value = `/${value}`;
  if (!value.endsWith("/")) value = `${value}/`;
  return value;
}

// 会話一覧の行配列から未読の会話だけを抽出する純粋関数。
// rows = [{ href, text, ariaLabel, bold }]
export function parseConversations(rows) {
  if (!Array.isArray(rows)) return [];
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    if (!row || !isUnread(row)) continue;
    const href = normalizeHref(row.href);
    if (!href || !href.includes("/messages/t/")) continue;
    if (seen.has(href)) continue;
    seen.add(href);
    const text = String(row.text ?? "").replace(/\s+/g, " ").trim();
    const { name, snippet, time } = splitConversationText(text);
    out.push({ href, name, snippet, time });
  }
  return out;
}

// 会話行のテキストを「名前 / 抜粋 / 時刻」に分解する。
// Facebook の行は「名前 時刻 抜粋」または「名前 抜粋 時刻」の順で並ぶことが多い。
export function splitConversationText(text) {
  const raw = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!raw) return { name: "", snippet: "", time: "" };
  const timePattern = /(?:^|\s)(\d{1,2}:\d{2}(?:\s?[APap]\.?[Mm]\.?)?|(?:昨日|きのう|昨日|月曜日|火曜日|水曜日|木曜日|金曜日|土曜日|日曜日|Mon|Tue|Wed|Thu|Fri|Sat|Sun)(?:\s|$))/;
  const match = raw.match(timePattern);
  let time = "";
  let rest = raw;
  if (match) {
    time = match[1].trim();
    rest = (raw.slice(0, match.index) + " " + raw.slice(match.index + match[0].length)).replace(/\s+/g, " ").trim();
  }
  // 先頭のオンライン表示はアバターのバッジで、会話名ではない(2026-10-10 実測で name=オンライン中 になった)。
  rest = rest.replace(/^(?:オンライン中|Active now|アクティブ(?:中)?)\s*/i, "");
  // 未読行は「<会話名> 未読メッセージ: <送信者>: <本文> · 2時間」。マーカーで区切れば空白入りの会話名も壊れない。
  const unreadMarker = rest.match(/\s*(?:未読メッセージ|Unread message)\s*[:：]\s*/i);
  if (unreadMarker) {
    const name = rest.slice(0, unreadMarker.index).trim();
    const snippet = rest.slice(unreadMarker.index + unreadMarker[0].length).replace(/\s*·\s*\d+\s*(?:分|時間|日|週|[mhdw])$/i, "").trim();
    return { name, snippet, time };
  }
  const parts = rest.split(" ").filter(Boolean);
  const name = parts.shift() ?? "";
  const snippet = parts.join(" ").trim();
  return { name, snippet, time };
}

export function clipSnippet(text, limit = SNIPPET_LIMIT) {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}

// 通知済みキー。href と snippet のハッシュ。
export function conversationKey(conversation) {
  const href = normalizeHref(conversation?.href);
  const snippet = String(conversation?.snippet ?? "");
  return createHash("sha256").update(`${href}\n${snippet}`).digest("hex").slice(0, 32);
}

// 新着だけを残す。既読キーに無いものだけ返す。
export function selectNew(conversations, seenKeys) {
  const seen = seenKeys instanceof Set ? seenKeys : new Set(seenKeys ?? []);
  return (Array.isArray(conversations) ? conversations : []).filter((c) => !seen.has(conversationKey(c)));
}

// 既読キーを最大 MAX_SEEN 件に保つ（古いものから捨てる）。
export function trimSeen(keys, max = MAX_SEEN) {
  const list = Array.isArray(keys) ? keys : [...(keys ?? [])];
  return list.length <= max ? list : list.slice(list.length - max);
}

// 新着を1通の通知本文にまとめる。新着0件なら null。
export function formatNotification(conversations) {
  const list = Array.isArray(conversations) ? conversations : [];
  if (list.length === 0) return null;
  const lines = [`📩 Messenger 新着 ${list.length}件`];
  for (const c of list) {
    const name = String(c?.name ?? "").trim() || "(名前不明)";
    lines.push(`・${name}: ${clipSnippet(c?.snippet)}`);
  }
  return lines.join("\n");
}

function readState(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (parsed && Array.isArray(parsed.seen)) return parsed;
  } catch {
    // 無い/壊れている場合は初期状態から始める。
  }
  return { seen: [], loginNotifiedAt: null };
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
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

// gpage-fetch.mjs と同じ探索。Playwright のバージョンで配置が変わるため既知の候補を全部見る。
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
    const candidates = [
      path.join(base, "chrome-win64", "chrome.exe"),
      path.join(base, "chrome-win", "chrome.exe"),
      path.join(base, "chrome-mac-arm64", "Chromium.app", "Contents", "MacOS", "Chromium"),
      path.join(base, "chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"),
      path.join(base, "chrome-linux64", "chrome"),
      path.join(base, "chrome-linux", "chrome"),
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

// ページから会話一覧の行を集める。セレクタに依存しすぎないよう、
// 会話リンク(a[href*="/messages/t/"])を起点に、太字・aria-label・テキストを拾う。
export async function collectRows(page) {
  return page.evaluate(() => {
    const anchors = Array.from(document.querySelectorAll('a[href*="/messages/t/"]'));
    return anchors.map((a) => {
      const container = a.closest('[role="gridcell"], [role="listitem"], li, div') || a;
      const text = (container.innerText || a.innerText || "").trim();
      let bold = false;
      const nodes = [a, ...Array.from(container.querySelectorAll("span, div"))].slice(0, 40);
      for (const node of nodes) {
        try {
          const weight = window.getComputedStyle(node).fontWeight;
          if (weight && (weight === "bold" || parseInt(weight, 10) >= 600)) {
            bold = true;
            break;
          }
        } catch {
          // ignore
        }
      }
      return {
        href: a.getAttribute("href") || "",
        text,
        ariaLabel: a.getAttribute("aria-label") || container.getAttribute("aria-label") || "",
        bold,
      };
    });
  });
}

async function hasPasswordField(page) {
  try {
    return await page.evaluate(() => Boolean(document.querySelector('input[type="password"]')));
  } catch {
    return false;
  }
}

function randomDelayMs(minMs, maxMs) {
  return minMs + Math.floor(Math.random() * (maxMs - minMs + 1));
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const args = parseArgs(argv);
  const home = deps.home ?? process.env.ORGIAST_HOME ?? os.homedir();
  const stdout = deps.stdout ?? console.log;
  const stderr = deps.stderr ?? console.error;
  const now = deps.now ?? Date.now;
  const notify = deps.notify ?? notifyKim;
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const profileDir = deps.profileDir ?? path.join(home, ".claude", "messenger-profile");
  const stateFile = deps.stateFile ?? path.join(home, ".claude", "messenger-watch-state.json");

  let chromium = deps.chromium;
  if (!chromium) {
    try {
      ({ chromium } = await import("playwright-core"));
    } catch {
      stderr("messenger-watch: playwright-core が見つかりません。npm install playwright-core を実行してください");
      return 4;
    }
  }
  // 正規版 Chrome を優先する。Playwright 同梱 Chromium は playwright-core と revision がずれると
  // ログイン後の遷移でブラウザごと落ちた(2026-10-10 実測: 1.58 + chromium-1243 でログイン画面が消えた)。
  // 解決は lib/human-login.mjs に一本化(PF → PF86 → LOCALAPPDATA → mac → 同梱 Chromium)。
  const executablePath = deps.executablePath ?? resolveBrowserExecutable({ findChromium: () => findChromium(getBrowsersBaseDir()) });
  if (!executablePath) {
    stderr("messenger-watch: Chromium が見つかりません。npx playwright install chromium を実行してください");
    return 4;
  }

  if (args.login) {
    // 人がログインする一連の流れは lib/human-login.mjs に一本化(ツール側からは絶対に閉じない)。
    // 2段階認証(checkpoint)の途中を「ログイン済み」と誤判定して閉じた実害の再発防止(2026-10-10)。
    const result = await runHumanLogin({
      chromium,
      profileDir,
      url: MESSAGES_URL,
      requiredCookies: ["c_user", "xs"],
      cookieDomain: ".facebook.com",
      deps: { log: stdout, sleep },
    });
    return result.code;
  }

  let context = null;
  try {
    context = await chromium.launchPersistentContext(profileDir, { headless: true, executablePath });
    const page = context.pages()[0] || (await context.newPage());
    await page.goto(MESSAGES_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    // 読み取りのみ。ページ読込後 3〜8 秒のランダム待機でレンダリングを待つ。
    await sleep(randomDelayMs(3000, 8000));

    const url = page.url();
    if (isLoginUrl(url, await hasPasswordField(page))) {
      const state = readState(stateFile);
      const today = new Date(now()).toISOString().slice(0, 10);
      if (!args.dryRun && state.loginNotifiedAt !== today) {
        await notify("Messenger監視: ログインが切れています。再ログインが必要", { home });
        state.loginNotifiedAt = today;
        writeJson(stateFile, state);
      }
      stderr("messenger-watch: ログインが切れています。node tools/messenger-watch.mjs --login を実行してください");
      return 2;
    }

    const rows = await collectRows(page);
    const conversations = parseConversations(rows);

    if (args.dryRun) {
      stdout(JSON.stringify(conversations, null, 2));
      return 0;
    }

    const state = readState(stateFile);
    const seen = new Set(state.seen);
    const fresh = selectNew(conversations, seen);
    if (fresh.length > 0) {
      const body = formatNotification(fresh);
      if (body) await notify(body, { home });
      for (const c of fresh) seen.add(conversationKey(c));
      state.seen = trimSeen([...seen]);
      writeJson(stateFile, state);
    }
    return 0;
  } catch (err) {
    stderr(`messenger-watch: 実行失敗 (${err?.message ?? err})`);
    return 1;
  } finally {
    if (context) {
      try {
        await context.close();
      } catch {
        // ignore
      }
    }
  }
}

if (isEntry(import.meta.url)) process.exitCode = await main();
