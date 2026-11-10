#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { isEntry } from "./is-entry.mjs";
import { getDriveToken } from "./lib/drive-auth.mjs";
import { gwsFetch } from "./lib/gws-proxy.mjs";
import { searchGmail, compactMessage } from "./gmail-search.mjs";
import { readEnvValue } from "./env-kv.mjs";
export const LEDGER_ID = "17h_x-1kdxI_92H_dXBydclLsxUmYKa-ut0P3begM_j0",
  MASTER_ID = "14RC6og1ma_I3LGHwCVwswKArgHwCOPxWlPB3g8adaYY";
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
      hay = `${txt(r[i.client])} ${txt(r[i.name])}`,
      emailOwner = emailEvidence.some((x) => {
        const blob = norm(
          `${x.subject || ""} ${x.snippet || ""} ${x.from || ""} ${x.to || ""}`,
        );
        return (
          [txt(r[i.client]), txt(r[i.name])]
            .filter((x) => norm(x).length >= 3)
            .some((x) => blob.includes(norm(x))) &&
          /satou@orgiast\.jp/i.test(
            `${x.from || ""} ${x.to || ""} ${x.cc || ""}`,
          )
        );
      }),
      d = sheetDate(r[i.delivery]);
    if (
      (!sales &&
        !production &&
        !departmentStore &&
        !(secondary && ACTIVE.has(state)) &&
        !emailOwner) ||
      (CLOSED.has(state) && d && d < cut)
    )
      return [];
    const reason = [
      sales && "営業",
      production && "制作",
      departmentStore && "百貨店ルート",
      secondary && "担当者列",
      emailOwner && "メール担当",
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
      'newer_than:2d ((to:satou@orgiast.jp OR cc:satou@orgiast.jp OR "佐藤 優奈" OR "佐藤優奈" OR from:imitsu.jp) OR ("社内イベント百貨店" OR to:info@event-shop.jp OR from:event-shop.jp)) -from:saiyo@orgiast.jp -to:saiyo@orgiast.jp',
    r = await (deps.searchGmail || searchGmail)({
      user: USER,
      query: q,
      max: 100,
      withBody: true,
      bodyLimit: 8000,
      concurrency: 3,
    }),
    t = await token("https://www.googleapis.com/auth/gmail.readonly"),
    messages = [
      ...new Map(r.messages.map((x) => [x.threadId, x])).values(),
    ].map((x) => ({ ...x, url: gmailUrl(x.threadId) })),
    unanswered = [],
    departmentStoreJudgment = [],
    departmentStoreCustomers = [];
  for (const x of messages) {
    const d = await api(
        `https://gmail.googleapis.com/gmail/v1/users/me/threads/${x.threadId}?format=metadata&metadataHeaders=Date&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject`,
        { token: t, fetchImpl: deps.fetchImpl },
      ),
      classification = classifyDepartmentStoreThread(d.messages || []),
      c = classification.last || x,
      w = classification.lastSender.email
        ? classification.lastSender
        : sender(c.from),
      item = { ...c, sender: w, url: gmailUrl(c.threadId || x.threadId) };
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
        timeMin: now.toISOString(),
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
    if (CLOSED.has(x.state)) continue;
    const k = baseCode(x.code) || `${x.client}|${x.name}`;
    if (!by.has(k)) by.set(k, x);
    else if (x.state === "確定") by.set(k, x);
  }
  const values = [...by.values()];
  return {
    total: values.length,
    confirmed: values.filter((x) => x.state === "確定").length,
    adjusting: values.filter((x) => x.state !== "確定").length,
    values,
  };
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
    fail = [];
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
          prompt,
        ],
        { timeout: 90000, maxBuffer: 1024 * 1024 },
      );
      const out = txt(stdout);
      if (out && out !== "(出力なし)") return out;
    } catch (e) {
      fail.push(`${provider}: ${e.message}`);
    }
  throw Error(`LLM全滅: ${fail.join(" | ")}`);
}
function caseForMessage(message, cases) {
  const blob = norm(
    `${message.subject || ""} ${message.snippet || ""} ${message.from || ""} ${message.to || ""}`,
  );
  return cases.find((x) =>
    [x.code, ...(/オージャスト/.test(x.client) ? [] : [x.name, x.client])]
      .filter(Boolean)
      .some((v) => norm(v).length >= 3 && blob.includes(norm(v))),
  );
}
function fallbackMovement(messages) {
  return clip(
    messages
      .map(
        (x) =>
          `${x.subject || "(件名なし)"}（${sender(x.from || "").name || sender(x.from || "").email || "送信者不明"}）`,
      )
      .join("／"),
  );
}
export function capReportLines(lines, max = 25) {
  if (lines.length <= max) return lines;
  return [...lines.slice(0, max - 1), "・ほか（台帳の明細参照）"];
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
    yesterday = messages.filter((x) => isInPreviousJstDay(x.internalDate, now)),
    groups = new Map();
  for (const m of yesterday) {
    if (
      !/satou@orgiast\.jp/i.test(
        `${m.from || ""} ${m.to || ""} ${m.cc || ""}`,
      ) &&
      !caseForMessage(m, cases)
    )
      continue;
    const c = caseForMessage(m, cases),
      key = baseCode(c?.code) || c?.client || m.threadId || m.id;
    if (!groups.has(key)) groups.set(key, { caseItem: c, messages: [] });
    groups.get(key).messages.push(m);
  }
  const movements = [],
    details = [],
    llmErrors = [];
  for (const g of groups.values()) {
    const input = g.messages.map((x) => ({
      subject: x.subject || "",
      sender: x.from || "",
      snippet: x.snippet || "",
      direction: /@orgiast\.jp/i.test(sender(x.from || "").email)
        ? "自社送信"
        : "先方送信",
    }));
    let summary;
    try {
      summary = clip(
        await askReportLlm(
          `次のメール群を日本語40字前後、事実のみ1行で要約。JSONや前置き不要。\n${JSON.stringify(input)}`,
          deps,
        ),
      );
    } catch (e) {
      summary = fallbackMovement(g.messages);
      llmErrors.push(e.message);
    }
    const label =
        g.caseItem?.client ||
        g.caseItem?.name ||
        clip(g.messages[0]?.subject, 18),
      date = g.caseItem?.deliveryText || "日程未定",
      url = g.messages[0]?.url || gmailUrl(g.messages[0]?.threadId);
    movements.push(`・${label}（${date}）：${summary}`);
    details.push(["昨日の動き", summary, g.caseItem?.code || "", url]);
  }
  const problems = [];
  for (const x of actions) {
    if (x[0] === "未返信メール") {
      const d = new Date(x[1]);
      if (now - d >= 864e5)
        problems.push({
          text: `${x[3]}への返信が24時間超過`,
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
        deadline: x.deliveryText,
        code: x.code,
        url: x.estimate,
      });
  if (yesterday.length)
    try {
      const raw = await askReportLlm(
        `基準日は${fmt(now)}。次のメールから問題候補を抽出。対象は(1)自社送信本文に明記された約束期日が基準日から3日以内 (2)キャンセル・辞退等と案件状態の明白な食い違い。期日が明記されていないもの、単なる出席者変更、推測は除外。未来の期日を「過ぎた」と書かない。各行を「問題候補: 事実|期限または要確認|案件コード」の形式。なければ「なし」。\n${JSON.stringify(yesterday.map((x) => ({ subject: x.subject, from: x.from, snippet: x.snippet })))}`,
        deps,
      );
      if (txt(raw) !== "なし")
        for (const line of raw.split(/\r?\n/).filter((x) => x.includes("|"))) {
          const fields = line.replace(/^[-・*\d.\s]+/, "").split("|");
          const [text, deadline = "要確認", code = ""] = fields;
          const deadlineDate = /^20\d{2}-\d{2}-\d{2}$/.test(deadline)
            ? new Date(`${deadline}T23:59:59+09:00`)
            : null;
          if (
            fields.length === 3 &&
            /^問題候補[:：]/.test(text) &&
            (!deadlineDate ||
              deadlineDate <= new Date(now.getTime() + 3 * 864e5))
          )
            problems.push({
              text: clip(`${text}（候補）`),
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
        `次のメールから社長判断が必要な具体的依頼だけを抽出。値引き、金額変更、キャンセル料、契約条件、外注先、方針変更、権限付与が対象。カテゴリ名だけは出力しない。該当なしは「なし」の1語。該当ありは各行を必ず「判断候補: 具体的事項」の形式にし、前置き不要。\n${JSON.stringify(yesterday.map((x) => ({ subject: x.subject, from: x.from, snippet: x.snippet })))}`,
        deps,
      );
      if (txt(raw) !== "なし")
        for (const line of raw
          .split(/\r?\n/)
          .map((x) => x.replace(/^[-・*\d.\s]+/, ""))
          .filter(
            (x) =>
              /^判断候補[:：]/.test(x) &&
              /値引|金額|キャンセル料|契約条件|外注|方針|権限/.test(x),
          ))
          judgment.push(clip(line));
    } catch (e) {
      llmErrors.push(e.message);
    }
  const sorted = [...actions]
      .sort(
        (a, b) =>
          (a[0] === "予定" ? -3 : 0) - (b[0] === "予定" ? -3 : 0) ||
          String(a[1]).localeCompare(String(b[1])),
      )
      .slice(0, 3),
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
        ? uniqueProblems.map((x) => `・${clip(x.text)}（${x.deadline}）`)
        : ["・なし"]),
      "■社長判断が必要なこと",
      ...(judgment.length ? judgment.map((x) => `・${x}`) : ["・なし"]),
      "■今日の優先",
      ...(sorted.length
        ? sorted.map((x, i) => `${i + 1}. ${clip(`${x[3] || x[2]}：${x[2]}`)}`)
        : [
            "1. 台帳と受信状況の確認",
            "2. 未返信案件の確認",
            "3. 直近予定の準備",
          ]),
    ],
    capped = capReportLines(lines);
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
    text: capped.join("\n"),
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
    await writeTab("自動_実行ログ", log);
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
export async function run({
  now = new Date(),
  dryRun = false,
  deps = {},
} = {}) {
  const errors = [],
    status = {},
    source = async (n, f, z) => {
      try {
        const v = await f();
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
              "newer_than:60d (from:satou@orgiast.jp OR to:satou@orgiast.jp OR cc:satou@orgiast.jp)",
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
    gmail = await source("Gmail", () => mail(deps), {
      messages: [],
      unanswered: [],
      departmentStoreJudgment: [],
      departmentStoreCustomers: [],
      aimitsu: [],
    }),
    cal = await source("Calendar", () => calendar(now, deps), []),
    tv = await source("tl;dv", () => tldv(cases, now, deps), {
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
  const executedAt = `${fmt(now)} ${new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit" }).format(now)} JST`,
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
  p.write = dryRun ? { mode: "dry-run" } : await write(p, deps);
  if (!dryRun) {
    const dir = path.join(os.homedir(), ".claude", "satou-secretary");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `report-${report.date}.md`),
      report.text + "\n",
    );
  }
  return p;
}
export const summary = (r) =>
  `satou-secretary ${r.executedAt} cases=${r.cases.length} mail=${r.mail.messages.length} unanswered=${r.mail.unanswered.length} departmentStoreJudgment=${r.mail.departmentStoreJudgment.length} departmentStoreCustomers=${r.mail.departmentStoreCustomers.length} calendar=${r.calendar.length} aimitsu=${r.mail.aimitsu.length} tldv=${r.tldv.items.length} actions=${r.actions.length} write=${r.write.mode || "sheet"} errors=${r.errors.length}${r.tldv.note ? ` note="${r.tldv.note}"` : ""}\n\n${r.report.text}`;
if (isEntry(import.meta.url))
  run({ dryRun: process.argv.includes("--dry-run") })
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
