#!/usr/bin/env node
/**
 * 営業自動化アプリ (Supabase) の読み取り専用クライアント。
 * GET (select) のみ。insert / update / delete / rpc は送らない。
 *
 * 状態対応表（実データ dry-run 20261126 のマスター値＋想定値）:
 * - マスター完了系: 納品完了 / 完了 / 確定 / 請求済 / 入金済
 *   ↔ 営業アプリ「受注」は一致扱い（食い違いにしない）
 * - マスター失注: 失注
 *   ↔ 営業アプリ 進行中/追いかけ/長期フォロー、または直近14日やり取りあり → 食い違い
 * - マスター進行中系（確定前）: アプローチリスト / 提案中 / 見積 / 見積中 / 調整中
 *   ↔ 営業アプリ 失注 → 食い違い
 * - 未知のマスター状態は判定しない（食い違いにしない）
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseEnvText } from "../env-kv.mjs";

export const DEFAULT_SALES_APP_ENV_FILE = path.join(
  os.homedir(),
  "work",
  "aujust-sales-automation",
  ".env.local",
);

export const LINE_SEND_ENV_FILE = path.join(
  os.homedir(),
  ".claude",
  "line-send.env",
);

/** line-group-link で誤一致した汎用語。会社名完全一致でも使わない。 */
export const GENERIC_COMPANY_TOKENS = new Set(
  [
    "制作",
    "ディレクター",
    "ディレクター様",
    "デザイナー",
    "デザイナー様",
    "営業",
    "オージャスト",
    "aujust",
    "orgiast",
    "株式会社オージャスト",
  ].map((x) => normalizeCompanyName(x)),
);

/** マスター完了系 — 営業アプリ「受注」と一致扱い */
export const MASTER_DONE = new Set([
  "納品完了",
  "完了",
  "確定",
  "請求済",
  "入金済",
]);

/** マスター失注 */
export const MASTER_LOST = new Set(["失注"]);

/**
 * マスター進行中系（確定前）。営業アプリ失注との食い違い対象。
 * 実データ: アプローチリスト。想定: 提案中 / 見積 / 見積中 / 調整中。
 */
export const MASTER_PIPELINE = new Set([
  "アプローチリスト",
  "提案中",
  "見積",
  "見積中",
  "調整中",
]);

/** @deprecated 互換用。失注＋完了系。状態逆転判定には使わない。 */
export const MASTER_CLOSED = new Set([...MASTER_LOST, "納品完了"]);

/** 営業アプリ: 追いかけ対象（未掲載・次回連絡超過） */
export const SALES_PIPELINE_STATUS = new Set(["進行中", "追いかけ"]);

/** 営業アプリ: 状態逆転（マスター失注）に含める長期フォロー */
export const SALES_FOLLOW_STATUS = new Set(["長期フォロー"]);

export const SALES_WON_STATUS = new Set(["受注"]);
export const SALES_LOST_STATUS = new Set(["失注"]);
export const SALES_LOST_PROGRESS = new Set(["失注"]);

/** @deprecated 互換。受注は進行中系に含めない。 */
export const SALES_ACTIVE_STATUS = new Set([
  "進行中",
  "追いかけ",
  "長期フォロー",
  "受注",
]);

const JST_DAY = (d) =>
  new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(d);

export function jstDayOffset(now = new Date(), deltaDays = 0) {
  const base = new Date(`${JST_DAY(now)}T12:00:00+09:00`);
  base.setDate(base.getDate() + deltaDays);
  return JST_DAY(base);
}

export function normalizeCompanyName(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[\s　]+/g, "")
    .replace(/\(株\)|（株）|㈱|株式会社|合同会社|有限会社|一般社団法人|医療法人/g, "")
    .toLowerCase();
}

export function isGenericCompanyName(value) {
  const key = normalizeCompanyName(value);
  if (!key || key.length < 2) return true;
  return GENERIC_COMPANY_TOKENS.has(key);
}

export function isTestCompanyName(value) {
  return /テスト/.test(String(value ?? ""));
}

/** 正規化後に空＝法人格だけ／空欄 */
export function isEmptyOrLegalOnlyCompanyName(value) {
  return !normalizeCompanyName(value);
}

export function baseDealCode(value) {
  return String(value ?? "")
    .trim()
    .normalize("NFKC")
    .replace(/_\d+$/, "");
}

export function masterStateOf(state) {
  return String(state ?? "").trim();
}

export function isMasterDone(state) {
  return MASTER_DONE.has(masterStateOf(state));
}

export function isMasterLost(state) {
  return MASTER_LOST.has(masterStateOf(state));
}

export function isMasterPipeline(state) {
  return MASTER_PIPELINE.has(masterStateOf(state));
}

export function isMasterClosed(state) {
  return isMasterLost(state) || isMasterDone(state);
}

export function salesStatusOf(deal = {}) {
  return String(deal.status ?? "").trim();
}

export function isSalesLost(deal = {}) {
  const status = salesStatusOf(deal);
  const progress = String(deal.progress ?? "").trim();
  return SALES_LOST_STATUS.has(status) || SALES_LOST_PROGRESS.has(progress);
}

export function isSalesWon(deal = {}) {
  return SALES_WON_STATUS.has(salesStatusOf(deal));
}

/** 進行中 / 追いかけ */
export function isSalesPipelineOpen(deal = {}) {
  return SALES_PIPELINE_STATUS.has(salesStatusOf(deal));
}

/** 進行中 / 追いかけ / 長期フォロー（マスター失注との逆転用） */
export function isSalesFollowOrPipeline(deal = {}) {
  const status = salesStatusOf(deal);
  return SALES_PIPELINE_STATUS.has(status) || SALES_FOLLOW_STATUS.has(status);
}

/** @deprecated 受注を含む旧「進行中系」。新規判定では使わない。 */
export function isSalesActive(deal = {}) {
  if (isSalesLost(deal)) return false;
  const status = salesStatusOf(deal);
  return SALES_ACTIVE_STATUS.has(status) || status === "";
}

export function salesAppStatusLabel(deal) {
  if (!deal) return "";
  const status = String(deal.status ?? "").trim();
  const progress = String(deal.progress ?? "").trim();
  if (status && progress && status !== progress) return `${status}・${progress}`;
  return status || progress || "";
}

/**
 * マスター未掲載の候補（進行中/追いかけ・テスト除外・直近30日 or next_contact 有効）。
 */
export function isActiveUnmatchedDeal(
  deal,
  activity = {},
  companyName = "",
  now = new Date(),
) {
  if (!deal || !isSalesPipelineOpen(deal)) return false;
  if (isTestCompanyName(companyName)) return false;
  if (isEmptyOrLegalOnlyCompanyName(companyName)) return false;
  if (Number(activity?.count30d || 0) > 0) return true;
  const ncd = String(deal.next_contact_date || "").trim();
  if (!ncd) return false;
  return ncd >= jstDayOffset(now, -30);
}

function readEnvFileValues(envFile) {
  try {
    return parseEnvText(fs.readFileSync(envFile, "utf8"));
  } catch {
    return null;
  }
}

function extractSupabaseCreds(values = {}, env = {}) {
  const url =
    values.NEXT_PUBLIC_SUPABASE_URL ||
    values.SUPABASE_URL ||
    env.NEXT_PUBLIC_SUPABASE_URL ||
    env.SUPABASE_URL ||
    "";
  const key =
    values.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_ROLE_KEY || "";
  return { url, key };
}

export function hasSupabaseCreds(values = {}, env = {}) {
  const { url, key } = extractSupabaseCreds(values, env);
  return Boolean(url && key);
}

/**
 * 探索順: SALES_APP_ENV_FILE → .env.local（URL+鍵があるときだけ）→ line-send.env
 */
export function resolveSalesAppEnvCandidates(
  env = process.env,
  { candidates } = {},
) {
  if (env.SALES_APP_ENV_FILE) return [env.SALES_APP_ENV_FILE];
  if (candidates?.length) return [...candidates];
  return [DEFAULT_SALES_APP_ENV_FILE, LINE_SEND_ENV_FILE];
}

export function resolveSalesAppEnvFile(env = process.env, opts = {}) {
  if (env.SALES_APP_ENV_FILE) return env.SALES_APP_ENV_FILE;
  try {
    return loadSalesAppConfig({ env, ...opts }).envFile;
  } catch {
    return DEFAULT_SALES_APP_ENV_FILE;
  }
}

export function loadSalesAppConfig({
  envFile,
  env = process.env,
  candidates,
} = {}) {
  const explicit = Boolean(envFile || env.SALES_APP_ENV_FILE);
  const list = envFile
    ? [envFile]
    : resolveSalesAppEnvCandidates(env, { candidates });
  const tried = [];
  for (const file of list) {
    tried.push(file);
    const values = readEnvFileValues(file);
    if (values == null) {
      if (explicit) {
        throw new Error(
          `営業アプリ接続ファイルを読めません: ${file} (ENOENT)`,
        );
      }
      continue;
    }
    // 明示指定時は process.env の補完を許す。探索時はファイル内の鍵だけを見る。
    const { url, key } = extractSupabaseCreds(
      values,
      explicit ? env : {},
    );
    if (!url || !key) {
      if (explicit) {
        throw new Error(
          `営業アプリ接続情報が不足です (${file}: NEXT_PUBLIC_SUPABASE_URL/SUPABASE_URL と SUPABASE_SERVICE_ROLE_KEY)`,
        );
      }
      // .env.local に OIDC しか無い場合は次候補へ
      continue;
    }
    return { url: url.replace(/\/$/, ""), key, envFile: file };
  }
  throw new Error(
    `営業アプリ接続情報が不足です (${tried.join(" → ")}: NEXT_PUBLIC_SUPABASE_URL/SUPABASE_URL と SUPABASE_SERVICE_ROLE_KEY)`,
  );
}

/** GET 以外を拒否する fetch ラッパ。テストで差し替え可能。 */
export function createReadOnlyFetch(fetchImpl = globalThis.fetch) {
  return async (input, init = {}) => {
    const method = String(init.method || "GET").toUpperCase();
    if (method !== "GET") {
      throw new Error(`営業アプリへ GET 以外は禁止です: ${method}`);
    }
    return fetchImpl(input, { ...init, method: "GET" });
  };
}

export async function supabaseSelect(
  config,
  table,
  {
    select = "*",
    filters = [],
    order,
    limit,
    fetchImpl = globalThis.fetch,
  } = {},
) {
  const readFetch = createReadOnlyFetch(fetchImpl);
  const params = new URLSearchParams();
  params.set("select", select);
  for (const f of filters) params.append(f[0], f[1]);
  if (order) params.set("order", order);
  if (limit != null) params.set("limit", String(limit));
  const url = `${config.url}/rest/v1/${table}?${params}`;
  const res = await readFetch(url, {
    headers: {
      apikey: config.key,
      Authorization: `Bearer ${config.key}`,
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Supabase ${table} ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function selectByIds(config, table, column, ids, opts = {}) {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return [];
  const rows = [];
  for (const part of chunk(unique, 80)) {
    rows.push(
      ...(await supabaseSelect(config, table, {
        ...opts,
        filters: [
          ...(opts.filters || []),
          [column, `in.(${part.join(",")})`],
        ],
      })),
    );
  }
  return rows;
}

const DEAL_SELECT =
  "id,deal_code,deal_title,status,progress,sales_owner,next_contact_date,customer_id,sheet_row_id,archived_at";

export async function fetchSatoRelatedDeals(
  config,
  { ledgerCases = [], fetchImpl = globalThis.fetch } = {},
) {
  const byOwner = await supabaseSelect(config, "deals", {
    select: DEAL_SELECT,
    filters: [["sales_owner", "ilike.*佐藤*"]],
    limit: 2000,
    fetchImpl,
  });
  const codes = [
    ...new Set(
      ledgerCases
        .map((c) => baseDealCode(c.code))
        .filter((c) => c.length >= 5),
    ),
  ];
  const byCode = [];
  for (const part of chunk(codes, 50)) {
    byCode.push(
      ...(await supabaseSelect(config, "deals", {
        select: DEAL_SELECT,
        filters: [["deal_code", `in.(${part.join(",")})`]],
        limit: 2000,
        fetchImpl,
      })),
    );
  }

  // 台帳の会社名から顧客→deal を拾う（deal_code / sales_owner が空のニッケ型）。
  const clientNames = [
    ...new Set(
      ledgerCases
        .map((c) => String(c.client || "").trim())
        .filter((name) => name && !isGenericCompanyName(name)),
    ),
  ];
  const customerIds = new Set();
  for (const name of clientNames) {
    const core = normalizeCompanyName(name).slice(0, 20);
    if (core.length < 2) continue;
    const found = await supabaseSelect(config, "customers", {
      select: "id,company_name",
      filters: [["company_name", `ilike.*${core}*`]],
      limit: 50,
      fetchImpl,
    });
    for (const c of found) {
      if (normalizeCompanyName(c.company_name) === normalizeCompanyName(name)) {
        customerIds.add(c.id);
      }
    }
  }
  const byCustomer = await selectByIds(
    config,
    "deals",
    "customer_id",
    [...customerIds],
    { select: DEAL_SELECT, limit: 2000, fetchImpl },
  );

  const map = new Map();
  for (const d of [...byOwner, ...byCode, ...byCustomer]) map.set(d.id, d);
  return [...map.values()];
}

export async function fetchDealActivitySummary(
  config,
  { deals = [], sinceIso, now = new Date(), fetchImpl = globalThis.fetch } = {},
) {
  const dealIds = deals.map((d) => d.id).filter(Boolean);
  const customerIds = [
    ...new Set(deals.map((d) => d.customer_id).filter(Boolean)),
  ];
  const msgFilters = [];
  if (sinceIso) msgFilters.push(["received_at", `gte.${sinceIso}`]);
  const actFilters = [];
  if (sinceIso) actFilters.push(["activity_date", `gte.${sinceIso}`]);
  const cutoff14Iso = new Date(now.getTime() - 14 * 86400000).toISOString();

  const [byDealMsgs, byCustomerMsgs, activities, customers, links] =
    await Promise.all([
      selectByIds(config, "channel_messages", "deal_id", dealIds, {
        select: "id,deal_id,customer_id,received_at",
        filters: msgFilters,
        order: "received_at.desc",
        limit: 5000,
        fetchImpl,
      }),
      selectByIds(config, "channel_messages", "customer_id", customerIds, {
        select: "id,deal_id,customer_id,received_at",
        filters: msgFilters,
        order: "received_at.desc",
        limit: 5000,
        fetchImpl,
      }),
      selectByIds(config, "deal_activities", "deal_id", dealIds, {
        select: "id,deal_id,activity_date",
        filters: actFilters,
        order: "activity_date.desc",
        limit: 5000,
        fetchImpl,
      }),
      selectByIds(config, "customers", "id", customerIds, {
        select: "id,company_name",
        fetchImpl,
      }),
      selectByIds(config, "master_row_links", "deal_id", dealIds, {
        select: "deal_id,last_row_number,sheet_key,missing_since",
        fetchImpl,
      }),
    ]);

  const allMsgs = [];
  const seenMsg = new Set();
  for (const m of [...byDealMsgs, ...byCustomerMsgs]) {
    if (seenMsg.has(m.id)) continue;
    seenMsg.add(m.id);
    allMsgs.push(m);
  }

  const customerById = new Map(customers.map((c) => [c.id, c]));
  const linksByDeal = new Map();
  for (const link of links) {
    if (!linksByDeal.has(link.deal_id)) linksByDeal.set(link.deal_id, []);
    linksByDeal.get(link.deal_id).push(link);
  }

  const activityByDeal = new Map();
  const bump = (dealId, customerId, at) => {
    if (!dealId && !customerId) return;
    const keys = [];
    if (dealId) keys.push(dealId);
    if (!dealId && customerId) {
      for (const d of deals) if (d.customer_id === customerId) keys.push(d.id);
    }
    for (const id of keys) {
      const cur = activityByDeal.get(id) || {
        count14d: 0,
        count30d: 0,
        latestAt: null,
      };
      cur.count30d += 1;
      if (at >= cutoff14Iso) cur.count14d += 1;
      if (!cur.latestAt || at > cur.latestAt) cur.latestAt = at;
      activityByDeal.set(id, cur);
    }
  };

  for (const m of allMsgs) {
    const at = m.received_at || null;
    if (!at) continue;
    bump(m.deal_id, m.customer_id, at);
  }
  for (const a of activities) {
    const at = a.activity_date || null;
    if (!at) continue;
    bump(a.deal_id, null, at);
  }

  return { customerById, linksByDeal, activityByDeal, messages: allMsgs, activities };
}

/**
 * 照合優先順:
 * 1. deal_code = 案件コード（0033 の確定リンク）
 * 2. master_row_links.last_row_number = マスター行
 * 3. 正規化会社名の完全一致（汎用語は除外）
 */
export function matchCaseToDeal(caseItem, deals, { customerById, linksByDeal } = {}) {
  const code = baseDealCode(caseItem?.code);
  if (code) {
    const hit = deals.find((d) => baseDealCode(d.deal_code) === code);
    if (hit) return { deal: hit, method: "deal_code" };
  }
  const row = Number(caseItem?.masterRow);
  if (Number.isFinite(row) && row > 0 && linksByDeal) {
    for (const d of deals) {
      const links = linksByDeal.get(d.id) || [];
      if (links.some((l) => Number(l.last_row_number) === row && !l.missing_since)) {
        return { deal: d, method: "master_row_links" };
      }
    }
  }
  const companyKey = normalizeCompanyName(caseItem?.client);
  if (companyKey && !isGenericCompanyName(caseItem?.client)) {
    const hits = deals.filter((d) => {
      const name = customerById?.get(d.customer_id)?.company_name || "";
      return normalizeCompanyName(name) === companyKey;
    });
    if (hits.length === 1) return { deal: hits[0], method: "company_name" };
  }
  return { deal: null, method: "一致なし" };
}

export function detectDiscrepancies(
  {
    caseItem = null,
    deal = null,
    matchMethod = "一致なし",
    activity = { count14d: 0, count30d: 0, latestAt: null },
    companyName = "",
  },
  now = new Date(),
) {
  const reasons = [];
  const today = JST_DAY(now);
  const company =
    companyName ||
    caseItem?.client ||
    "";
  const recent14 = Number(activity?.count14d || 0) > 0;
  const masterLost = caseItem ? isMasterLost(caseItem.state) : false;
  const masterPipeline = caseItem ? isMasterPipeline(caseItem.state) : false;
  const salesFollowOrPipeline = deal ? isSalesFollowOrPipeline(deal) : false;
  const salesLost = deal ? isSalesLost(deal) : false;

  // 1) 状態逆転: マスター失注 × (進行中系 or 直近14日)
  if (caseItem && masterLost && deal && (salesFollowOrPipeline || recent14)) {
    reasons.push(
      recent14 && !salesFollowOrPipeline
        ? "マスターは失注だが直近14日に営業アプリでやり取りあり"
        : "マスターは失注だが営業アプリは進行中系",
    );
  }
  // 2) 状態逆転: マスター進行中系（確定前）× 営業アプリ失注
  // 完了系・未知の状態は判定しない
  if (caseItem && masterPipeline && deal && salesLost) {
    reasons.push("マスターは進行中だが営業アプリは失注");
  }

  // 3) 次回連絡日超過: 進行中/追いかけのみ。
  // 未照合 deal は「マスター未掲載」候補と同じ鮮度があるときだけ（古い失注・受注・放置を除外）。
  if (
    deal &&
    deal.next_contact_date &&
    deal.next_contact_date < today &&
    isSalesPipelineOpen(deal) &&
    (caseItem || isActiveUnmatchedDeal(deal, activity, company, now))
  ) {
    reasons.push(`次回連絡日 ${deal.next_contact_date} 超過（未対応）`);
  }

  // 4) 営業アプリ未登録 — タブ用。日報では discrepancyReportLines が除外する。
  if (caseItem && !deal) {
    reasons.push("営業アプリ未登録");
  }

  // 5) マスター未掲載 — 進行中/追いかけかつ鮮度あり。テスト・法人格のみ除外。
  if (!caseItem && deal && isActiveUnmatchedDeal(deal, activity, company, now)) {
    reasons.push("マスター未掲載（佐藤担当deal）");
  }
  return reasons;
}

export function buildReconcileRow({
  caseItem = null,
  deal = null,
  matchMethod = "一致なし",
  activity = { count14d: 0, count30d: 0, latestAt: null },
  discrepancies = [],
  customerById,
} = {}) {
  const company =
    caseItem?.client ||
    customerById?.get(deal?.customer_id)?.company_name ||
    "";
  return {
    code: caseItem?.code || deal?.deal_code || "",
    company,
    name: caseItem?.name || deal?.deal_title || "",
    masterState: caseItem?.state || "",
    salesState: salesAppStatusLabel(deal),
    nextContactDate: deal?.next_contact_date || "",
    latestActivityAt: activity?.latestAt || "",
    count14d: Number(activity?.count14d || 0),
    discrepancy: discrepancies.join(" / "),
    matchMethod,
    dealId: deal?.id || "",
    customerId: deal?.customer_id || caseItem?.customerId || "",
  };
}

export function reconcileRowsToSheet(rows = []) {
  return [
    [
      "案件ID",
      "会社名",
      "案件名",
      "マスター状態",
      "営業アプリ状態(status・progress)",
      "次回連絡日",
      "最終やり取り日時",
      "直近14日件数",
      "食い違い",
      "照合方法",
    ],
    ...rows.map((r) => [
      r.code,
      r.company,
      r.name,
      r.masterState,
      r.salesState,
      r.nextContactDate,
      r.latestActivityAt,
      r.count14d,
      r.discrepancy,
      r.matchMethod,
    ]),
  ];
}

export function discrepancySeverity(row = {}) {
  const d = String(row.discrepancy || "");
  // 日報順: 状態逆転 → 次回連絡日超過 → マスター未掲載
  if (/マスターは失注/.test(d) || /マスターは進行中だが営業アプリは失注/.test(d))
    return 1;
  if (/次回連絡日/.test(d)) return 2;
  if (/マスター未掲載/.test(d)) return 3;
  if (/営業アプリ未登録/.test(d)) return 4;
  return 9;
}

function reportableDiscrepancy(row = {}) {
  const parts = String(row.discrepancy || "")
    .split(" / ")
    .map((x) => x.trim())
    .filter(Boolean)
    .filter((p) => p !== "営業アプリ未登録");
  return parts.length ? parts.join(" / ") : "";
}

export function discrepancyReportLines(rows = [], limit = 5) {
  const bad = rows
    .map((r) => ({ ...r, discrepancy: reportableDiscrepancy(r) }))
    .filter((r) => r.discrepancy)
    .slice()
    .sort(
      (a, b) =>
        discrepancySeverity(a) - discrepancySeverity(b) ||
        String(a.company).localeCompare(String(b.company), "ja"),
    );
  if (!bad.length) return [];
  return bad.slice(0, limit).map((r) => {
    const label = r.company || r.code || r.name || "(不明)";
    return `・${label}：${r.discrepancy}`;
  });
}

export function overdueContactActions(rows = [], now = new Date()) {
  const today = JST_DAY(now);
  return rows
    .filter(
      (r) =>
        r.nextContactDate &&
        r.nextContactDate < today &&
        /次回連絡日/.test(r.discrepancy || ""),
    )
    .map((r) => [
      "営業アプリ次回連絡超過",
      r.nextContactDate,
      r.name || r.company,
      r.company || r.code,
      r.salesState || "未対応",
      "",
    ]);
}

/**
 * 台帳案件と営業アプリ deals を照合する。失敗時は throw（呼び出し側で握る）。
 */
export async function reconcileSalesAppWithLedger(
  ledgerCases = [],
  {
    now = new Date(),
    config,
    envFile,
    env,
    candidates,
    fetchImpl = globalThis.fetch,
  } = {},
) {
  const cfg =
    config ||
    loadSalesAppConfig({ envFile, env, candidates });
  const since = new Date(now);
  since.setDate(since.getDate() - 30);
  const sinceIso = since.toISOString();

  const deals = await fetchSatoRelatedDeals(cfg, {
    ledgerCases,
    fetchImpl,
  });
  const { customerById, linksByDeal, activityByDeal } =
    await fetchDealActivitySummary(cfg, { deals, sinceIso, now, fetchImpl });

  const usedDealIds = new Set();
  const rows = [];

  for (const caseItem of ledgerCases) {
    const { deal, method } = matchCaseToDeal(caseItem, deals, {
      customerById,
      linksByDeal,
    });
    if (deal) usedDealIds.add(deal.id);
    const activity = deal
      ? activityByDeal.get(deal.id) || {
          count14d: 0,
          count30d: 0,
          latestAt: null,
        }
      : { count14d: 0, count30d: 0, latestAt: null };
    const company =
      caseItem?.client ||
      customerById?.get(deal?.customer_id)?.company_name ||
      "";
    const discrepancies = detectDiscrepancies(
      { caseItem, deal, matchMethod: method, activity, companyName: company },
      now,
    );
    rows.push(
      buildReconcileRow({
        caseItem,
        deal,
        matchMethod: method,
        activity,
        discrepancies,
        customerById,
      }),
    );
  }

  // 佐藤担当 deal で台帳に無いもの
  for (const deal of deals) {
    if (usedDealIds.has(deal.id)) continue;
    if (!/佐藤/.test(String(deal.sales_owner || ""))) continue;
    const activity = activityByDeal.get(deal.id) || {
      count14d: 0,
      count30d: 0,
      latestAt: null,
    };
    const company = customerById?.get(deal.customer_id)?.company_name || "";
    const discrepancies = detectDiscrepancies(
      {
        caseItem: null,
        deal,
        matchMethod: "一致なし",
        activity,
        companyName: company,
      },
      now,
    );
    rows.push(
      buildReconcileRow({
        caseItem: null,
        deal,
        matchMethod: "一致なし",
        activity,
        discrepancies,
        customerById,
      }),
    );
  }

  return {
    ok: true,
    rows,
    sheet: reconcileRowsToSheet(rows),
    discrepancies: rows.filter((r) => r.discrepancy),
    reportLines: discrepancyReportLines(rows, 5),
    overdueActions: overdueContactActions(rows, now),
    stats: {
      dealCount: deals.length,
      rowCount: rows.length,
      discrepancyCount: rows.filter((r) => r.discrepancy).length,
      envFile: cfg.envFile || null,
    },
  };
}

export async function safeReconcileSalesApp(ledgerCases, deps = {}) {
  try {
    const result = await reconcileSalesAppWithLedger(ledgerCases, deps);
    return result;
  } catch (e) {
    return {
      ok: false,
      error: String(e?.message || e).replace(/\s+/g, " ").slice(0, 300),
      rows: [],
      sheet: reconcileRowsToSheet([]),
      discrepancies: [],
      reportLines: [],
      overdueActions: [],
      stats: { dealCount: 0, rowCount: 0, discrepancyCount: 0 },
    };
  }
}

export function defaultDryRunSalesLinkPath(home = os.homedir()) {
  return path.join(
    home,
    ".claude",
    "satou-secretary",
    "dryrun-sales-link-20261126.json",
  );
}
