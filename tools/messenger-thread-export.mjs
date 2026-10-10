#!/usr/bin/env node
// 1つの Messenger スレッドの過去ログを、ログイン済みの専用ブラウザプロファイル(headless)で
// 先頭まで遡って取得し、JSONL でローカル保存する。
// 読み取りのみ: 入力・送信・リアクション・クリック・キーボード操作は一切しない(スクロールだけ)。
// 公式 API は無いため、messenger-watch.mjs と同じ playwright-core の persistent context を使う。
// playwright-core は動的 import(未インストールでも node --test/--check がここで落ちないように)。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { readdirSync, existsSync } from "node:fs";
import { isEntry } from "./is-entry.mjs";
import { isLoginUrl } from "./messenger-watch.mjs";
import { resolveBrowserExecutable } from "./lib/human-login.mjs";

export const MESSAGES_BASE_URL = "https://www.facebook.com/messages/t/";
export const DEFAULT_MAX_SCROLLS = 2000;
export const STAGNANT_LIMIT = 5; // 5 回連続で件数が増えなければ先頭到達とみなす
export const SAVE_EVERY_SCROLLS = 50; // 途中保存の間隔
export const MAX_RUNTIME_MS = 90 * 60 * 1000; // 1実行の上限 90 分
export const MIN_WAIT_MS = 2000;
export const MAX_WAIT_MS = 5000;
export const THREAD_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

// 時刻らしい表記。空白境界を要求して、本文中の「昨日会った」のような語を時刻と誤認しない。
// 時計時刻(12:34)を優先し、無ければ「昨日/火曜日」のような相対表記を使う。
export const CLOCK_PATTERN = /(?:^|\s)(\d{1,2}:\d{2}(?:\s?[APap]\.?[Mm]\.?)?)(?=\s|$)/;
export const DAY_PATTERN =
  /(?:^|\s)(昨日|今日|月曜日|火曜日|水曜日|木曜日|金曜日|土曜日|日曜日|Mon|Tue|Wed|Thu|Fri|Sat|Sun)(?=\s|$)/;

export function parseArgs(argv) {
  const args = { threadId: "", maxScrolls: DEFAULT_MAX_SCROLLS, out: null, error: null };
  const list = Array.isArray(argv) ? argv : [];
  for (let i = 0; i < list.length; i += 1) {
    const arg = String(list[i] ?? "");
    if (arg === "--max-scrolls" || arg.startsWith("--max-scrolls=")) {
      const raw = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : String(list[i + 1] ?? "");
      const value = Number.parseInt(raw, 10);
      if (!/^\d+$/.test(raw.trim()) || !Number.isFinite(value) || value <= 0) {
        args.error = "--max-scrolls には正の整数を指定してください";
        return args;
      }
      args.maxScrolls = value;
      if (!arg.includes("=")) i += 1;
    } else if (arg === "--out" || arg.startsWith("--out=")) {
      const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : String(list[i + 1] ?? "");
      if (!value) {
        args.error = "--out には出力先のパスを指定してください";
        return args;
      }
      args.out = value;
      if (!arg.includes("=")) i += 1;
    } else if (arg.startsWith("-")) {
      args.error = `不明なオプション: ${arg}`;
      return args;
    } else if (!args.threadId) {
      args.threadId = arg;
    } else {
      args.error = `引数が多すぎます: ${arg}`;
      return args;
    }
  }
  if (!args.threadId) {
    args.error = "スレッドIDを指定してください (例: node tools/messenger-thread-export.mjs 1234567890)";
    return args;
  }
  if (!THREAD_ID_PATTERN.test(args.threadId)) {
    args.error = `スレッドIDが不正です: ${args.threadId}`;
    return args;
  }
  return args;
}

export function threadUrl(threadId) {
  return `${MESSAGES_BASE_URL}${encodeURIComponent(String(threadId ?? ""))}/`;
}

export function defaultOutPath(home, threadId) {
  return path.join(home, ".claude", "messenger-export", `${threadId}.jsonl`);
}

export function normalizeText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

// aria-label の先頭に付く種別ラベルを落とす("メッセージ: こんにちは" / "Message, hello")。
export function stripAriaPrefix(value) {
  return normalizeText(value).replace(/^(?:メッセージ|メッセージを送信|Message|Entry|エントリ|チャット|Chat)\s*[:：,、]\s*/i, "");
}

export function extractTime(value) {
  const text = normalizeText(value);
  if (!text) return "";
  const clock = text.match(CLOCK_PATTERN);
  if (clock) return clock[1].trim();
  const day = text.match(DAY_PATTERN);
  return day ? day[1].trim() : "";
}

// 重複除去のキー。仕様どおり sender+text+time のハッシュ。
// 同じ人が同じ本文を同じ時刻表記で2回送った場合は同一キーになる(1件に丸まる)。
export function messageKey(sender, text, time) {
  return createHash("sha256")
    .update(`${normalizeText(sender)}\n${normalizeText(text)}\n${normalizeText(time)}`)
    .digest("hex")
    .slice(0, 32);
}

// ページから取った行配列を { key, sender, text, time } に整形する純粋関数。
// rows = [{ sender, text, time, ariaLabel }]
//   sender : 行内の送信者名見出し(無い行は空。直前の送信者を継承する)
//   text   : 行の innerText(送信者名見出しを含むことがある)
//   time   : <time datetime> 等から取った時刻
//   ariaLabel: 行の aria-label(本文が取れない行のフォールバック)
export function parseMessageRows(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const out = [];
  const seen = new Set();
  let lastSender = "";
  for (const row of list) {
    if (!row || typeof row !== "object") continue;
    const aria = normalizeText(row.ariaLabel);
    const explicitSender = normalizeText(row.sender);
    let text = normalizeText(row.text);
    if (text) {
      // innerText は送信者名の見出しも含むので、先頭一致した分だけ本文から外す。
      if (explicitSender && text.startsWith(explicitSender)) text = text.slice(explicitSender.length).trim();
    } else {
      text = stripAriaPrefix(aria);
      if (explicitSender && text.startsWith(explicitSender)) text = text.slice(explicitSender.length).trim();
    }
    const time = normalizeText(row.time) || extractTime(aria) || extractTime(text);
    // 時刻表記が本文の末尾に混ざっている時だけ取り除く(本文中の時刻は壊さない)。
    if (time && text.endsWith(time)) text = text.slice(0, text.length - time.length).trim();
    if (!text) continue;
    const sender = explicitSender || lastSender;
    if (explicitSender) lastSender = explicitSender;
    const key = messageKey(sender, text, time);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ key, sender, text, time });
  }
  return out;
}

// キーで重複を落としつつ順序を保つ。
export function dedupeMessages(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const seen = new Set();
  const out = [];
  for (const m of list) {
    if (!m || seen.has(m.key)) continue;
    seen.add(m.key);
    out.push(m);
  }
  return out;
}

// 既知の一覧(古い→新しい)に、今回の DOM スナップショット(古い→新しい)を統合する。
// 未知のメッセージは「スナップショットで次に現れる既知メッセージの直前」に置く。
// これで、上スクロールで読み込んだ古いメッセージは先頭に、取得中に届いた新着は末尾に入る。
export function mergeMessages(existing, snapshot) {
  const base = Array.isArray(existing) ? existing : [];
  const snap = Array.isArray(snapshot) ? snapshot : [];
  if (snap.length === 0) return base.slice();
  if (base.length === 0) return dedupeMessages(snap);
  const baseIndex = new Map();
  base.forEach((m, i) => {
    if (m && m.key !== undefined && !baseIndex.has(m.key)) baseIndex.set(m.key, i);
  });
  const out = base.slice();
  const known = new Set(baseIndex.keys());
  let shift = 0; // ここまでに挿入した件数(挿入位置のずれ)
  for (let i = 0; i < snap.length; i += 1) {
    const message = snap[i];
    if (!message || known.has(message.key)) continue;
    let at = out.length; // 後ろに既知が無い = 新着なので末尾
    for (let j = i + 1; j < snap.length; j += 1) {
      const later = snap[j];
      if (later && baseIndex.has(later.key)) {
        at = baseIndex.get(later.key) + shift;
        break;
      }
    }
    out.splice(at, 0, message);
    known.add(message.key);
    shift += 1;
  }
  return out;
}

// スクロール終了判定の状態機械。件数が stagnantLimit 回連続で増えなければ先頭到達とみなす。
export function createScrollTracker({ stagnantLimit = STAGNANT_LIMIT, maxScrolls = DEFAULT_MAX_SCROLLS } = {}) {
  let best = 0;
  let stagnant = 0;
  let scrolls = 0;
  return {
    record(count) {
      const value = Number.isFinite(count) ? count : 0;
      scrolls += 1;
      if (value > best) {
        best = value;
        stagnant = 0;
      } else {
        stagnant += 1;
      }
      if (scrolls >= maxScrolls) return { stop: true, reason: "max-scrolls", scrolls, stagnant, count: best };
      if (stagnant >= stagnantLimit) return { stop: true, reason: "top-reached", scrolls, stagnant, count: best };
      return { stop: false, reason: null, scrolls, stagnant, count: best };
    },
    get state() {
      return { scrolls, stagnant, count: best };
    },
  };
}

export function toJsonl(messages) {
  const list = Array.isArray(messages) ? messages : [];
  if (list.length === 0) return "";
  return `${list.map((m) => JSON.stringify({ time: m.time, sender: m.sender, text: m.text, key: m.key })).join("\n")}\n`;
}

export function writeJsonl(file, messages) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temp, toJsonl(messages), { mode: 0o600 });
  fs.renameSync(temp, file);
}

export function formatSummary(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const first = list[0]?.time || "(時刻不明)";
  const last = list[list.length - 1]?.time || "(時刻不明)";
  return `messenger-thread-export: ${list.length}件 保存 (先頭: ${first} / 末尾: ${last})`;
}

function randomDelayMs(minMs, maxMs, random = Math.random) {
  return minMs + Math.floor(random() * (maxMs - minMs + 1));
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

// messenger-watch.mjs と同じ探索(Playwright のバージョンで配置が変わるため既知の候補を全部見る)。
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

async function hasPasswordField(page) {
  try {
    return await page.evaluate(() => Boolean(document.querySelector('input[type="password"]')));
  } catch {
    return false;
  }
}

// メッセージ一覧の行を取る。セレクタに依存しすぎないよう [role="row"](無ければ gridcell)を使い、
// 送信者名見出し・時刻・本文を分けて返す。
export async function collectMessageRows(page) {
  return page.evaluate(() => {
    const norm = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
    const main = document.querySelector('[role="main"]') || document.body;
    // 実測(2026-10-10): 各メッセージは aria-label「HH:MMに<送信者>が送信したメッセージ: <本文>を入力」を持つ。
    // これが最も安定しているので最優先で使う。
    const labelled = Array.from(main.querySelectorAll('[aria-label*="が送信したメッセージ"], [aria-label*=" sent a message"]'));
    if (labelled.length > 0) {
      const re = /^(?:(.+?)に)?(.+?)が送信したメッセージ[:：]\s*([\s\S]*?)(?:を入力)?$/;
      return labelled
        .map((node) => {
          const raw = String(node.getAttribute("aria-label") ?? "");
          const m = raw.match(re);
          if (!m) return { sender: "", time: "", text: "", ariaLabel: norm(raw) };
          return { sender: norm(m[2]), time: norm(m[1] ?? ""), text: String(m[3]).trim(), ariaLabel: "" };
        })
        .filter((row) => row.text || row.ariaLabel);
    }
    let nodes = Array.from(main.querySelectorAll('[role="row"]'));
    if (nodes.length === 0) nodes = Array.from(main.querySelectorAll('[role="gridcell"]'));
    return nodes
      .map((node) => {
        const heading = node.querySelector('[role="heading"], h1, h2, h3, h4, h5');
        const timeNode = node.querySelector('time, [role="time"]');
        return {
          sender: norm(heading ? heading.innerText : ""),
          time: norm(
            timeNode
              ? timeNode.getAttribute("datetime") || timeNode.getAttribute("title") || timeNode.innerText
              : "",
          ),
          text: norm(node.innerText),
          ariaLabel: norm(node.getAttribute("aria-label")),
        };
      })
      .filter((row) => row.text || row.ariaLabel);
  });
}

// [role="main"] の中で最も縦に長いスクロール要素を先頭まで戻す(これで古いメッセージが読み込まれる)。
// 返り値の件数はそのまま「読み込まれた行数」の判定には使わず、次の collect の結果を使う。
export async function scrollMessagesToTop(page) {
  return page.evaluate(() => {
    const main = document.querySelector('[role="main"]') || document.body;
    let target = null;
    for (const el of Array.from(main.querySelectorAll("*"))) {
      // 長文メッセージのボタン(clientHeight 24 で中身が溢れているだけ)を掴まないよう、実際にスクロールする要素だけ。
      const oy = getComputedStyle(el).overflowY;
      if ((oy !== "auto" && oy !== "scroll") || el.clientHeight < 200) continue;
      if (el.scrollHeight > el.clientHeight + 20 && (!target || el.scrollHeight > target.scrollHeight)) {
        target = el;
      }
    }
    if (!target) return { scrolled: false };
    target.scrollTop = 0;
    return { scrolled: true, scrollHeight: target.scrollHeight };
  });
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const args = parseArgs(argv);
  const stdout = deps.stdout ?? console.log;
  const stderr = deps.stderr ?? console.error;
  const home = deps.home ?? process.env.ORGIAST_HOME ?? os.homedir();
  const now = deps.now ?? Date.now;
  const random = deps.random ?? Math.random;
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const profileDir = deps.profileDir ?? path.join(home, ".claude", "messenger-profile");
  const outFile = deps.outFile ?? args.out ?? defaultOutPath(home, args.threadId || "unknown");

  if (args.error) {
    stderr(`messenger-thread-export: ${args.error}`);
    return 1;
  }

  let chromium = deps.chromium;
  if (!chromium) {
    try {
      ({ chromium } = await import("playwright-core"));
    } catch {
      stderr("messenger-thread-export: playwright-core が見つかりません。npm install playwright-core を実行してください");
      return 4;
    }
  }
  // 正規版 Chrome を優先する(Playwright 同梱 Chromium は revision ずれで落ちた実績がある)。
  const executablePath = deps.executablePath ?? resolveBrowserExecutable({ findChromium: () => findChromium(getBrowsersBaseDir()) });
  if (!executablePath) {
    stderr("messenger-thread-export: Chromium が見つかりません。npx playwright install chromium を実行してください");
    return 4;
  }

  let context = null;
  try {
    context = await chromium.launchPersistentContext(profileDir, { headless: true, executablePath });
    const page = context.pages()[0] || (await context.newPage());
    await page.goto(threadUrl(args.threadId), { waitUntil: "domcontentloaded", timeout: 60000 });
    // 読み取りのみ。レンダリングを待つ(3〜8 秒のランダム待機)。
    await sleep(randomDelayMs(3000, 8000, random));

    if (isLoginUrl(page.url(), await hasPasswordField(page))) {
      // ログイン切れは通知しない(取得できないだけ)。呼び出し側が exit 2 で判断する。
      stderr("messenger-thread-export: ログインが切れています。node tools/messenger-watch.mjs --login を実行してください");
      return 2;
    }

    const tracker = createScrollTracker({ maxScrolls: args.maxScrolls });
    const startedAt = now();
    let messages = [];
    let reason = null;
    let scrolls = 0;
    for (;;) {
      await scrollMessagesToTop(page);
      await sleep(randomDelayMs(MIN_WAIT_MS, MAX_WAIT_MS, random));
      messages = mergeMessages(messages, parseMessageRows(await collectMessageRows(page)));
      const decision = tracker.record(messages.length);
      scrolls = decision.scrolls;
      if (scrolls % SAVE_EVERY_SCROLLS === 0) writeJsonl(outFile, messages);
      if (decision.stop) {
        reason = decision.reason;
        break;
      }
      if (now() - startedAt >= MAX_RUNTIME_MS) {
        reason = "runtime-limit";
        break;
      }
    }

    writeJsonl(outFile, messages);
    stdout(formatSummary(messages));
    stdout(`messenger-thread-export: ${scrolls}回スクロール / 終了理由 ${reason} / 出力 ${outFile}`);
    return 0;
  } catch (err) {
    stderr(`messenger-thread-export: 実行失敗 (${err?.message ?? err})`);
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
