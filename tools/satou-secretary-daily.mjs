#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { isEntry } from "./is-entry.mjs";
import { getDriveToken } from "./lib/drive-auth.mjs";
import { gwsFetch, retrySource } from "./lib/gws-proxy.mjs";
import { searchGmail, compactMessage, extractBody, headerValue } from "./gmail-search.mjs";
import { readEnvValue } from "./env-kv.mjs";
import { sendDiscordDm } from "./discord-dm.mjs";
import { fetchHistory as fetchSendHistory, runLlm as checkSendContext } from "./send-context-check.mjs";
import { latestOf, writeContextMarker } from "./lib/send-context.mjs";
export const LEDGER_ID = "17h_x-1kdxI_92H_dXBydclLsxUmYKa-ut0P3begM_j0",
  MASTER_ID = "14RC6og1ma_I3LGHwCVwswKArgHwCOPxWlPB3g8adaYY";
export const LEDGER_URL = "https://docs.google.com/spreadsheets/d/17h_x-1kdxI_92H_dXBydclLsxUmYKa-ut0P3begM_j0/edit?usp=sharing";
export const LEDGER_FOOTER = `佐藤担当案件台帳\n${LEDGER_URL}`;
export const TABS = [
  "自動_案件",
  "自動_今日の要対応",
  "自動_実行ログ",
  "自動_百貨店受信（未対応か要判断）",
  "自動_社長報告",
];
const USER = "seisaku-team@orgiast.jp",
  STAFF = [
    "営業スタッフ",
    "企画スタッフ",
    "営業ｻﾌﾞP",
    "営業P",
    "制作スタッフ",
    "制作ｻﾌﾞP",
    "制作P",
    "アシスタント",
  ],
  ACTIVE = new Set(["確定", "アプローチリスト"]),
  CLOSED = new Set(["納品完了", "失注"]);
const norm = (x) =>
    String(x ?? "")
      .normalize("NFKC")
      .replace(/[\s　]+/g, ""),
  txt = (x) => String(x ?? "").trim(),
  fmt = (d) =>
    new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(d);
const FREE_MAIL_DOMAINS = new Set(["gmail.com","googlemail.com","yahoo.co.jp","yahoo.com","outlook.com","outlook.jp","hotmail.com","hotmail.co.jp","icloud.com","me.com","live.jp","aol.com","msn.com","proton.me","protonmail.com"]);
const addresses = value => String(value || "").toLowerCase().match(/[\w.+-]+@[\w.-]+/g) || [];
const customerAddress = address => {
  const [local, domain] = address.split("@");
  return domain && !/(^|\.)(orgiast\.jp|event-shop\.jp|imitsu\.jp|proni\.jp|github\.com|google\.com|slack\.com|discord\.com)$/.test(domain) &&
    !FREE_MAIL_DOMAINS.has(domain) && !/^(?:no-?reply|notifications?|mailer-daemon|bounce)(?:[+._-]|$)/.test(local) &&
    !/^(?:no-?reply|notifications?)\./.test(domain);
};
const emailAddress = value => sender(String(value || "")).email.toLowerCase();
const emailDomain = value => emailAddress(value).split("@")[1] || "";
const clientKey = value => norm(value).replace(/株式会社|合同会社|有限会社|一般社団法人|医療法人/g, "").replace(/㈱/g, "");
export function isSatouCustomerMail(message = {}) {
  if (emailAddress(message.from) !== "satou@orgiast.jp") return false;
  if (/^\s*(?:Fwd?:)|\bLEAD\s*:/i.test(message.subject || "")) return false;
  return addresses(`${message.to || ""},${message.cc || ""}`).some(customerAddress);
}
export function headerMap(h) {
  return new Map(h.map((x, i) => [norm(x), i]));
}
const col = (m, ...n) => {
  for (const x of n) if (m.has(norm(x))) return m.get(norm(x));
  return -1;
};
export function sheetDate(v) {
  if (typeof v === "number")
    return new Date(Date.UTC(1899, 11, 30) + v * 864e5);
  const m = txt(v).match(/(20\d{2})[\/.-](\d{1,2})[\/.-](\d{1,2})/);
  return m
    ? new Date(
        `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}T00:00:00+09:00`,
      )
    : null;
}
export function extractCases(rows, now = new Date(), emailEvidence = []) {
  if (!rows.length) throw Error("案件一覧が空です");
  const m = headerMap(rows[0]),
    i = {
      state: col(m, "予算項目"),
      code: col(m, "ｺｰﾄﾞ", "コード"),
      client: col(m, "クライアント名"),
      name: col(m, "案件名"),
      delivery: col(m, "納品日"),
      sales: col(m, "営業"),
      prod: col(m, "制作"),
      route: col(m, "案件ルート"),
      revenue: col(m, "売上"),
      plan: col(m, "実施計画URL"),
      estimate: col(m, "見積書URL"),
    };
  if (
    [
      "state",
      "code",
      "client",
      "name",
      "delivery",
      "sales",
      "prod",
      "route",
    ].some((k) => i[k] < 0)
  )
    throw Error("案件一覧の必須ヘッダーなし");
  const staff = STAFF.map((x) => col(m, x)).filter((x) => x >= 0),
    cut = new Date(now);
  cut.setDate(cut.getDate() - 30);
  return rows.slice(1).flatMap((r, n) => {
    const state = txt(r[i.state]),
      sales = norm(r[i.sales]).includes("佐藤優奈"),
      production = norm(r[i.prod]).includes("佐藤優奈"),
      departmentStore = /社内イベント百貨店|event-shop/i.test(txt(r[i.route])),
      secondary = staff.some((x) => norm(r[x]).includes("佐藤優奈")),
      emailOwner = emailEvidence.some((x) => {
        if (!isSatouCustomerMail(x)) return false;
        const blob = norm(
          `${x.subject || ""} ${x.snippet || ""} ${x.from || ""} ${x.to || ""}`,
        ),
          customerKey = clientKey(r[i.client]),
          codeKey = norm(txt(r[i.code])).replace(/_\d+$/, "");
        if (!customerKey || /オージャスト/.test(customerKey)) return false;
        return (
          ((codeKey.length >= 5 && blob.includes(codeKey)) ||
            (customerKey.length >= 4 && blob.includes(customerKey))) &&
          emailAddress(x.from) === "satou@orgiast.jp"
        );
      }),
      d = sheetDate(r[i.delivery]),
      horizon = new Date(now.getTime() + 90 * 864e5),
      workloadWindow = !d || (d >= cut && d <= horizon),
      secondaryOwner = secondary && workloadWindow,
      recentEmailOwner = emailOwner && workloadWindow;
    if (
      (!sales &&
        !production &&
        !departmentStore &&
        !(secondaryOwner && ACTIVE.has(state)) &&
        !recentEmailOwner) ||
      (CLOSED.has(state) && d && d < cut)
    )
      return [];
    const reason = [
      sales && "営業",
      production && "制作",
      departmentStore && "百貨店ルート",
      secondaryOwner && "担当者列",
      recentEmailOwner && "メール担当",
    ]
      .filter(Boolean)
      .join("・");
    return [
      {
        code: txt(r[i.code]),
        client: txt(r[i.client]),
        name: txt(r[i.name]),
        state,
        sales: txt(r[i.sales]),
        production: txt(r[i.prod]),
        route: txt(r[i.route]),
        reason,
        delivery: d,
        deliveryText: d ? fmt(d) : txt(r[i.delivery]),
        revenue: r[i.revenue] ?? "",
        plan: txt(r[i.plan]),
        estimate: txt(r[i.estimate]),
        masterRow: n + 2,
      },
    ];
  });
}
const gmailUrl = (id) =>
  `https://mail.google.com/mail/?authuser=${encodeURIComponent(USER)}#all/${id}`;
export function extractAimitsu(ms) {
  const out = [],
    seen = new Set();
  for (const x of ms) {
    if (!/@imitsu\.jp/i.test(x.from || "")) continue;
    const h = `${x.subject || ""}\n${x.snippet || ""}\n${x.body || ""}`,
      no = h.match(/案件\s*(?:No|番号)\s*[:：#]?\s*([\w-]+)/i)?.[1] || "",
      company =
        h.match(/企業名\s*[:：]\s*([^\n]+)/)?.[1]?.trim() ||
        h.match(/([^\n]{1,80})様からのメッセージ/)?.[1]?.trim() ||
        "",
      unanswered = /未回答案件|未回答|回答期限/.test(h),
      k = `${x.threadId}|${no}|${company}`;
    if ((no || company || unanswered) && !seen.has(k)) {
      seen.add(k);
      out.push({
        caseNo: no,
        company,
        unanswered,
        subject: x.subject || "",
        threadId: x.threadId,
        url: gmailUrl(x.threadId),
      });
    }
  }
  return out;
}
async function api(
  url,
  { token, method = "GET", body, fetchImpl = gwsFetch } = {},
) {
  const r = await fetchImpl(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(3e4),
    }),
    s = await r.text();
  if (!r.ok) {
    const target = new URL(url),
      detail = body?.requests
        ? ` requests=${body.requests.map((x, i) => `${i}:${Object.keys(x)[0]}`).join(",")}`
        : "";
    throw Error(
      `Google API ${r.status} ${method} ${target.pathname}${target.search}: ${s.slice(0, 500)}${detail}`,
    );
  }
  return s ? JSON.parse(s) : {};
}
const token = (scope, user = USER) =>
  getDriveToken({ scope, impersonate: user, signal: AbortSignal.timeout(3e4) });
export async function readSheet(id, range, deps = {}) {
  const t = await (
    deps.getSheetsToken ||
    (() => token("https://www.googleapis.com/auth/spreadsheets"))
  )();
  return (
    (
      await api(
        `https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${encodeURIComponent(range)}?valueRenderOption=UNFORMATTED_VALUE`,
        { token: t, fetchImpl: deps.fetchImpl },
      )
    ).values || []
  );
}
const sender = (s) => ({
  name: (s.match(/^(.*?)\s*</)?.[1] || s).replace(/^"|"$/g, ""),
  email: s.match(/[\w.+-]+@[\w.-]+/)?.[0] || "",
});
export function classifyDepartmentStoreThread(messages = []) {
  const ordered = [...messages].sort(
      (a, b) => +a.internalDate - +b.internalDate,
    ),
    compact = ordered.map((x) => (x.payload ? compactMessage(x) : x)),
    outgoing = compact.filter((x) =>
      /@(?:orgiast\.jp)/i.test(sender(x.from).email),
    ),
    customer = outgoing.some((x) =>
      /社内イベント百貨店の森|佐藤/.test(x.from || ""),
    ),
    addressedToInfo = compact.some((x) =>
      /info@event-shop\.jp/i.test(x.to || ""),
    ),
    last = compact.at(-1),
    lastSender = sender(last?.from || "");
  return {
    isDepartmentStore: compact.some((x) =>
      /社内イベント百貨店|event-shop\.jp/i.test(
        `${x.from || ""} ${x.to || ""} ${x.subject || ""} ${x.snippet || ""}`,
      ),
    ),
    judgment: addressedToInfo && !outgoing.length,
    customer,
    last,
    lastSender,
    unanswered: !!lastSender.email && !/@orgiast\.jp$/i.test(lastSender.email),
  };
}
async function mail(deps = {}) {
  const q =
      'newer_than:2d ((from:satou@orgiast.jp OR to:satou@orgiast.jp OR cc:satou@orgiast.jp OR "佐藤 優奈" OR "佐藤優奈" OR from:imitsu.jp) OR ("社内イベント百貨店" OR to:info@event-shop.jp OR from:event-shop.jp)) -from:saiyo@orgiast.jp -to:saiyo@orgiast.jp',
    r = await (deps.searchGmail || searchGmail)({
      user: USER,
      query: q,
      max: 100,
      withBody: true,
      bodyLimit: 8000,
      concurrency: 3,
    }),
    t = await token("https://www.googleapis.com/auth/gmail.readonly"),
    threads = [
      ...new Map(r.messages.map((x) => [x.threadId, x])).values(),
    ].map((x) => ({ ...x, url: gmailUrl(x.threadId) })),
    messages = [],
    unanswered = [],
    departmentStoreJudgment = [],
    departmentStoreCustomers = [];
  for (const x of threads) {
    const d = await api(
        `https://gmail.googleapis.com/gmail/v1/users/me/threads/${x.threadId}?format=full`,
        { token: t, fetchImpl: deps.fetchImpl },
      ),
      threadMessages = (d.messages || []).map(m => ({ ...compactMessage(m), cc: headerValue(m.payload, "cc"), body: extractBody(m.payload, 8000), url: gmailUrl(x.threadId) })).sort((a,b) => +a.internalDate - +b.internalDate),
      classification = classifyDepartmentStoreThread(threadMessages),
      c = classification.last || x,
      w = classification.lastSender.email
        ? classification.lastSender
        : sender(c.from),
      item = { ...c, sender: w, url: gmailUrl(c.threadId || x.threadId) };
    messages.push(...threadMessages.map(m => ({ ...m, latestSender: c.from, latestDirection: emailDomain(c.from) === "orgiast.jp" ? "自社" : "先方" })));
    if (classification.isDepartmentStore && classification.judgment)
      departmentStoreJudgment.push(item);
    else if (classification.isDepartmentStore && classification.customer)
      departmentStoreCustomers.push({
        ...item,
        unanswered: classification.unanswered,
      });
    else if (w.email && !/@orgiast\.jp$/i.test(w.email)) unanswered.push(item);
  }
  return {
    messages,
    unanswered,
    departmentStoreJudgment,
    departmentStoreCustomers,
    aimitsu: extractAimitsu(r.messages),
  };
}
async function calendar(now, deps = {}) {
  const end = new Date(now);
  end.setDate(end.getDate() + 14);
  const out = [];
  for (const u of [USER, "kim@orgiast.jp"]) {
    const t = await token(
        "https://www.googleapis.com/auth/calendar.readonly",
        u,
      ),
      q = new URLSearchParams({
        timeMin: jstDayRange(now).end.toISOString(),
        timeMax: end.toISOString(),
        singleEvents: "true",
        orderBy: "startTime",
        maxResults: "250",
      }),
      d = await api(
        `https://www.googleapis.com/calendar/v3/calendars/primary/events?${q}`,
        { token: t, fetchImpl: deps.fetchImpl },
      );
    for (const e of d.items || []) {
      const a = (e.attendees || []).map((x) => x.email?.toLowerCase()),
        o = e.organizer?.email?.toLowerCase();
      if (
        a.includes("satou@orgiast.jp") ||
        a.includes("matsumoto.y.work@gmail.com") ||
        o === "matsumoto.y.work@gmail.com"
      )
        out.push(e);
    }
  }
  return [...new Map(out.map((x) => [x.id, x])).values()];
}
async function tldv(cases, now, deps = {}) {
  const key =
    process.env.TLDV_API_KEY ||
    readEnvValue(
      path.join(os.homedir(), ".claude", "tldv.env"),
      "TLDV_API_KEY",
    );
  if (!key) return { items: [], note: "tl;dv キーなし" };
  const from = new Date(now);
  from.setDate(from.getDate() - 7);
  const r = await (deps.fetchImpl || fetch)(
      `https://pasta.tldv.io/v1alpha1/meetings?${new URLSearchParams({ from: from.toISOString(), to: now.toISOString(), page: "1", limit: "100" })}`,
      { headers: { "x-api-key": key } },
    ),
    d = await r.json(),
    need = cases.flatMap((x) => [x.code, x.client]).filter(Boolean);
  return {
    items: (d.results || [])
      .filter((x) => need.some((n) => norm(x.name).includes(norm(n))))
      .map((x) => ({
        name: x.name,
        date: x.happenedAt,
        url: x.url || `https://tldv.io/app/meetings/${x.id}`,
      })),
    note: "",
  };
}
export function jstDayRange(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Tokyo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(now),
    v = Object.fromEntries(parts.map((x) => [x.type, x.value])),
    today = new Date(`${v.year}-${v.month}-${v.day}T00:00:00+09:00`),
    start = new Date(today.getTime() - 864e5);
  return { start, end: today, date: fmt(start) };
}
export function isInPreviousJstDay(value, now = new Date()) {
  const { start, end } = jstDayRange(now),
    d = value instanceof Date ? value : new Date(Number(value) || value);
  return d >= start && d < end;
}
const baseCode = (x) => txt(x).replace(/_\d+$/, "");
export function aggregateActiveCases(cases = []) {
  const by = new Map();
  for (const x of cases) {
    if (CLOSED.has(x.state) || !txt(x.code)) continue;
    const k = baseCode(x.code);
    if (!by.has(k)) by.set(k, { ...x });
    else {
      const previous = by.get(k), reason = [...new Set(`${previous.reason || ""}・${x.reason || ""}`.split("・").filter(Boolean))].join("・");
      by.set(k, { ...(x.state === "確定" ? x : previous), reason });
    }
  }
  const values = [...by.values()];
  const reasonCounts = {};
  for (const item of values)
    for (const reason of String(item.reason || "").split("・").filter(Boolean))
      reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
  return {
    total: values.length,
    confirmed: values.filter((x) => x.state === "確定").length,
    adjusting: values.filter((x) => x.state !== "確定").length,
    values,
    reasonCounts,
    unnumbered: cases.filter(x => !CLOSED.has(x.state) && !txt(x.code)),
  };
}
export function currentMessageBody(message) {
  return String(message.body || message.snippet || "").split(/^\s*(?:On .+wrote:|20\d{2}年\d{1,2}月\d{1,2}日.*[：:]|From:|差出人[:：]|-+Original Message-+|>)/mi)[0].trim();
}
const clip = (s, n = 44) => {
  s = txt(s).replace(/\s+/g, " ");
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};
export async function askReportLlm(prompt, deps = {}) {
  if (deps.askLlm) return deps.askLlm(prompt);
  const tool = fileURLToPath(new URL("./llm-ask.mjs", import.meta.url)),
    run = promisify(execFile),
    attempts = [
      ["gemini", "gemini-3.6-flash"],
      ["deepseek", "deepseek-chat"],
      ["groq", "openai/gpt-oss-120b"],
    ],
    fail = [],
    promptDir = fs.mkdtempSync(path.join(os.tmpdir(), "satou-report-prompt-")),
    promptFile = path.join(promptDir, "prompt.txt");
  fs.writeFileSync(promptFile, prompt, "utf8");
  try {
  for (const [provider, model] of attempts)
    try {
      const { stdout } = await run(
        process.execPath,
        [
          tool,
          "--provider",
          provider,
          "--model",
          model,
          "--prefer-provider",
          "--no-fallback",
          "--category",
          "summarize",
          "--max",
          "700",
          "--prompt-file", promptFile,
        ],
        { timeout: 90000, maxBuffer: 1024 * 1024, windowsHide: true },
      );
      const out = txt(stdout);
      if (out && out !== "(出力なし)") return out;
    } catch (e) {
      fail.push(`${provider}: ${e.message}`);
    }
  throw Error(`LLM全滅: ${fail.join(" | ")}`);
  } finally { fs.rmSync(promptDir, { recursive: true, force: true }); }
}
export function caseForMessage(message, cases) {
  const blob = norm(
    `${message.subject || ""} ${message.snippet || ""} ${currentMessageBody(message)} ${message.from || ""} ${message.to || ""}`,
  );
  return cases.find((x) =>
    [baseCode(x.code), ...(/オージャスト/.test(x.client) ? [] : [x.name, clientKey(x.client)])]
      .filter(Boolean)
      .some((v) => norm(v).length >= 3 && blob.includes(norm(v))),
  );
}
function fallbackMovement(messages) {
  return `${txt(messages.at(-1)?.subject) || "メールの更新あり"}。`;
}
const personToken = value => txt(value).replace(/^['"]|['"]$/g, "")
  .replace(/(?:株式会社|合同会社|有限会社|一般社団法人|御中|ご担当者?|担当)$/g, "").trim()
  .split(/[\s　]+/).at(-1)?.replace(/(?:様|氏|さん)$/g, "") || "";
export function threadPersonNames(messages = []) {
  const names = new Set();
  for (const message of messages) {
    for (const header of [message.from, message.to, message.cc])
      for (const part of String(header || "").split(/[,;]/)) {
        const display = part.match(/^\s*"?([^"<]+?)"?\s*</)?.[1];
        if (display) {
          const name = personToken(display);
          if (/^[一-龯々ぁ-んァ-ヶー]{1,12}$/.test(name)) names.add(name);
        }
      }
    for (const line of currentMessageBody(message).split(/\r?\n/).slice(-8)) {
      const match = line.trim().match(/^(?:代表取締役|取締役|部長|課長|担当)?\s*([一-龯々ぁ-んァ-ヶー]{1,6}(?:[\s　]+[一-龯々ぁ-んァ-ヶー]{1,6})?)(?:様|氏|さん)?$/);
      if (match) names.add(personToken(match[1]));
    }
  }
  return names;
}
export function replaceUnknownPersonNames(value, allowedNames) {
  return String(value || "").replace(/([一-龯々]{1,4}|[ァ-ヶー]{2,10})(様|氏|さん)/g, (all, name) =>
    [...allowedNames].some(allowed => allowed === name || allowed.endsWith(name) || name.endsWith(allowed)) ? all : "先方");
}
export function completeReportSentence(value, maxLength) {
  let line = txt(value).replace(/^[\s・*-]+/, "").replace(/\s+/g, " ").replace(/[.…]+$/g, "");
  if (line.length <= maxLength) {
    if (!/[。！？]$/.test(line)) line = line.length < maxLength ? `${line}。` : `${line.slice(0, maxLength - 1)}。`;
    return line;
  }
  const sentences = line.match(/[^。！？]*[。！？]/g) || [];
  let fitted = "";
  for (const sentence of sentences) {
    if ((fitted + sentence).length > maxLength) break;
    fitted += sentence;
  }
  return fitted || `${line.slice(0, Math.max(0, maxLength - 1)).replace(/[.…]+$/g, "")}。`;
}
export function finalizeReportLine(value, maxLength = 70) {
  const line = String(value || ""), match = line.match(/^(・|\d+\.\s+)/), prefix = match?.[0] || "";
  if (line.length <= maxLength && !/[.…]+$/.test(line)) return line;
  return `${prefix}${completeReportSentence(line.slice(prefix.length), Math.max(1, maxLength - prefix.length))}`;
}
export function capReportLines(lines, max = 25) {
  if (lines.length <= max) return lines;
  const result = [...lines];
  // Keep every section and all three priorities. Shorten the largest earlier section.
  while (result.length > max) {
    const sections = result.flatMap((line, i) => line.startsWith("■") ? [i] : []);
    const candidates = sections.slice(1, -1).map(i => ({ start: i + 1, end: sections.find(j => j > i) ?? result.length }))
      .filter(s => s.end - s.start > 1).sort((a,b) => (b.end-b.start)-(a.end-a.start));
    if (!candidates.length) break;
    const s = candidates[0];
    result.splice(s.end - 1, 1);
    result[s.end - 2] = "・ほか（台帳の明細参照）";
  }
  return result;
}
export const customerLabel = c => clip(String(c?.client || c?.name || "").replace(/株式会社|合同会社|有限会社/g, "").replace("鹿沼ケーブルテレビ", "鹿沼CATV"), 24);
const actionDate = value => {
  const m = String(value).match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  return m ? new Date(`${m[1]}-${m[2].padStart(2,"0")}-${m[3].padStart(2,"0")}T${(m[4]||"00").padStart(2,"0")}:${m[5]||"00"}:${m[6]||"00"}+09:00`).getTime() : Infinity;
};
export function prioritizeActions(actions, now) {
  const rank = x => x[0] === "予定" ? (Number.isFinite(actionDate(x[1])) && fmt(new Date(actionDate(x[1]))) === fmt(now) ? 0 : 3) : x[0] === "納品期限" ? 1 : 2;
  return actions.filter(x => x[4] !== "対応済み" && !(x[0] === "予定" && /採用|面談|面接|中途/.test(`${x[2]} ${x[3]}`)))
    .sort((a,b) => rank(a)-rank(b) || actionDate(a[1])-actionDate(b[1])).slice(0,3);
}
const priorityCase = (action, cases) => {
  const blob = norm(`${action[2] || ""} ${action[3] || ""}`);
  return cases.find(c => [baseCode(c.code), c.client, c.name].filter(Boolean)
    .some(value => norm(value).length >= 3 && blob.includes(norm(value))));
};
export function eligiblePriorityActions(actions, cases, now) {
  return prioritizeActions(actions.filter(action => {
    const item = priorityCase(action, cases);
    if (!item) return true;
    return !CLOSED.has(item.state) && String(item.reason || "") !== "百貨店ルート";
  }), now);
}
export function calendarPriorityText(action) {
  const at = new Date(actionDate(action[1]));
  const time = Number.isFinite(+at)
    ? new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit", hour12: false }).format(at)
    : "";
  const raw = txt(action[2]), category = raw.match(/^【([^】]+)】/)?.[1] || "予定";
  const subject = raw.replace(/^【[^】]+】\s*/, "").replace(/（.*$/, "").trim();
  const counterpart = subject.match(/^(.+?様)(?:\s|$)/)?.[1] || subject.split(/\s+/)[0] || "(無題)";
  return `${time} ${counterpart} ${category}`.trim();
}
export async function buildDailyReport(
  {
    now = new Date(),
    cases = [],
    messages = [],
    actions = [],
    calendar = [],
  } = {},
  deps = {},
) {
  const counted = aggregateActiveCases(cases),
    yesterday = messages.filter((x) => isInPreviousJstDay(x.internalDate, now) && caseForMessage(x, cases) &&
      addresses(`${x.from || ""} ${x.to || ""} ${x.cc || ""}`).some(a => !a.endsWith("@orgiast.jp")) &&
      !/^\s*Fwd?:|\bLEAD\s*:/i.test(x.subject || "")),
    groups = new Map();
  for (const m of yesterday) {
    const c = caseForMessage(m, cases),
      participants = `${m.from || ""} ${m.to || ""} ${m.cc || ""}`,
      internalOnly = [...participants.matchAll(/[\w.+-]+@[\w.-]+/g)].every(x => /@orgiast\.jp$/i.test(x[0]));
    if (!c || internalOnly || /^\s*Fwd:/i.test(m.subject || "") || /\bLEAD\s*:/i.test(m.subject || "")) continue;
    const
      key = `${baseCode(c?.code) || c?.client || "case"}|${m.threadId || m.id}`;
    if (!groups.has(key)) groups.set(key, { caseItem: c, messages: [] });
    groups.get(key).messages.push(m);
  }
  const movements = [],
    details = [],
    llmErrors = [];
  for (const g of groups.values()) {
    g.messages.sort((a,b) => +a.internalDate - +b.internalDate);
    const input = g.messages.map((x) => ({
      at: new Date(+x.internalDate).toISOString(),
      subject: x.subject || "",
      sender: x.from || "",
      snippet: x.snippet || "",
      body: currentMessageBody(x),
      latestSender: x.latestSender || x.from,
      latestDirection: x.latestDirection || (emailDomain(x.from) === "orgiast.jp" ? "自社" : "先方"),
      direction: /@orgiast\.jp/i.test(sender(x.from || "").email)
        ? "自社送信"
        : "先方送信",
    }));
    const label = customerLabel(g.caseItem),
      summaryLimit = Math.max(10, 70 - `・${label}：`.length),
      allowedNames = threadPersonNames(g.messages),
      prompt = `社長への報告本文を日本語${summaryLimit}字以内の完結した1文で書く。末尾を省略記号にしない。顧客名は見出しにあるので繰り返さず、佐藤の実施内容と先方からの要望・返事を最大2点、事実だけで書く。この入力は1案件の1スレッドだけであり、他の案件やスレッドの情報を補わない。人名はFrom／Toの表示名または本文の署名にある名前だけを使い、それ以外は「先方」と書く。使用可能な人名: ${[...allowedNames].join("、") || "なし"}。最終メッセージの送信者: ${g.messages.at(-1).latestSender || g.messages.at(-1).from}（${g.messages.at(-1).latestDirection || input.at(-1).direction}）。時系列順に読み、引用された過去メールを今回の発言と混同しない。確定・相談・依頼を厳密に区別し、推測で「確定」と書かない。希望日時は希望と書く。予定人数と氏名が確定した人数を区別し、未定・後日連絡は未定のまま書く。誰が誰に頼んだかを逆転させない。JSONや前置き不要。\n${JSON.stringify(input)}`;
    let summary;
    try {
      let raw = replaceUnknownPersonNames(await askReportLlm(prompt, deps), allowedNames);
      if (txt(raw).replace(/\s+/g, " ").length > summaryLimit)
        raw = replaceUnknownPersonNames(await askReportLlm(`次の文を事実関係と使用可能な人名を変えず、日本語${summaryLimit}字以内の完結した1文に再要約する。末尾を「…」にしない。使用可能な人名: ${[...allowedNames].join("、") || "なし"}。前置き不要。\n${raw}`, deps), allowedNames);
      summary = completeReportSentence(raw, summaryLimit);
    } catch (e) {
      summary = completeReportSentence(fallbackMovement(g.messages), summaryLimit);
      llmErrors.push(e.message);
    }
    const url = g.messages[0]?.url || gmailUrl(g.messages[0]?.threadId);
    movements.push(`・${label}：${summary}`);
    details.push(["昨日の動き", summary, g.caseItem?.code || "", url]);
  }
  const problems = [];
  for (const x of actions) {
    if (x[0] === "未返信メール") {
      const d = actionDate(x[1]);
      if (now - d >= 864e5)
        problems.push({
          text: `${x[3]}への返信が24時間以上未対応`,
          action: `佐藤：${x[3]}へ本日中に返信`,
          deadline: "本日",
          code: "",
          url: x[5],
        });
    }
  }
  const week = new Date(now.getTime() + 7 * 864e5);
  for (const x of cases)
    if (x.delivery && x.delivery >= now && x.delivery <= week && !x.plan)
      problems.push({
        text: `${x.client || x.name}の実施計画URLが未登録`,
          action: `佐藤：${customerLabel(x)}の実施計画を${x.deliveryText}までに登録`,
        deadline: x.deliveryText,
        code: x.code,
        url: x.estimate,
      });
  const palace = cases.find(x => baseCode(x.code) === "261102PAL");
  if (palace && palace.state === "アプローチリスト")
    problems.push({
      text: "パレスはキャンセル済みだがマスターがアプローチリストのまま",
      action: "パレスのキャンセル反映待ち（AI用アカウントの編集権限の付与待ち）",
      deadline: "本日",
      code: palace.code,
      url: palace.estimate || palace.plan,
    });
  if (yesterday.length)
    try {
      const raw = await askReportLlm(
        `基準日は${fmt(now)}。次のメールから問題候補を抽出。対象は(1)自社送信本文に明記された約束期日が基準日から3日以内 (2)キャンセル・辞退等と案件状態の明白な食い違い。期日が明記されていないもの、単なる出席者変更、先方へ依頼した回答期限、未着だった場合という仮定・推測は除外。未来の期日を「過ぎた」と書かない。確定・相談・依頼を区別し、最終送信者を確認。各行を「問題候補: 何が起きているか|YYYY-MM-DDの期限|案件コード|佐藤：誰に何をいつまでにするか」の4列とし、事実と対応文を重複させない。なければ「なし」。\n${JSON.stringify(yesterday.map((x) => ({ subject: x.subject, from: x.from, body: currentMessageBody(x), latestSender: x.latestSender, latestDirection: x.latestDirection, case: caseForMessage(x, cases) })))}`,
        deps,
      );
      if (txt(raw) !== "なし")
        for (const line of raw.split(/\r?\n/).filter((x) => x.includes("|"))) {
          const fields = line.replace(/^[-・*\d.\s]+/, "").split("|");
          const [text, deadline = "要確認", code = "", action = ""] = fields.map(txt);
          const deadlineDate = /^20\d{2}-\d{2}-\d{2}$/.test(deadline)
            ? new Date(`${deadline}T23:59:59+09:00`)
            : null;
          if (
            fields.length === 4 && action && !/場合|可能性|かもしれ/.test(text) && cases.some(c => baseCode(c.code) === baseCode(code)) &&
            /^問題候補[:：]/.test(text) &&
            !/^(?:問題候補[:：]\s*)?(?:なし|無し)$/i.test(txt(text)) &&
            (!deadlineDate ||
              deadlineDate <= new Date(now.getTime() + 3 * 864e5))
          )
            problems.push({
              text: clip(text.replace(/^問題候補[:：]\s*/, "")),
              action: clip(action, 76),
              deadline: clip(deadline, 18),
              code: txt(code),
              url: yesterday[0]?.url || "",
            });
        }
    } catch (e) {
      llmErrors.push(e.message);
    }
  const uniqueProblems = [
    ...new Map(problems.map((x) => [`${x.text}|${x.code}`, x])).values(),
  ];
  const judgment = [];
  if (yesterday.length)
    try {
      const raw = await askReportLlm(
        `次のメールから社長判断が必要な具体的依頼だけを抽出。値引き、金額変更、キャンセル料、契約条件、外注先の選定・変更、方針変更、権限付与が対象。単なる発注・業務確定・日程連絡・申込書依頼は除外。カテゴリ名だけは出力しない。該当なしは「なし」の1語。該当ありは各行を必ず「判断候補: 具体的事項」の形式にし、前置き不要。\n${JSON.stringify(yesterday.map((x) => ({ subject: x.subject, from: x.from, snippet: x.snippet })))}`,
        deps,
      );
      if (txt(raw) !== "なし")
        for (const line of raw
          .split(/\r?\n/)
          .map((x) => x.replace(/^[-・*\d.\s]+/, ""))
          .filter(
            (x) =>
              /^判断候補[:：]/.test(x) &&
              /値引|金額変更|キャンセル料|契約条件|外注先(?:の選定|の変更|を選)|方針変更|権限/.test(x),
          ))
          if (!/パレス.*キャンセル/.test(line))
            judgment.push(clip(line.replace(/^判断候補[:：]\s*/, "")));
    } catch (e) {
      llmErrors.push(e.message);
    }
  const sorted = eligiblePriorityActions(actions, cases, now),
    md = new Intl.DateTimeFormat("ja-JP", {
      timeZone: "Asia/Tokyo",
      month: "numeric",
      day: "numeric",
      weekday: "short",
    }).format(jstDayRange(now).start),
    visibleMovements = movements.slice(0, 8),
    movementLines =
      movements.length > 8
        ? [
            ...visibleMovements,
            `・ほか${movements.length - 8}件（台帳の明細参照）`,
          ]
        : visibleMovements,
    lines = [
      `【業務報告 ${md} 佐藤】`,
      `■担当案件：計${counted.total}件（確定${counted.confirmed}件／提案・調整中${counted.adjusting}件）`,
      "■昨日の動き",
      ...(movementLines.length ? movementLines : ["・なし"]),
      "■問題点",
      ...(uniqueProblems.length
        ? uniqueProblems.map((x) => `・${clip(x.text)}`)
        : ["・なし"]),
      "■解決が必要なこと",
      ...(uniqueProblems.length
        ? uniqueProblems.map((x) => `・${clip(x.action, 76)}`)
        : ["・なし"]),
      "■社長判断が必要なこと",
      ...(judgment.length ? judgment.map((x) => `・${x}`) : ["・なし"]),
      "■今日の優先",
      ...(sorted.length
        ? sorted.map((x, i) => `${i + 1}. ${clip(x[0] === "予定" ? calendarPriorityText(x) : `${x[3] && x[3] !== x[2] ? `${x[3]}：` : ""}${x[2]}`, 76)}`)
        : ["・なし"]),
    ],
    capped = capReportLines(lines).map(line => finalizeReportLine(line));
  for (const x of uniqueProblems)
    details.push(["問題点", x.text, x.code, x.url]);
  for (const x of judgment)
    details.push([
      "社長判断",
      x,
      "",
      yesterday[0]?.url || gmailUrl(yesterday[0]?.threadId || ""),
    ]);
  sorted.forEach((x) => details.push(["今日の優先", x[2], x[3], x[5]]));
  return {
    text: `${capped.join("\n")}\n\n${LEDGER_FOOTER}`,
    lines: capped,
    details,
    counted,
    llmErrors,
    date: jstDayRange(now).date,
  };
}
const cell = (v) => ({ userEnteredValue: { stringValue: String(v ?? "") } });
export async function write(p, deps = {}) {
  const t = await (
      deps.getSheetsToken ||
      (() => token("https://www.googleapis.com/auth/spreadsheets"))
    )(),
    call = (body) =>
      api(
        `https://sheets.googleapis.com/v4/spreadsheets/${LEDGER_ID}:batchUpdate`,
        { token: t, method: "POST", body, fetchImpl: deps.fetchImpl },
      ),
    meta = await api(
      `https://sheets.googleapis.com/v4/spreadsheets/${LEDGER_ID}?fields=sheets.properties`,
      { token: t, fetchImpl: deps.fetchImpl },
    ),
    base = meta.sheets.find(
      (x) => x.properties.title === "シート1",
    )?.properties;
  if (!base) throw Error("シート1なし");
  const before = await readSheet(LEDGER_ID, "'シート1'!A:L", {
      getSheetsToken: async () => t,
      fetchImpl: deps.fetchImpl,
    }),
    beforeTop = before.slice(0, 5),
    ids = new Map(
      meta.sheets.map((x) => [x.properties.title, x.properties.sheetId]),
    ),
    columns = new Map(
      meta.sheets.map((x) => [
        x.properties.title,
        x.properties.gridProperties?.columnCount || 0,
      ]),
    ),
    failures = [];
  for (const title of TABS)
    if (!ids.has(title)) {
      const id = Math.max(0, ...ids.values()) + 1;
      try {
        await call({
          requests: [
            {
              addSheet: {
                properties: {
                  sheetId: id,
                  title,
                  gridProperties: {
                    rowCount: 1000,
                    columnCount: 26,
                    frozenRowCount: 1,
                  },
                },
              },
            },
          ],
        });
        ids.set(title, id);
        columns.set(title, 26);
      } catch (e) {
        failures.push(`${title} 作成: ${e.message}`);
      }
    }
  const writeTab = async (title, rows) => {
    const id = ids.get(title);
    if (id === undefined) throw Error("タブIDなし");
    const w = Math.max(...rows.map((x) => x.length)),
      requests = [];
    if ((columns.get(title) || 0) < w)
      requests.push({
        appendDimension: {
          sheetId: id,
          dimension: "COLUMNS",
          length: w - (columns.get(title) || 0),
        },
      });
    requests.push(
      {
        repeatCell: {
          range: {
            sheetId: id,
            startRowIndex: 0,
            endRowIndex: 1000,
            startColumnIndex: 0,
            endColumnIndex: Math.max(26, w),
          },
          cell: {},
          fields: "userEnteredValue",
        },
      },
      {
        updateCells: {
          range: { sheetId: id, startRowIndex: 0, startColumnIndex: 0 },
          rows: rows.map((r) => ({
            values: Array.from({ length: w }, (_, i) => cell(r[i])),
          })),
          fields: "userEnteredValue",
        },
      },
    );
    await call({ requests });
    columns.set(title, Math.max(columns.get(title) || 0, w));
  };
  for (const title of TABS.filter((x) => x !== "自動_実行ログ"))
    try {
      await writeTab(title, p.tables[title]);
    } catch (e) {
      failures.push(`${title} 更新: ${e.message}`);
    }
  const log = p.tables["自動_実行ログ"];
  log[1][9] = [log[1][9], ...failures].filter(Boolean).join(" | ");
  try {
    // Keep earlier failures visible after the 07:30 recovery run.
    const previous = await readSheet(LEDGER_ID, "'自動_実行ログ'!A:J", {
      getSheetsToken: async () => t, fetchImpl: deps.fetchImpl,
    });
    await writeTab("自動_実行ログ", [log[0], ...previous.slice(1), ...log.slice(1)]);
  } catch (e) {
    failures.push(`自動_実行ログ 更新: ${e.message}`);
  }
  const back = {};
  for (const x of TABS)
    try {
      back[x] = (
        await readSheet(LEDGER_ID, `'${x}'!A:Z`, {
          getSheetsToken: async () => t,
          fetchImpl: deps.fetchImpl,
        })
      ).length;
    } catch (e) {
      back[x] = null;
      failures.push(`${x} 読み戻し: ${e.message}`);
    }
  const after = await readSheet(LEDGER_ID, "'シート1'!A:L", {
      getSheetsToken: async () => t,
      fetchImpl: deps.fetchImpl,
    }),
    sheet1Unchanged = JSON.stringify(before) === JSON.stringify(after);
  if (!sheet1Unchanged) throw Error("保護対象「シート1」が変更されました");
  return {
    readBack: back,
    failures,
    sheet1Unchanged,
    sheet1: {
      rowCountBefore: before.length,
      rowCountAfter: after.length,
      a1l5Before: beforeTop,
      a1l5After: after.slice(0, 5),
      properties: base,
    },
  };
}
export function skippedRunResult(now, marker) {
  return {
    executedAt: jstStamp(now),
    skipped: "already-delivered",
    marker,
    cases: [],
    mail: { messages: [], unanswered: [], departmentStoreJudgment: [], departmentStoreCustomers: [], aimitsu: [] },
    calendar: [],
    tldv: { items: [], note: "" },
    actions: [],
    errors: [],
    status: {},
    write: { mode: "skipped" },
    report: { text: `${fmt(now)} 分は送信済みのため、再実行をスキップしました`, lines: [], details: [], date: fmt(now) },
  };
}
export async function run({
  now = new Date(),
  dryRun = false,
  noDeliver = false,
  deps = {},
} = {}) {
  // 07:30 の再実行タスク用: 送信済みの印があれば、データ収集もLLM呼び出しもせず終わる。
  if (shouldDeliver({ dryRun, noDeliver })) {
    const mark = deliveredMarkerOf(now, deps.home);
    if (fs.existsSync(mark)) return skippedRunResult(now, mark);
  }
  const errors = [],
    status = {},
    source = async (n, f, z) => {
      try {
        const v = await retrySource(f, { sleepImpl: deps.sleepImpl,
          onRetry: (e, attempt, delay) => console.error(`satou-secretary: ${n} retry ${attempt}/4 in ${delay / 1000}s: ${e.message}`),
        });
        status[n] = "ok";
        return v;
      } catch (e) {
        errors.push(`${n}: ${e.message}`);
        status[n] = "error";
        return z;
      }
    };
  const evidence = await source(
      "Gmail60日",
      async () =>
        (
          await (deps.searchGmail || searchGmail)({
            user: USER,
            query:
              "newer_than:60d from:satou@orgiast.jp",
            max: 500,
            withBody: false,
            concurrency: 3,
          })
        ).messages || [],
      [],
    ),
    cases = await source(
      "案件一覧",
      async () =>
        extractCases(
          await readSheet(MASTER_ID, "'案件一覧'!A:CL", deps),
          now,
          evidence,
        ),
      [],
    ),
    gmail = await source("Gmail", () => (deps.readMail || mail)(deps), {
      messages: [],
      unanswered: [],
      departmentStoreJudgment: [],
      departmentStoreCustomers: [],
      aimitsu: [],
    }),
    cal = await source("Calendar", () => (deps.readCalendar || calendar)(now, deps), []),
    tv = await source("tl;dv", () => (deps.readTldv || tldv)(cases, now, deps), {
      items: [],
      note: "",
    });
  if (Object.values(status).every((x) => x === "error"))
    throw Error("全ソース失敗");
  const actions = [];
  for (const x of gmail.unanswered)
    actions.push([
      "未返信メール",
      new Date(+x.internalDate).toLocaleString("ja-JP", {
        timeZone: "Asia/Tokyo",
      }),
      x.subject,
      x.sender.name || x.sender.email,
      "未返信",
      x.url,
    ]);
  for (const x of gmail.departmentStoreCustomers)
    actions.push([
      "百貨店問い合わせ",
      new Date(+x.internalDate).toLocaleString("ja-JP", {
        timeZone: "Asia/Tokyo",
      }),
      x.subject,
      x.sender.name || x.sender.email,
      x.unanswered ? "未返信" : "対応済み",
      x.url,
    ]);
  const soon = new Date(now);
  soon.setHours(soon.getHours() + 48);
  for (const x of cal) {
    const d = new Date(x.start?.dateTime || `${x.start?.date}T00:00:00+09:00`);
    if (d <= soon)
      actions.push([
        "予定",
        d.toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" }),
        x.summary || "(無題)",
        x.location || "",
        "48時間以内",
        x.htmlLink || "",
      ]);
  }
  const week = new Date(now);
  week.setDate(week.getDate() + 7);
  for (const x of cases)
    if (x.delivery && x.delivery >= now && x.delivery <= week)
      actions.push([
        "納品期限",
        x.deliveryText,
        x.name,
        x.client,
        x.state,
        x.plan || x.estimate,
      ]);
  for (const x of gmail.aimitsu.filter((x) => x.unanswered))
    actions.push(["アイミツ", "", x.subject, x.company, "未回答", x.url]);
  const report = await buildDailyReport(
    { now, cases, messages: gmail.messages, actions, calendar: cal },
    deps,
  );
  errors.push(...report.llmErrors);
  // 1ソースでも最後まで失敗したら、取れた分で報告を作り、末尾に1行だけ断りを書く。
  if (Object.values(status).some((x) => x === "error"))
    report.text += "\n\n（メール取得失敗のため一部未反映）";
  const executedAt = jstStamp(now),
    tables = {
      自動_案件: [
        [
          "コード",
          "顧客",
          "案件名",
          "状態",
          "営業",
          "制作",
          "案件ルート",
          "拾った理由",
          "納品日",
          "売上",
          "計画URL",
          "見積URL",
          "マスター行番号",
        ],
        ...cases.map((x) => [
          x.code,
          x.client,
          x.name,
          x.state,
          x.sales,
          x.production,
          x.route,
          x.reason,
          x.deliveryText,
          x.revenue,
          x.plan,
          x.estimate,
          x.masterRow,
        ]),
      ],
      自動_今日の要対応: [
        ["種別", "期限/日時", "内容", "相手/案件", "状態", "直リンク"],
        ...actions,
      ],
      自動_実行ログ: [
        [
          "実行日時",
          "案件数",
          "メール数",
          "未返信数",
          "予定数",
          "アイミツ数",
          "百貨店要判断数",
          "百貨店顧客数",
          "tl;dv数",
          "エラー",
        ],
        [
          executedAt,
          cases.length,
          gmail.messages.length,
          gmail.unanswered.length,
          cal.length,
          gmail.aimitsu.length,
          gmail.departmentStoreJudgment.length,
          gmail.departmentStoreCustomers.length,
          tv.items.length,
          errors.join(" | ") || tv.note,
        ],
      ],
      "自動_百貨店受信（未対応か要判断）": [
        ["件名", "送信者", "日時", "リンク"],
        ...gmail.departmentStoreJudgment.map((x) => [
          x.subject,
          x.sender.name || x.sender.email,
          new Date(+x.internalDate).toLocaleString("ja-JP", {
            timeZone: "Asia/Tokyo",
          }),
          x.url,
        ]),
      ],
      自動_社長報告: [
        [report.text, "", "", ""],
        ["", "", "", ""],
        ["節名", "項目", "案件コード", "根拠リンク"],
        ...report.details,
      ],
    };
  const p = {
    executedAt,
    cases,
    mail: gmail,
    calendar: cal,
    tldv: tv,
    actions,
    errors,
    status,
    tables,
    report,
  };
  if (!dryRun) {
    // 台帳が書けない朝でも報告本文を手放さないよう、ローカルファイルを先に残す。
    const dir = path.join(deps.home || os.homedir(), ".claude", "satou-secretary");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `report-${report.date}.md`),
      report.text + "\n",
    );
    let draftInLedger = true;
    try {
      p.write = await write(p, deps);
      draftInLedger = !p.write.failures.some(x => x.startsWith("自動_社長報告"));
    } catch (e) {
      // 台帳書き込み失敗でも報告本文は完成しているため、配信は続ける。
      draftInLedger = false;
      p.write = { mode: "failed", error: e.message };
      errors.push(`台帳書き込み失敗: ${e.message}`);
    }
    if (shouldDeliver({ dryRun, noDeliver }))
      try {
        p.delivery = await deliverReport(report, { now, deps, sourceMessages: gmail.messages });
      } catch (e) {
        // DM が最終的に送れなかった場合: 台帳へ理由1行 + 佐藤さんへ短い案内DM（1日1通）。
        p.deliveryFailure = e.message;
        await notifyDeliveryFailure(e.message, { now, deps, draftInLedger });
        throw e;
      }
  } else {
    p.write = { mode: "dry-run" };
  }
  return p;
}
export async function appendRunLogRow(row, deps = {}) {
  const t = await (
    deps.getSheetsToken ||
    (() => token("https://www.googleapis.com/auth/spreadsheets"))
  )();
  const r = await api(
    `https://sheets.googleapis.com/v4/spreadsheets/${LEDGER_ID}/values/${encodeURIComponent("'自動_実行ログ'!A1")}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    { token: t, method: "POST", body: { values: [row] }, fetchImpl: deps.fetchImpl },
  );
  if (!r?.updates) throw Error("実行ログ追記の結果を読み戻せません");
  return r;
}
export const deliveryFailureNoticeText = (draftInLedger = true) =>
  draftInLedger
    ? `今朝の業務報告の下書きは自動で送れませんでした。台帳の『自動_社長報告』タブに本文があります：${LEDGER_URL}`
    : `今朝の業務報告を自動で送れませんでした。台帳への本文の保存にも失敗しています：${LEDGER_URL}`;
export async function notifyDeliveryFailure(reason, { now = new Date(), deps = {}, draftInLedger = true } = {}) {
  const home = deps.home || os.homedir(), oneLine = String(reason ?? "").replace(/\s+/g, " ").slice(0, 300);
  try {
    await appendRunLogRow([jstStamp(now), "", "", "", "", "", "", "", "", `DM送信失敗: ${oneLine}`], deps);
  } catch (e) {
    console.error(`satou-secretary: 実行ログへDM送信失敗理由を書けませんでした: ${e.message}`);
  }
  const notice = noticeMarkerOf(now, home);
  // Reserve the day's single attempt before posting, including ambiguous network failures.
  fs.mkdirSync(path.dirname(notice), { recursive: true });
  try { fs.writeFileSync(notice, JSON.stringify({ at: new Date().toISOString(), status: "attempting" }) + "\n", { flag: "wx" }); }
  catch (e) { if (e.code === "EEXIST") return { notified: false, reason: "notice-already-attempted" }; throw e; }
  try {
    const history = await (deps.fetchSendHistory || fetchSendHistory)("discord", REPORT_DM_TARGET, { home, fetchImpl: deps.discordFetchImpl }),
      text = deliveryFailureNoticeText(draftInLedger);
    writeContextMarker({ channel: "discord", target: history.target, text, latest: latestOf(history.messages), reason: `業務報告DM送信失敗の通知（固定文）: ${oneLine}`, home });
    const sent = await (deps.sendDiscordDm || sendDiscordDm)(REPORT_DM_TARGET, text, { home, noCopyKim: true, noReplyFooter: true, requireFullBody: true, fetchImpl: deps.discordFetchImpl });
    if (!sent.delivered || !sent.messageId) throw Error("Discord送信結果を確認できません");
    fs.mkdirSync(path.dirname(notice), { recursive: true });
    fs.writeFileSync(notice, `${JSON.stringify({ at: new Date().toISOString(), status: "sent", channelId: sent.channelId, messageId: sent.messageId, reason: oneLine })}\n`);
    return { notified: true, ...sent };
  } catch (e) {
    fs.writeFileSync(notice, JSON.stringify({ at: new Date().toISOString(), status: "failed-or-unconfirmed", error: e.message }) + "\n");
    console.error(`satou-secretary: 送信失敗の案内DMも送れませんでした: ${e.message}`);
    try {
      await appendRunLogRow([jstStamp(now), "", "", "", "", "", "", "", "", `案内DMも失敗: ${String(e.message).replace(/\s+/g, " ").slice(0, 200)}`], deps);
    } catch { /* 台帳も届かない状態。console.error の内容は run.log に残る */ }
    return { notified: false, error: e.message };
  }
}
export const REPORT_DM_TARGET = "佐藤優奈";
export const shouldDeliver = ({ dryRun = false, noDeliver = false } = {}) => !dryRun && !noDeliver;
const stateDirOf = (home) => path.join(home || os.homedir(), ".claude", "satou-secretary");
export const deliveredMarkerOf = (now, home) => path.join(stateDirOf(home), `delivered-${fmt(now)}`);
export const noticeMarkerOf = (now, home) => path.join(stateDirOf(home), `notice-${fmt(now)}`);
const jstStamp = (now) =>
  `${fmt(now)} ${new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit" }).format(now)} JST`;
export const reportDeliveryText = text => `おはようございます。毎日の業務状況報告です。\n\n${text}`;
export function mailSourceEvidence(messages = []) {
  return messages.map(m => {
    const at = m.at || m.date || m.internalDate || '';
    const sender = m.from || m.sender || '';
    const subject = m.subject || '';
    const body = String(m.text || m.body || m.snippet || '').replace(/\s+/g, ' ');
    return `[${at}] ${sender} ${subject}: ${body}`.trim();
  }).filter(Boolean).join('\n');
}
export async function deliverReport(report, { now = new Date(), deps = {}, sourceMessages = [] } = {}) {
  const home = deps.home || os.homedir(), stamp = fmt(now), dir = stateDirOf(home), mark = deliveredMarkerOf(now, home);
  if (fs.existsSync(mark)) return { delivered: false, reason: "already-delivered", marker: mark };
  fs.mkdirSync(dir, { recursive: true });
  const lock = path.join(dir, `delivery-${stamp}.lock`);
  try { fs.writeFileSync(lock, JSON.stringify({ at: new Date().toISOString(), pid: process.pid }), { flag: "wx" }); }
  catch (e) { if (e.code === "EEXIST") throw Error("本日の配信が実行中、または送信結果未確認です。重複送信を防ぐため停止します"); throw e; }
  let sending = false;
  try {
  const history = await (deps.fetchSendHistory || fetchSendHistory)("discord", REPORT_DM_TARGET, { home, fetchImpl: deps.discordFetchImpl });
  const text = reportDeliveryText(report.text);
  let verdict, lastCheckError;
  for (let attempt = 0; attempt < 3; attempt++) try {
    // 日次DMは宛先=佐藤さん本人への毎日の状況報告（定期報告）として照合する。
    verdict = await (deps.checkSendContext || checkSendContext)(history.messages, text, {
      periodicReport: { recipient: REPORT_DM_TARGET, kind: "毎日の状況報告", sourceEvidence: mailSourceEvidence(sourceMessages) },
    });
    break;
  } catch (error) { lastCheckError = error; }
  if (!verdict) throw lastCheckError;
  if (!verdict.ok) throw Error(`Discord送信前履歴照合NG: ${verdict.reason}`);
  writeContextMarker({ channel: "discord", target: history.target, text, latest: latestOf(history.messages), reason: verdict.reason, home });
  sending = Boolean(deps.sendDiscordDm); // injected senders may not expose the POST boundary
  const sent = await (deps.sendDiscordDm || sendDiscordDm)(REPORT_DM_TARGET, text, { home, noCopyKim: true, noReplyFooter: true, requireFullBody: true, fetchImpl: deps.discordFetchImpl, onMessageAttempt: () => { sending = true; } });
  if (!sent.delivered || !sent.messageId) throw Error("Discord送信結果を確認できません");
  fs.writeFileSync(mark, `${JSON.stringify({ at: new Date().toISOString(), channelId: sent.channelId, messageId: sent.messageId || "" })}\n`, { flag: "wx" });
  return { ...sent, marker: mark, text };
  } catch (error) {
    if (error.deliveryUncertain === false) sending = false;
    throw error;
  } finally { if (!sending || fs.existsSync(mark)) fs.unlinkSync(lock); }
}
export const summary = (r) =>
  `satou-secretary ${r.executedAt} cases=${r.cases.length} mail=${r.mail.messages.length} unanswered=${r.mail.unanswered.length} departmentStoreJudgment=${r.mail.departmentStoreJudgment.length} departmentStoreCustomers=${r.mail.departmentStoreCustomers.length} calendar=${r.calendar.length} aimitsu=${r.mail.aimitsu.length} tldv=${r.tldv.items.length} actions=${r.actions.length} write=${r.write.mode || "sheet"} errors=${r.errors.length}${r.tldv.note ? ` note="${r.tldv.note}"` : ""}\n\n${r.report.text}`;
if (isEntry(import.meta.url))
  run({ dryRun: process.argv.includes("--dry-run"), noDeliver: process.argv.includes("--no-deliver") })
    .then((r) =>
      console.log(
        process.argv.includes("--json")
          ? JSON.stringify(r, null, 2)
          : summary(r),
      ),
    )
    .catch((e) => {
      console.error(`satou-secretary failed: ${e.message}`);
      process.exitCode = 1;
    });
