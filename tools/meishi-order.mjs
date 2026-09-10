#!/usr/bin/env node
// マヒトデザイン クラウド法人名刺 (https://mhtdesign.net/cloudb2) の発注 CLI。
//
//   check   : 名刺リスト/編集ページ/申請履歴/申請中一覧を HTTP で読んで表示(読み取り専用)
//   apply   : 名刺を「申請」する(AJAX。枚数指定)
//   order   : 名刺注文ウィザードを Playwright で進める。--yes が無い限り確定しない(DRY RUN)
//   history : 申請履歴 + 注文履歴
//
// パスワードは ~/.claude/secrets/mahito-meishi.env からのみ読み、argv・stdout・stderr・ファイル名には出さない。
//
// ウィザードの 2〜4 画面(配送/用紙/出荷)の内部フォーム要素名は実測できていないため、
// テキスト部分一致で選ぶ汎用ロジックにしてある。想定要素が無ければフォーム要素を stderr に
// ダンプして exit 2 する(次回その dump を見て直す設計)。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { isEntry } from "./is-entry.mjs";

export const BASE_URL = "https://mhtdesign.net/cloudb2";
const SECRETS_FILE = path.join(os.homedir(), ".claude", "secrets", "mahito-meishi.env");
const SHOT_DIR = path.join(os.homedir(), ".claude", "meishi-order");
const DEFAULT_BILLING_ID = "461";
const DEFAULT_QTY = 100;
const HOME_SHIP_QTY = 500; // これ以上は宅配便に自動切替
const KNOWN_POSITIONS = ["契約ディレクター", "契約クリエーター", "契約クリエイター", "プロデューサー"]; // マニュアル表記は「契約クリエーター」。揺れ対策で両方
// 名刺リストは「2026-08-25 21:42」、名刺注文ページは「2026/09/09 15:39」と区切りが違う(実測)。
const DATE_RE = /(\d{4}[-/]\d{2}[-/]\d{2} \d{2}:\d{2})/;

// ---------------------------------------------------------------------------
// 純関数(テスト対象)
// ---------------------------------------------------------------------------

export function normalizeSpace(s) {
  return String(s ?? "")
    .replace(/[\s　]+/g, " ")
    .trim();
}

export function decodeEntities(s) {
  return String(s ?? "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&amp;/gi, "&");
}

export function stripTags(html) {
  return normalizeSpace(decodeEntities(String(html ?? "").replace(/<[^>]*>/g, " ")));
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// タグ文字列から属性値を取り出す。属性名の直前に空白を要求して data-name= の誤マッチを防ぐ。
export function attrValue(tag, name) {
  const re = new RegExp(`[\\s]${escapeRe(name)}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
  const m = re.exec(String(tag ?? ""));
  if (!m) return null;
  return m[1] ?? m[2] ?? m[3] ?? null;
}

// 名刺リスト(/businesscard/information)の <tr class="businesscard_row"> を行データにする。
// 行テキストは「グループ 社員ID 名前 名刺ID 操作... 前回注文日時 ...」の順。
export function parseCardRows(html) {
  const rows = [];
  const trRe = /<tr\b([^>]*)>([\s\S]*?)<\/tr>/gi;
  let m;
  while ((m = trRe.exec(html))) {
    const attrs = m[1];
    if (!/businesscard_row/i.test(attrs)) continue;
    const inner = m[2];
    const businesscardId = attrValue(attrs, "data-businesscard_id") || "";
    const size = attrValue(attrs, "data-size") || "";
    const text = stripTags(inner);
    const tokens = text.split(" ").filter(Boolean);
    const idIdx = businesscardId ? tokens.indexOf(businesscardId) : -1;
    const head = tokens.slice(0, idIdx >= 1 ? idIdx : Math.min(3, tokens.length));
    const group = head[0] || "";
    const employeeId = head[1] || "";
    const name = head.slice(2).join(" ");

    const appCell = /<td\b[^>]*class="[^"]*application_col[^"]*"[^>]*>([\s\S]*?)<\/td>/i.exec(inner);
    const appText = appCell ? stripTags(appCell[1]) : "";
    const hasApplicationLink = appCell ? appText.includes("申請") : text.includes("申請");

    const dateMatch = DATE_RE.exec(text);

    rows.push({
      businesscardId,
      size,
      group,
      employeeId,
      name,
      hasApplicationLink,
      lastOrderAt: dateMatch ? dateMatch[1] : "",
      hasDiff: text.includes("注文差分"),
      text,
    });
  }
  return rows;
}

// <script> 内の 1 行 JSON 定義(const design_items_front = [...]; 等)を全部拾う。
export function extractJsonVars(html) {
  const out = {};
  const lineRe = /^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(.*)$/;
  for (const line of String(html ?? "").split(/\r?\n/)) {
    const m = lineRe.exec(line);
    if (!m) continue;
    let raw = m[2].trim().replace(/;$/, "");
    if (!raw || (raw[0] !== "[" && raw[0] !== "{")) continue;
    try {
      out[m[1]] = JSON.parse(raw);
    } catch {
      // 複数行 JSON や JS 式は対象外
    }
  }
  return out;
}

// design_items_* の items[] を item_id -> display_name に畳む。
export function designItemMap(designs) {
  const map = new Map();
  for (const d of Array.isArray(designs) ? designs : []) {
    const items = d && Array.isArray(d.items) ? d.items : [];
    for (const it of items) {
      if (!it || it.item_id == null) continue;
      const key = String(it.item_id);
      if (!map.has(key)) map.set(key, it.display_name || "");
    }
  }
  return map;
}

// init_param を再帰的に歩いて {item_id, value} を持つノードを集める。
export function collectItemValues(node, acc = [], seen = new Set()) {
  if (!node || typeof node !== "object" || seen.has(node)) return acc;
  seen.add(node);
  if (Array.isArray(node)) {
    for (const v of node) collectItemValues(v, acc, seen);
    return acc;
  }
  if (node.item_id != null && "value" in node) {
    acc.push({ item_id: node.item_id, value: node.value, variable_id: node.variable_id ?? null });
  }
  for (const v of Object.values(node)) {
    if (v && typeof v === "object") collectItemValues(v, acc, seen);
  }
  return acc;
}

// 役職・URL・姓名などを display_name で引けるオブジェクトにする。
export function pickItemValues(initParam, designItems) {
  const map = designItemMap(designItems);
  const out = {};
  for (const e of collectItemValues(initParam)) {
    const key = map.get(String(e.item_id)) || `item_${e.item_id}`;
    const value = e.value == null ? "" : String(e.value);
    if (!(key in out)) {
      out[key] = value;
    } else if (out[key] !== value) {
      const alt = `${key} (item ${e.item_id})`;
      if (!(alt in out)) out[alt] = value;
    }
  }
  return out;
}

// init_param から裏面デザインらしき情報を拾う。見つからなければ null 相当を返す。
export function findBackDesign(initParam) {
  const hits = { designId: null, designName: null, image: null, keys: [] };
  const seen = new Set();
  const isBacky = (s) => /(^|_)back/i.test(String(s)) || String(s).includes("裏");
  const walk = (node) => {
    if (!node || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const v of node) walk(v);
      return;
    }
    const designId = node.design_id ?? node.back_design_id ?? null;
    const designName = node.design_name ?? node.back_design_name ?? null;
    let backy = isBacky(designName) || isBacky(designId);
    for (const [k, v] of Object.entries(node)) {
      if (typeof v === "string" && v.includes("裏面new202405")) {
        hits.image = v;
        hits.keys.push(k);
        backy = true;
      } else if (v && typeof v === "object" && isBacky(k)) {
        backy = true;
      }
    }
    if (backy && (designId != null || designName != null)) {
      if (hits.designId == null && designId != null) hits.designId = String(designId);
      if (hits.designName == null && designName != null) hits.designName = String(designName);
    }
    for (const v of Object.values(node)) {
      if (v && typeof v === "object") walk(v);
    }
  };
  walk(initParam);
  if (hits.designId == null && hits.designName == null && hits.image == null) return null;
  return hits;
}

// 名前(空白除去・部分一致) / 社員ID(大小無視) / 名刺ID のいずれかで絞る。
export function matchTarget(rows, query) {
  const q = String(query ?? "").replace(/[\s　]/g, "");
  if (!q) return [];
  const ql = q.toLowerCase();
  return (rows || []).filter((r) => {
    const name = String(r.name ?? "").replace(/[\s　]/g, "");
    const emp = String(r.employeeId ?? "").toLowerCase();
    const id = String(r.businesscardId ?? "");
    return name.includes(q) || emp.includes(ql) || (id && id.includes(q));
  });
}

// jQuery $.ajax の data 直列化と同じ形。配列は key[] に展開し、空文字も落とさない。
export function serializeForm(obj) {
  const parts = [];
  for (const [k, v] of Object.entries(obj || {})) {
    if (Array.isArray(v)) {
      const key = k.endsWith("[]") ? k : `${k}[]`;
      for (const item of v) {
        parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(item == null ? "" : String(item))}`);
      }
    } else {
      parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(v == null ? "" : String(v))}`);
    }
  }
  return parts.join("&");
}

// 500 枚以上はメール便ではなく宅配便になる。
// "企業名|宛名|郵便番号|番地|建物名|電話" を配送先の新規入力用オブジェクトにする。郵便番号はハイフン有無どちらでも可。
export function parseNewAddr(spec) {
  const parts = String(spec ?? "").split("|").map((p) => p.trim());
  if (parts.length < 6) return { ok: false, reason: '書式は "企業名|宛名|郵便番号|番地|建物名|電話" の 6 項目(建物名が無ければ空でも可)' };
  const [company, name, zipRaw, block, building, telRaw] = parts;
  const zip = zipRaw.replace(/[^0-9]/g, "");
  const tel = telRaw.replace(/[^0-9]/g, "");
  if (!company || !name) return { ok: false, reason: "企業名と宛名は必須" };
  if (zip.length !== 7) return { ok: false, reason: `郵便番号は 7 桁(${zipRaw})` };
  if (!block) return { ok: false, reason: "番地は必須" };
  if (tel.length < 10) return { ok: false, reason: `電話番号は 10 桁以上(${telRaw})` };
  return { ok: true, company, name, zip1: zip.slice(0, 3), zip2: zip.slice(3), block, building, tel };
}

export function shipMethodFor(qty, requested) {
  const want = requested || "メール便";
  const n = Number(qty);
  if (Number.isFinite(n) && n >= HOME_SHIP_QTY) return "宅配便";
  return want;
}

export function parseQuantityOptions(html) {
  const m = /<select\b[^>]*name="application_single_quantity"[^>]*>([\s\S]*?)<\/select>/i.exec(String(html ?? ""));
  if (!m) return [];
  return [...m[1].matchAll(/<option\b[^>]*>([\s\S]*?)<\/option>/gi)].map((o) => {
    const tag = o[0];
    return { value: (attrValue(tag, "value") || "").trim(), label: stripTags(o[1]) };
  });
}

// 名刺注文ページ(/businesscard/order)の申請中一覧。行 = <tr data-group_id=...>。
export function parseOrderRows(html) {
  const rows = [];
  const trRe = /<tr\b([^>]*)>([\s\S]*?)<\/tr>/gi;
  let m;
  while ((m = trRe.exec(html))) {
    const attrs = m[1];
    const inner = m[2];
    const inputTag = /<input\b[^>]*name="ids\[\]"[^>]*>/i.exec(inner);
    const thumgTag = /<a\b[^>]*class="[^"]*view_thumbnail[^"]*"[^>]*>/i.exec(inner);
    const applicationId = inputTag ? attrValue(inputTag[0], "value") : null;
    const businesscardId = thumgTag ? attrValue(thumgTag[0], "data-businesscard_id") : null;
    if (!applicationId && !businesscardId) continue;
    const cells = [...inner.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((c) => stripTags(c[1]));
    const quantityCell = cells.find((c) => /^\d{1,5}$/.test(c) && c !== businesscardId);
    const dateCell = cells.find((c) => DATE_RE.test(c));
    rows.push({
      groupId: attrValue(attrs, "data-group_id") || "",
      applicationId: applicationId || "",
      businesscardId: businesscardId || "",
      quantity: quantityCell ? Number(quantityCell) : null,
      appliedAt: dateCell ? (DATE_RE.exec(dateCell) || [])[1] || "" : "",
      cells,
      text: stripTags(inner),
    });
  }
  return rows;
}

// 汎用テーブル読み取り。<thead><th> をヘッダに、<tr> 内の <td> を行にする。
export function parseTableRows(html) {
  const src = String(html ?? "");
  const headers = [];
  const thead = /<thead\b[^>]*>([\s\S]*?)<\/thead>/i.exec(src);
  if (thead) {
    for (const m of thead[1].matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/gi)) headers.push(stripTags(m[1]));
  }
  const rows = [];
  const trRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let m;
  while ((m = trRe.exec(src))) {
    const cells = [...m[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((c) => stripTags(c[1]));
    if (cells.length) rows.push(cells);
  }
  return { headers, rows };
}

export function rowsToObjects(table) {
  return table.rows.map((cells) => {
    const obj = { cells };
    cells.forEach((c, i) => {
      const key = table.headers[i] || `col${i}`;
      obj[key] = c;
    });
    return obj;
  });
}

export function parseArgs(argv) {
  const args = {
    command: null,
    query: null,
    json: false,
    yes: false,
    headful: false,
    help: false,
    qty: DEFAULT_QTY,
    note: "",
    to: null,
    newAddr: null, // --to new のときの配送先 "企業名|宛名|郵便番号|番地|建物名|電話"
    paper: "マットポスト 180kg",
    corner: "なし",
    pack: "",   // 空なら配送方法から決める(メール便=トレイ / 宅配便=紙箱)
    ship: "メール便",
    days: 0,
  };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") args.json = true;
    else if (a === "--yes") args.yes = true;
    else if (a === "--headful") args.headful = true;
    else if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--qty") {
      const v = parseInt(argv[++i], 10);
      if (Number.isFinite(v)) args.qty = v;
    } else if (a === "--days") {
      const v = parseInt(argv[++i], 10);
      if (Number.isFinite(v)) args.days = v;
    } else if (a === "--note") args.note = argv[++i] ?? "";
    else if (a === "--to") args.to = argv[++i] ?? null;
    else if (a === "--new-addr") args.newAddr = argv[++i] ?? null;
    else if (a === "--paper") args.paper = argv[++i] ?? args.paper;
    else if (a === "--corner") args.corner = argv[++i] ?? args.corner;
    else if (a === "--pack") args.pack = argv[++i] ?? args.pack;
    else if (a === "--ship") args.ship = argv[++i] ?? args.ship;
    else if (!a.startsWith("-")) rest.push(a);
  }
  args.command = rest[0] || null;
  args.query = rest[1] || null;
  return args;
}

export function parseEnv(text) {
  const out = {};
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 0) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (k) out[k] = v;
  }
  return out;
}

// gpage-fetch.mjs と同じ方式で Chromium を探す(配置は Playwright の版で変わる)。
export function findChromium(baseDir, readdirFn = fs.readdirSync, existsFn = fs.existsSync) {
  if (!baseDir) return null;
  let entries;
  try {
    entries = readdirFn(baseDir, { withFileTypes: true });
  } catch {
    return null;
  }
  const dirs = entries
    .filter((e) => (typeof e.isDirectory === "function" ? e.isDirectory() : Boolean(e.isDirectory)) && String(e.name).startsWith("chromium-"))
    .map((e) => String(e.name))
    .sort((a, b) => b.localeCompare(a));
  for (const dir of dirs) {
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

// ---------------------------------------------------------------------------
// 認証情報
// ---------------------------------------------------------------------------

function loadCreds() {
  if (!fs.existsSync(SECRETS_FILE)) {
    throw new Error(
      `${SECRETS_FILE} が無い。ログイン情報シート(社内)の『マヒトデザイン クラウド法人名刺』行を見て作成してください。\n` +
        `書式:\n  MAHITO_LOGIN_URL=https://mhtdesign.net/cloudb2/orgiast-meishi/login\n  MAHITO_ID=orgiast\n  MAHITO_PASSWORD=********`
    );
  }
  const env = parseEnv(fs.readFileSync(SECRETS_FILE, "utf8"));
  const loginUrl = env.MAHITO_LOGIN_URL || `${BASE_URL}/orgiast-meishi/login`;
  const id = env.MAHITO_ID;
  const password = env.MAHITO_PASSWORD;
  if (!id || !password) throw new Error(`${SECRETS_FILE} に MAHITO_ID / MAHITO_PASSWORD がありません。`);
  return { loginUrl, id, password, billingId: env.MAHITO_BILLING_ID || DEFAULT_BILLING_ID };
}

// ---------------------------------------------------------------------------
// HTTP(cookie jar 付き)
// ---------------------------------------------------------------------------

// Node の版によって Headers.getSetCookie が無いので、無ければ自前で割る。
export function splitSetCookie(headers) {
  if (typeof headers.getSetCookie === "function") return headers.getSetCookie();
  const single = headers.get("set-cookie");
  if (!single) return [];
  return single.split(/,\s*(?=[^;=]+=)/);
}

class Client {
  constructor(baseUrl) {
    this.baseUrl = baseUrl;
    this.cookies = new Map();
  }

  cookieHeader() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  storeCookies(res) {
    for (const raw of splitSetCookie(res.headers)) {
      const pair = String(raw).split(";")[0].trim();
      const i = pair.indexOf("=");
      if (i <= 0) continue;
      this.cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
  }

  // redirect: manual で自前で追う(cookie を持ち回るため)。
  async request(url, { method = "GET", body, headers = {} } = {}) {
    let current = url;
    let m = method;
    let b = body;
    for (let hop = 0; hop < 10; hop++) {
      const reqHeaders = { "user-agent": "meishi-order-cli/1.0", ...headers };
      const jar = this.cookieHeader();
      if (jar) reqHeaders.cookie = jar;
      const res = await fetch(current, { method: m, headers: reqHeaders, body: b, redirect: "manual" });
      this.storeCookies(res);
      const loc = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && loc) {
        current = new URL(loc, current).toString();
        m = "GET";
        b = undefined;
        continue;
      }
      return { res, url: current, status: res.status, text: await res.text() };
    }
    throw new Error("リダイレクトが多すぎます");
  }
}

function extractInputs(html) {
  const out = [];
  for (const m of String(html ?? "").matchAll(/<input\b[^>]*>/gi)) {
    out.push({
      name: attrValue(m[0], "name"),
      value: attrValue(m[0], "value"),
      type: attrValue(m[0], "type"),
      id: attrValue(m[0], "id"),
    });
  }
  return out;
}

export function extractCsrfMeta(html) {
  const m = /<meta\b[^>]*name="csrf-token"[^>]*>/i.exec(String(html ?? ""));
  return m ? attrValue(m[0], "content") : null;
}

async function login(client, creds) {
  const first = await client.request(creds.loginUrl);
  if (!/name=["']?password/i.test(first.text) && !/name=["']?_token/i.test(first.text)) {
    throw new Error(`ログインページの形が想定と違います (${first.url})`);
  }
  const token = (extractInputs(first.text).find((i) => i.name === "_token") || {}).value;
  const body = serializeForm({ _token: token || "", id: creds.id, password: creds.password });
  const posted = await client.request(first.url, {
    method: "POST",
    body,
    headers: { "content-type": "application/x-www-form-urlencoded" },
  });
  if (/IDもしくはパスワードが間違っています/.test(posted.text)) {
    throw new Error("ログイン失敗: ID またはパスワードが違います（" + SECRETS_FILE + " を確認）");
  }
  if (/name=["']?password/i.test(posted.text) && !/logout|ログアウト/i.test(posted.text)) {
    throw new Error(`ログインできませんでした (${posted.url})`);
  }
  return posted;
}

async function fetchAllCardRows(client) {
  const all = [];
  for (let p = 1; p <= 10; p++) {
    const url = `${BASE_URL}/businesscard/information?display_count=300${p > 1 ? `&p=${p}` : ""}`;
    const r = await client.request(url);
    all.push(...parseCardRows(r.text));
    if (!new RegExp(`[?&]p=${p + 1}\\b`).test(r.text)) break;
  }
  return all;
}

function pickTarget(rows, query) {
  const hits = matchTarget(rows, query);
  if (hits.length === 0) {
    console.error(`該当なし: 「${query}」に一致する名刺がありません。`);
    process.exit(1);
  }
  if (hits.length > 1) {
    console.error(`候補が ${hits.length} 件あります。名刺ID か社員ID で指定してください:`);
    for (const h of hits) {
      console.error(`  名刺ID ${h.businesscardId} / 社員ID ${h.employeeId} / ${h.name} / グループ ${h.group}`);
    }
    process.exit(1);
  }
  return hits[0];
}

async function fetchCardDetail(client, businesscardId) {
  const r = await client.request(`${BASE_URL}/businesscard/information/${businesscardId}/edit`);
  const vars = extractJsonVars(r.text);
  const front = pickItemValues(vars.init_param, vars.design_items_front);
  const back = pickItemValues(vars.init_param, vars.design_items_back);
  return { url: r.url, vars, front, back, backDesign: findBackDesign(vars.init_param), html: r.text };
}

function cardLine(row) {
  return `名刺ID ${row.businesscardId} / 社員ID ${row.employeeId} / ${row.name} / グループ ${row.group}`;
}

// ---------------------------------------------------------------------------
// Playwright(注文ウィザード)
// ---------------------------------------------------------------------------

class StepError extends Error {}

function shotsDir() {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  return SHOT_DIR;
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

async function saveShot(page, label) {
  const file = path.join(shotsDir(), `${stamp()}-${label}.png`);
  await page.screenshot({ path: file, fullPage: true });
  return file;
}

// 未確認画面のフォーム要素を stderr に出す(次回ここを見て直す)。
async function dumpForms(page, label) {
  const dump = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll("form").forEach((f, fi) => {
      const fields = [];
      f.querySelectorAll("input,select,textarea,button").forEach((el) => {
        const rec = {
          tag: el.tagName.toLowerCase(),
          type: el.type || "",
          name: el.name || "",
          id: el.id || "",
        };
        if (el.tagName === "SELECT") rec.options = [...el.options].map((o) => `${o.value}:${o.textContent.trim()}`);
        if (el.type === "radio" || el.type === "checkbox") rec.value = el.value;
        const lbl = el.id ? document.querySelector(`label[for="${el.id}"]`) : null;
        if (lbl) rec.label = lbl.textContent.trim();
        fields.push(rec);
      });
      out.push({ formIndex: fi, id: f.id, action: f.getAttribute("action"), method: f.getAttribute("method"), fields });
    });
    return out;
  });
  console.error(`--- フォーム要素ダンプ (${label}) URL: ${page.url()} ---`);
  console.error(JSON.stringify(dump, null, 2));
  console.error("--- ダンプここまで ---");
}

async function stepFail(page, message) {
  console.error(`❌ ${message}`);
  try {
    await dumpForms(page, "error");
  } catch {
    // ignore
  }
  try {
    console.error(`スクリーンショット: ${await saveShot(page, "error")}`);
  } catch {
    // ignore
  }
  throw new StepError(message);
}

async function dismissModals(page) {
  try {
    await page.evaluate(() => {
      document.querySelectorAll(".modal").forEach((el) => {
        el.style.display = "none";
        el.classList.remove("show", "in");
      });
      document.querySelectorAll(".modal-backdrop").forEach((el) => el.remove());
      document.body.classList.remove("modal-open");
      document.body.style.overflow = "";
      document.body.style.paddingRight = "";
    });
  } catch {
    // ignore
  }
}

// ページ内の select option → radio/checkbox のラベル → クリック可能要素、の順にテキスト部分一致で選ぶ。
async function chooseByText(page, scopeSelector, text) {
  return await page.evaluate(
    ({ scopeSelector, text: want }) => {
      const norm = (s) => String(s ?? "").replace(/[\s　]/g, "");
      const target = norm(want);
      const root = scopeSelector ? document.querySelector(scopeSelector) : document;
      if (!root) return { ok: false, reason: `scope ${scopeSelector} が無い` };
      for (const sel of root.querySelectorAll("select")) {
        for (const opt of sel.options) {
          if (norm(opt.textContent).includes(target)) {
            sel.value = opt.value;
            sel.dispatchEvent(new Event("change", { bubbles: true }));
            return { ok: true, how: "select", detail: opt.textContent.trim() };
          }
        }
      }
      for (const input of root.querySelectorAll("input[type=radio],input[type=checkbox]")) {
        const lbl = input.closest("label") || (input.id ? document.querySelector(`label[for="${input.id}"]`) : null);
        // ラベルが無い表(配送先一覧など)では同じ行(tr/li)のテキストで照合する
        const labelText = lbl ? lbl.textContent : ((input.closest("tr,li") || {}).textContent || input.value);
        if (norm(labelText).includes(target)) {
          input.click();
          return { ok: true, how: "radio", detail: String(labelText).trim() };
        }
      }
      for (const el of root.querySelectorAll("a,button,li,label,[role=button]")) {
        if (norm(el.textContent).includes(target) && el.offsetParent !== null) {
          el.click();
          return { ok: true, how: "click", detail: el.textContent.trim().slice(0, 60) };
        }
      }
      const candidates = [...root.querySelectorAll("select option,label,button")]
        .map((e) => e.textContent.trim())
        .filter(Boolean)
        .slice(0, 40);
      return { ok: false, reason: "一致なし", candidates };
    },
    { scopeSelector, text }
  );
}

async function chooseSelectByIndex(page, scopeSelector, index) {
  return await page.evaluate(
    ({ scopeSelector, index }) => {
      const root = scopeSelector ? document.querySelector(scopeSelector) : document;
      if (!root) return { ok: false, reason: `scope ${scopeSelector} が無い` };
      const sel = root.querySelector("select");
      if (!sel) return { ok: false, reason: "select が無い" };
      const opts = [...sel.options].map((o) => o.textContent.trim());
      if (!opts.length) return { ok: false, reason: "option が無い" };
      const i = Math.min(Math.max(index, 0), opts.length - 1);
      sel.selectedIndex = i;
      sel.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true, how: "select-index", detail: opts[i], count: opts.length, clamped: i !== index };
    },
    { scopeSelector, index }
  );
}

async function assertNoAlert(page) {
  const alerts = await page.locator(".alert-danger").allInnerTexts().catch(() => []);
  const text = alerts.join(" / ").trim();
  if (text) await stepFail(page, `.alert-danger が出ています: ${text}`);
}

async function clickNext(page, selector, expectFragment, label) {
  await dismissModals(page);
  const loc = page.locator(selector).first();
  if ((await loc.count()) === 0) await stepFail(page, `${label}: ${selector} が見つかりません`);
  await loc.click();
  try {
    await page.waitForURL((u) => u.toString().includes(expectFragment), { timeout: 30000 });
  } catch {
    await stepFail(page, `${label}: ${expectFragment} に遷移しませんでした (現在 ${page.url()})`);
  }
  await page.waitForLoadState("networkidle").catch(() => {});
  await assertNoAlert(page);
}

async function checkInput(page, selector, label) {
  const loc = page.locator(selector).first();
  if ((await loc.count()) === 0) await stepFail(page, `${label}: ${selector} が見つかりません`);
  try {
    await loc.check({ timeout: 5000 });
  } catch {
    try {
      await loc.evaluate((el) => el.click());
    } catch {
      await stepFail(page, `${label}: ${selector} をチェックできません`);
    }
  }
}

function chromiumPath() {
  const env = process.env.PLAYWRIGHT_BROWSERS_PATH;
  const base =
    env ||
    (process.platform === "win32"
      ? process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "ms-playwright")
      : process.platform === "darwin"
        ? path.join(os.homedir(), "Library", "Caches", "ms-playwright")
        : path.join(os.homedir(), ".cache", "ms-playwright"));
  return findChromium(base);
}

// ---------------------------------------------------------------------------
// コマンド
// ---------------------------------------------------------------------------

function printUsage() {
  console.log(`マヒト法人名刺 発注CLI

使い方:
  node tools/meishi-order.mjs check <名前|社員ID|名刺ID>
      名刺の登録内容(役職/URL/裏面)・申請履歴・申請中を表示します(読み取りのみ)
  node tools/meishi-order.mjs apply <名前|社員ID|名刺ID> [--qty 100] [--note "..."]
      名刺を「申請」します(枚数の既定は 100)
  node tools/meishi-order.mjs order <名前|社員ID|名刺ID> [--to "<配送先>" | --to new --new-addr "企業名|宛名|郵便番号|番地|建物名|電話"] [--yes] [--headful]
      [--paper "マットポスト 180kg"] [--pack "トレイ|紙箱|プラスチック箱"(既定: メール便=トレイ, 宅配便=紙箱)] [--ship "メール便"] [--days 0] [--corner "なし"]
      注文ウィザードを進めます。--yes が無いと確定しません(DRY RUN)
  node tools/meishi-order.mjs history [<名前>]
      申請履歴と注文履歴を表示します

共通オプション:
  --json     機械可読な JSON も出力します
  --help     この使い方

注意:
  ・--to new は --new-addr "企業名|宛名|郵便番号|番地|建物名|電話" と組で使います(登録済み配送先には保存されません)
  ・500枚以上は配送方法が自動で「宅配便」になります
  ・認証情報: ~/.claude/secrets/mahito-meishi.env`);
}

async function cmdCheck(args, creds) {
  const client = new Client(BASE_URL);
  await login(client, creds);
  const rows = await fetchAllCardRows(client);
  const target = pickTarget(rows, args.query);
  const detail = await fetchCardDetail(client, target.businesscardId);
  const history = await client.request(`${BASE_URL}/businesscard/requesthistory`);
  const histTable = parseTableRows(history.text);
  const myHist = rowsToObjects(histTable)
    .filter((o) => o.cells.includes(target.businesscardId) || o.cells.includes(target.employeeId))
    .slice(0, 3);
  const orderPage = await client.request(`${BASE_URL}/businesscard/order`);
  const myApps = parseOrderRows(orderPage.text).filter((r) => r.businesscardId === target.businesscardId);

  const front = detail.front;
  const url = front["URL"] || "";
  const position = front["役職"] || "";
  const backDesign = detail.backDesign;

  const result = {
    businesscardId: target.businesscardId,
    employeeId: target.employeeId,
    name: target.name,
    group: target.group,
    size: target.size,
    lastOrderAt: target.lastOrderAt,
    alreadyApplied: target.hasApplicationLink || myApps.length > 0,
    applications: myApps,
    fields: front,
    backFields: detail.back,
    backDesign,
    history: myHist.map((o) => ({ raw: o.cells })),
  };

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`【名刺の登録内容】${cardLine(target)}`);
  console.log(`  用紙サイズ : ${target.size || "(不明)"}`);
  console.log(`  URL        : ${url || "(未設定)"}`);
  console.log(`  姓名       : ${front["姓名"] || "(未設定)"}`);
  console.log(`  英字ルビ   : ${front["英字ルビ"] || "(未設定)"}`);
  console.log(`  役職       : ${position || "(未設定)"}`);
  console.log(`  mobile     : ${front["mobile"] || "(未設定)"}`);
  console.log(`  E-mail     : ${front["E-mail"] || "(未設定)"}`);
  if (backDesign) {
    const parts = [];
    if (backDesign.designName) parts.push(`デザイン名 ${backDesign.designName}`);
    if (backDesign.designId) parts.push(`デザインID ${backDesign.designId}`);
    if (backDesign.image) parts.push(`画像 ${backDesign.image}`);
    console.log(`  裏面       : ${parts.join(" / ")}`);
  } else {
    console.log("  裏面       : 判定不能（画面で確認）");
  }
  console.log(`  前回注文   : ${target.lastOrderAt || "(なし)"}`);

  if (/^http:\/\//i.test(url)) {
    console.log("  ⚠️ URL が http:// です。https:// に直すか確認してください。");
  }
  if (position && !KNOWN_POSITIONS.includes(position)) {
    const hit = KNOWN_POSITIONS.filter((p) => position.includes(p));
    if (!hit.length) {
      console.log("  ℹ️ 役職は標準3種以外（例: 部長など個別設定）です。このままで問題なければ次へ進めます。");
    }
  }

  if (myApps.length) {
    for (const a of myApps) {
      console.log(`【申請中】申請ID ${a.applicationId} / 枚数 ${a.quantity ?? "?"} / 申請日時 ${a.appliedAt || "?"}`);
    }
  } else {
    console.log("【申請中】なし（apply で申請できます）");
  }

  if (myHist.length) {
    console.log("【申請履歴 直近3件】");
    for (const o of myHist) console.log("  " + o.cells.join(" | "));
  } else {
    console.log("【申請履歴】該当なし");
  }
}

async function cmdApply(args, creds) {
  const client = new Client(BASE_URL);
  await login(client, creds);
  const listPage = await client.request(`${BASE_URL}/businesscard/information?display_count=300`);
  const rows = parseCardRows(listPage.text);
  const target = pickTarget(rows, args.query);

  const orderPage = await client.request(`${BASE_URL}/businesscard/order`);
  const existing = parseOrderRows(orderPage.text).find((r) => r.businesscardId === target.businesscardId);
  if (existing) {
    const msg = `既に申請中（申請ID ${existing.applicationId}, 枚数 ${existing.quantity ?? "?"}）`;
    if (args.json) console.log(JSON.stringify({ ok: true, alreadyApplied: true, target: cardLine(target), application: existing }, null, 2));
    else console.log(`${cardLine(target)}\n${msg}`);
    return;
  }

  const qtyOptions = parseQuantityOptions(listPage.text);
  if (qtyOptions.length && !qtyOptions.some((o) => String(o.value) === String(args.qty) || o.label === String(args.qty))) {
    console.error(`枚数 ${args.qty} は選べません。選べる枚数: ${qtyOptions.map((o) => o.value || o.label).join(", ")}`);
    process.exit(1);
  }

  const csrf = extractCsrfMeta(listPage.text);
  if (!csrf) {
    console.error("CSRF トークン(meta[name=csrf-token])が取れませんでした。ページ構造が変わった可能性があります。");
    process.exit(1);
  }

  const body = serializeForm({ businesscard_id_list: [target.businesscardId], quantity: args.qty, note: args.note });
  const res = await client.request(`${BASE_URL}/businesscard-api/information/application`, {
    method: "POST",
    body,
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "X-CSRF-TOKEN": csrf,
      "X-Requested-With": "XMLHttpRequest",
    },
  });

  let parsed = null;
  try {
    parsed = JSON.parse(res.text);
  } catch {
    parsed = null;
  }
  if (!parsed || Number(parsed.status) !== 0) {
    const msg = parsed && parsed.message ? parsed.message : res.text.slice(0, 300);
    console.error(`申請に失敗しました: ${msg}`);
    process.exit(1);
  }

  const after = await client.request(`${BASE_URL}/businesscard/requesthistory`);
  const hist = rowsToObjects(parseTableRows(after.text)).filter(
    (o) => o.cells.includes(target.businesscardId) || o.cells.includes(target.employeeId)
  );
  const newest = hist[0];

  if (args.json) {
    console.log(JSON.stringify({ ok: true, target: cardLine(target), quantity: args.qty, history: hist.slice(0, 3).map((o) => o.cells) }, null, 2));
    return;
  }
  console.log(`申請しました: ${cardLine(target)} / 枚数 ${args.qty}`);
  if (newest) console.log(`申請履歴の先頭: ${newest.cells.join(" | ")}`);
  console.log("次の手順: node tools/meishi-order.mjs order " + args.query + "  （--yes を付けるまで確定しません）");
}

async function cmdOrder(args, creds) {
  const { chromium } = await import("playwright-core");
  const executablePath = chromiumPath();
  if (!executablePath) {
    console.error("Chromium が見つかりません。npx playwright install chromium を実行してください");
    process.exit(4);
  }
  let newAddr = null;
  if (args.to === "new") {
    newAddr = parseNewAddr(args.newAddr);
    if (!newAddr.ok) {
      console.error(`--to new には --new-addr "企業名|宛名|郵便番号|番地|建物名|電話" が必要です: ${newAddr.reason}`);
      process.exit(2);
    }
  }

  const client = new Client(BASE_URL);
  await login(client, creds);
  const rows = await fetchAllCardRows(client);
  const target = pickTarget(rows, args.query);

  const orderPage = await client.request(`${BASE_URL}/businesscard/order`);
  const app = parseOrderRows(orderPage.text).find((r) => r.businesscardId === target.businesscardId);
  if (!app) {
    console.error(`${cardLine(target)}\n申請がありません。先に apply を実行してください:`);
    console.error(`  node tools/meishi-order.mjs apply ${args.query}`);
    process.exit(1);
  }

  const qty = app.quantity ?? DEFAULT_QTY;
  const ship = shipMethodFor(qty, args.ship);
  const shipChanged = ship !== args.ship;

  let browser = null;
  let exitCode = 0;
  try {
    browser = await chromium.launch({ headless: !args.headful, executablePath });
    const context = await browser.newContext();
    const page = await context.newPage();

    // --- ログイン ---
    await page.goto(creds.loginUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    const token = (extractInputs(await page.content()).find((i) => i.name === "_token") || {}).value;
    if (token) {
      await page.fill('input[name="password"]', creds.password).catch(() => {});
      await page.fill('input[name="id"]', creds.id).catch(() => {});
      await page.click('button[type="submit"]');
      await page.waitForLoadState("networkidle").catch(() => {});
    }
    {
      const html = await page.content();
      // 個人設定等のパスワード欄がログイン後の画面にも含まれるため、HTTP 側と同じく「ログアウト表記が無い」場合のみ失敗とする
      if (/name=["']?password/i.test(html) && !/logout|ログアウト/i.test(html)) {
        await stepFail(page, `ログインできませんでした (${page.url()})`);
      }
    }

    // --- 1. 名刺注文ページ ---
    await page.goto(`${BASE_URL}/businesscard/order`, { waitUntil: "networkidle", timeout: 60000 });
    await assertNoAlert(page);
    await dismissModals(page);

    const billing = page.locator('select[name="billing_address_id"]');
    if ((await billing.count()) === 0) await stepFail(page, "請求先 select[name=billing_address_id] が見つかりません");
    await billing.selectOption(creds.billingId).catch(async () => {
      await stepFail(page, `請求先 ${creds.billingId} を選べません`);
    });

    await checkInput(page, `input[name="ids[]"][value="${app.applicationId}"]`, "申請のチェックボックス");
    console.log(`対象: ${cardLine(target)}`);
    console.log(`申請ID ${app.applicationId} / 枚数 ${qty} / 申請日時 ${app.appliedAt || "?"}`);
    console.log(`請求先: ${creds.billingId}`);

    await clickNext(page, "#approve-btn", "/businesscard/orderdelivery", "名刺注文");

    // --- 2. 配送先 ---
    let deliveryChosen;
    if (newAddr) {
      // 実測(2026-09-10): 先頭 radio value="temp" が「配送先情報を入力する」。郵便番号入力で都道府県/市区町村が自動補完され、
      // hidden の prefectures_id/address1a/address1b/address2 に *_disp の値がミラーされる(空なら自前で埋める)。
      const fillTemp = async (name, v) => {
        const sel = `input[name="${name}"]`;
        await page.fill(sel, v);
        await page.dispatchEvent(sel, "input");
        await page.dispatchEvent(sel, "change");
      };
      // radio は空の <label for="id0"> に覆われていて Playwright の check が届かない(実測)。DOM から直接選ぶ
      const picked = await page.evaluate(() => { const r = document.querySelector('input[name="id"][value="temp"]'); if (!r) return false; r.click(); r.checked = true; r.dispatchEvent(new Event("change", { bubbles: true })); return r.checked; });
      if (!picked) await stepFail(page, "「配送先情報を入力する」(value=temp) の radio が見つかりません");
      await fillTemp("company_name", newAddr.company);
      await fillTemp("name", newAddr.name);
      await fillTemp("zip1", newAddr.zip1);
      await fillTemp("zip2", newAddr.zip2);
      await page.dispatchEvent('input[name="zip2"]', "keyup");
      await page.locator('input[name="zip2"]').blur();
      await page.waitForFunction(() => (document.querySelector('input[name="prefectures_disp"]') || {}).value, null, { timeout: 15000 }).catch(() => {});
      await fillTemp("address1b_disp", newAddr.block);
      await fillTemp("address2_disp", newAddr.building);
      await fillTemp("tel", newAddr.tel);
      await page.locator('input[name="tel"]').blur();
      const filled = await page.evaluate(() => {
        for (const k of ["prefectures_id", "address1a", "address1b", "address2"]) {
          const h = document.querySelector(`input[name="${k}"]`);
          const d = document.querySelector(`input[name="${k === "prefectures_id" ? "prefectures_id_temp" : k + "_disp"}"]`);
          if (h && d && !h.value) h.value = d.value;
        }
        const v = (n) => (document.querySelector(`input[name="${n}"]`) || {}).value || "";
        return { pref: v("prefectures_disp"), city: v("address1a_disp"), block: v("address1b_disp"), building: v("address2_disp") };
      });
      if (!filled.pref || !filled.city) await stepFail(page, `郵便番号 ${newAddr.zip1}-${newAddr.zip2} から都道府県/市区町村が補完されませんでした`);
      deliveryChosen = { ok: true, how: "new", detail: `新規入力: ${newAddr.company} ${newAddr.name} 〒${newAddr.zip1}-${newAddr.zip2} ${filled.pref}${filled.city}${filled.block} ${filled.building} TEL ${newAddr.tel}` };
    } else if (args.to) {
      deliveryChosen = await chooseByText(page, "#delivery-list", args.to);
      if (!deliveryChosen.ok) {
        await stepFail(page, `配送先「${args.to}」を選べません: ${deliveryChosen.reason} ${JSON.stringify(deliveryChosen.candidates || [])}`);
      }
    } else {
      deliveryChosen = await page.evaluate(() => {
        const root = document.querySelector("#delivery-list") || document;
        // 実測(2026-09-10): 先頭 radio は value="temp"(配送先を新規入力)で空のまま進めない。登録済み配送先の先頭を選ぶ
        const radio = root.querySelector('input[type=radio]:not([value="temp"]),input[type=checkbox]');
        if (radio) {
          radio.click();
          const lbl = radio.closest("label") || (radio.id ? document.querySelector(`label[for="${radio.id}"]`) : null);
          let rowEl = radio.closest("tr,li");
          for (let e = radio.parentElement; !rowEl && e && e !== root; e = e.parentElement) {
            if (e.textContent.replace(/\s+/g, " ").trim().length > 5) rowEl = e; // ラベル無し・div 組みの表でも同じ行の文字を拾う
          }
          const lblText = lbl ? lbl.textContent.trim() : "";
          const rowText = lblText || (rowEl ? rowEl.textContent : radio.value);
          return { ok: true, how: "radio-first", detail: String(rowText).replace(/\s+/g, " ").trim().slice(0, 80) };
        }
        const row = root.querySelector("li,tr,label");
        if (row) {
          row.click();
          return { ok: true, how: "row-first", detail: row.textContent.trim().slice(0, 80) };
        }
        return { ok: false, reason: "配送先の選択肢が無い" };
      });
      if (!deliveryChosen.ok) {
        await stepFail(page, `配送先の一覧から選べません: ${deliveryChosen.reason}`);
      }
    }
    console.log(`配送先: ${deliveryChosen.detail} (${deliveryChosen.how})`);
    await clickNext(page, "#btn_orderdelivery_next", "/businesscard/orderdetails", "配送先");

    // --- 3. 用紙・角丸 ---
    const paper = await chooseByText(page, "#orderdetails_table", args.paper);
    if (!paper.ok) await stepFail(page, `用紙「${args.paper}」を選べません: ${paper.reason} ${JSON.stringify(paper.candidates || [])}`);
    console.log(`用紙: ${paper.detail}`);
    if (args.corner && args.corner !== "なし") {
      const corner = await chooseByText(page, "#orderdetails_table", args.corner);
      if (!corner.ok) await stepFail(page, `角丸「${args.corner}」を選べません: ${corner.reason}`);
      console.log(`角丸: ${corner.detail}`);
    } else {
      const corner = await chooseByText(page, "#orderdetails_table", args.corner);
      console.log(corner.ok ? `角丸: ${corner.detail}` : `角丸: ${args.corner}（既定のまま）`);
    }
    await clickNext(page, "#btn_orderdetails_next", "/businesscard/ordershipping", "用紙");

    // --- 4. 出荷営業日・梱包・配送方法 ---
    // 実測(2026-09-10): 出荷営業日は input[name=shipping_days] の radio(0/1/3/5営業日)。
    // 配送方法 input[name=delivery_type](メール便/宅配便/翌日到着便/お急ぎ便)ごとに梱包 input[name=option2] が別グループ
    // (id: option2_mail_* = トレイ/プラスチック箱, option2_takuhai_* = 紙箱/プラスチック箱)。配送方法→梱包の順でないと
    // 「選択された配送方法では、この梱包方法は選択できません」で止まる。
    const daySel = await chooseByText(page, null, `${args.days}営業日`);
    if (daySel.ok) {
      console.log(`出荷営業日: ${daySel.detail}`);
    } else {
      console.log(`出荷営業日: ${args.days}営業日 を選択できませんでした (${daySel.reason}) — 画面の既定のまま進めます`);
    }

    const shipRes = await chooseByText(page, null, ship);
    if (!shipRes.ok) await stepFail(page, `配送方法「${ship}」を選べません: ${shipRes.reason} ${JSON.stringify(shipRes.candidates || [])}`);
    console.log(`配送方法: ${shipRes.detail}${shipChanged ? ` (枚数 ${qty} ≥ ${HOME_SHIP_QTY} のため ${args.ship} から自動切替)` : ""}`);

    const isMail = ship === "メール便";
    const packWant = args.pack || (isMail ? "トレイ" : "紙箱");
    const pack = await page.evaluate(({ isMail, want }) => {
      const norm = (t) => String(t ?? "").replace(/[s　]/g, "");
      const prefix = isMail ? "option2_mail_" : "option2_takuhai_";
      const radios = [...document.querySelectorAll(`input[name="option2"][id^="${prefix}"]`)];
      const labelOf = (r) => (r.closest("label") || document.querySelector(`label[for="${r.id}"]`) || {}).textContent || r.value;
      const hit = radios.find((r) => norm(labelOf(r)).includes(norm(want)));
      if (!hit) return { ok: false, reason: "一致なし", candidates: radios.map((r) => String(labelOf(r)).trim()) };
      hit.click();
      return { ok: true, detail: String(labelOf(hit)).trim() };
    }, { isMail, want: packWant });
    if (!pack.ok) await stepFail(page, `梱包「${packWant}」を選べません(配送方法 ${ship} 側): ${pack.reason} ${JSON.stringify(pack.candidates || [])}`);
    console.log(`梱包: ${pack.detail}`);

    await clickNext(page, "#btn_ordershipping_next", "/businesscard/orderconfirm", "出荷/配送");

    // --- 5. 確認 ---
    const confirmLoc = page.locator("#order_confirm_tables").first();
    if ((await confirmLoc.count()) === 0) await stepFail(page, "#order_confirm_tables が見つかりません");
    const confirmText = (await confirmLoc.innerText().catch(() => "")).replace(/\n{3,}/g, "\n\n").trim();
    const shot = path.join(shotsDir(), `${stamp()}-${target.businesscardId}-confirm.png`);
    await page.screenshot({ path: shot, fullPage: true });

    console.log("--- 注文内容(確認画面) ---");
    console.log(confirmText);
    console.log("--- ここまで ---");
    console.log(`スクリーンショット: ${shot}`);

    if (!args.yes) {
      console.log("DRY RUN: 注文は確定していません。確定するには --yes を付けて再実行");
      return;
    }

    // --- 6. 確定 ---
    const fix = page.locator("#btn-fix-order").first();
    if ((await fix.count()) === 0) await stepFail(page, "#btn-fix-order が見つかりません");
    await fix.click();
    await page.waitForLoadState("networkidle").catch(() => {});
    const alerts = await page.locator(".alert").allInnerTexts().catch(() => []);
    console.log(`注文結果: ${alerts.map((a) => a.trim()).filter(Boolean).join(" / ") || "(メッセージなし)"} URL: ${page.url()}`);
    await assertNoAlert(page);

    await page.goto(`${BASE_URL}/businesscard/orderhistory`, { waitUntil: "networkidle", timeout: 60000 });
    const oh = parseTableRows(await page.content());
    console.log(`注文履歴ヘッダ: ${oh.headers.join(" | ") || "(取得できず)"}`);
    if (oh.rows.length) console.log(`最新の注文: ${oh.rows[0].join(" | ")}`);
  } catch (err) {
    if (err instanceof StepError) exitCode = 2;
    else {
      console.error("エラー:", err.message || err);
      exitCode = 1;
    }
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {
        // ignore
      }
    }
  }
  if (exitCode) process.exit(exitCode);
}

async function cmdHistory(args, creds) {
  const client = new Client(BASE_URL);
  await login(client, creds);
  const req = await client.request(`${BASE_URL}/businesscard/requesthistory`);
  const reqTable = parseTableRows(req.text);
  let reqRows = rowsToObjects(reqTable);
  const ord = await client.request(`${BASE_URL}/businesscard/orderhistory`);
  const ordTable = parseTableRows(ord.text);
  let ordRows = rowsToObjects(ordTable);

  if (args.query) {
    const q = String(args.query).replace(/[\s　]/g, "");
    const hit = (o) => o.cells.some((c) => c.replace(/[\s　]/g, "").includes(q));
    reqRows = reqRows.filter(hit);
    ordRows = ordRows.filter(hit);
  }

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          requestHeaders: reqTable.headers,
          requestRows: reqRows.map((o) => o.cells),
          orderHeaders: ordTable.headers,
          orderRows: ordRows.map((o) => o.cells),
        },
        null,
        2
      )
    );
    return;
  }

  console.log(`【申請履歴】${reqTable.headers.join(" | ")}`);
  if (!reqRows.length) console.log("  (該当なし)");
  for (const o of reqRows.slice(0, 30)) console.log("  " + o.cells.join(" | "));

  console.log(`【注文履歴】${ordTable.headers.join(" | ")}`);
  if (!ordRows.length) console.log("  (該当なし)");
  for (const o of ordRows.slice(0, 30)) console.log("  " + o.cells.join(" | "));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }
  if (!args.command) {
    printUsage();
    process.exit(2);
  }
  if (!["check", "apply", "order", "history"].includes(args.command)) {
    console.error(`不明なコマンド: ${args.command}`);
    printUsage();
    process.exit(2);
  }
  if (args.command !== "history" && !args.query) {
    console.error(`使い方: node tools/meishi-order.mjs ${args.command} <名前|社員ID|名刺ID>`);
    process.exit(2);
  }

  let creds;
  try {
    creds = loadCreds();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  if (args.command === "check") await cmdCheck(args, creds);
  else if (args.command === "apply") await cmdApply(args, creds);
  else if (args.command === "order") await cmdOrder(args, creds);
  else await cmdHistory(args, creds);
}

if (isEntry(import.meta.url)) {
  main().catch((err) => {
    console.error("エラー:", err.message || err);
    process.exit(1);
  });
}
