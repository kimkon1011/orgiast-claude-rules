import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  normalizeCompanyName,
  isGenericCompanyName,
  isTestCompanyName,
  isEmptyOrLegalOnlyCompanyName,
  matchCaseToDeal,
  detectDiscrepancies,
  createReadOnlyFetch,
  reconcileSalesAppWithLedger,
  safeReconcileSalesApp,
  discrepancyReportLines,
  buildReconcileRow,
  salesAppStatusLabel,
  loadSalesAppConfig,
  LINE_SEND_ENV_FILE,
  DEFAULT_SALES_APP_ENV_FILE,
} from "../lib/sales-app-read.mjs";
import { buildDailyReport, run, TABS } from "../satou-secretary-daily.mjs";

test("TABS に自動_営業アプリ照合がある", () => {
  assert.ok(TABS.includes("自動_営業アプリ照合"));
});

test("会社名正規化は株式会社・空白・全角半角を除去", () => {
  assert.equal(
    normalizeCompanyName("株式会社　ニッケ機械製作所"),
    normalizeCompanyName("(株)ニッケ機械製作所"),
  );
  assert.equal(normalizeCompanyName("ＡＢＣ　株式会社"), "abc");
});

test("汎用語の会社名は照合に使わない", () => {
  assert.equal(isGenericCompanyName("制作"), true);
  assert.equal(isGenericCompanyName("ディレクター"), true);
  assert.equal(isGenericCompanyName("株式会社ニッケ機械製作所"), false);
});

test("テスト会社名・法人格のみを除外判定できる", () => {
  assert.equal(isTestCompanyName("取込テスト株式会社"), true);
  assert.equal(isTestCompanyName("株式会社ニッケ"), false);
  assert.equal(isEmptyOrLegalOnlyCompanyName("株式会社"), true);
  assert.equal(isEmptyOrLegalOnlyCompanyName(""), true);
  assert.equal(isEmptyOrLegalOnlyCompanyName("株式会社ニッケ"), false);
});

test("照合: deal_code 確定リンクを最優先", () => {
  const deals = [
    {
      id: "d1",
      deal_code: "261101NIS",
      customer_id: "c1",
      status: "進行中",
      progress: "見積提出済",
    },
    {
      id: "d2",
      deal_code: null,
      customer_id: "c2",
      status: "進行中",
      progress: "未対応",
    },
  ];
  const hit = matchCaseToDeal(
    { code: "261101NIS", client: "株式会社ニッケ", masterRow: 99 },
    deals,
    {
      customerById: new Map([
        ["c1", { company_name: "別会社" }],
        ["c2", { company_name: "株式会社ニッケ" }],
      ]),
      linksByDeal: new Map(),
    },
  );
  assert.equal(hit.method, "deal_code");
  assert.equal(hit.deal.id, "d1");
});

test("照合: master_row_links で行番号一致", () => {
  const deals = [
    { id: "d9", deal_code: null, customer_id: "c9", status: "進行中" },
  ];
  const hit = matchCaseToDeal(
    { code: "", client: "無関係", masterRow: 42 },
    deals,
    {
      customerById: new Map([["c9", { company_name: "別" }]]),
      linksByDeal: new Map([
        ["d9", [{ last_row_number: 42, missing_since: null }]],
      ]),
    },
  );
  assert.equal(hit.method, "master_row_links");
  assert.equal(hit.deal.id, "d9");
});

test("照合: 正規化会社名の完全一致", () => {
  const deals = [
    { id: "d3", deal_code: null, customer_id: "c3", status: "進行中" },
  ];
  const hit = matchCaseToDeal(
    { code: "X", client: "（株）ニッケ機械製作所", masterRow: 1 },
    deals,
    {
      customerById: new Map([
        ["c3", { company_name: "株式会社ニッケ機械製作所" }],
      ]),
      linksByDeal: new Map(),
    },
  );
  assert.equal(hit.method, "company_name");
  assert.equal(hit.deal.id, "d3");
});

test("照合: 汎用語だけの会社名は一致させない", () => {
  const deals = [
    { id: "d4", deal_code: null, customer_id: "c4", status: "進行中" },
  ];
  const hit = matchCaseToDeal(
    { code: "", client: "制作", masterRow: 1 },
    deals,
    {
      customerById: new Map([["c4", { company_name: "制作" }]]),
      linksByDeal: new Map(),
    },
  );
  assert.equal(hit.method, "一致なし");
  assert.equal(hit.deal, null);
});

test("食い違いなし: 受注×納品完了は一致扱い", () => {
  const reasons = detectDiscrepancies(
    {
      caseItem: {
        code: "261117COC",
        client: "Cocolive株式会社",
        state: "納品完了",
      },
      deal: {
        status: "受注",
        progress: "",
        next_contact_date: "2026-11-18",
      },
      activity: { count14d: 3, count30d: 3, latestAt: "2026-11-17T02:09:21Z" },
    },
    new Date("2026-11-26T06:30:00+09:00"),
  );
  assert.deepEqual(reasons, []);
});

test("食い違いなし: 受注×確定も一致扱い", () => {
  const reasons = detectDiscrepancies(
    {
      caseItem: { code: "X", client: "X社", state: "確定" },
      deal: { status: "受注", next_contact_date: "2026-11-01" },
      activity: { count14d: 1, count30d: 1 },
    },
    new Date("2026-11-26T06:30:00+09:00"),
  );
  assert.deepEqual(reasons, []);
});

test("食い違い: マスター失注×営業アプリ進行中（ニッケ型）", () => {
  const reasons = detectDiscrepancies(
    {
      caseItem: {
        code: "261101NIS",
        client: "株式会社ニッケ機械製作所",
        state: "失注",
      },
      deal: { status: "進行中", progress: "見積提出済", next_contact_date: null },
      activity: { count14d: 2, count30d: 2, latestAt: "2026-11-20T00:00:00Z" },
    },
    new Date("2026-11-26T06:30:00+09:00"),
  );
  assert.ok(reasons.some((x) => /マスターは失注/.test(x)));
});

test("食い違い: マスター失注×直近やり取りあり", () => {
  const reasons = detectDiscrepancies(
    {
      caseItem: { code: "A", client: "A社", state: "失注" },
      deal: { status: "失注", progress: "失注" },
      activity: { count14d: 1, count30d: 1, latestAt: "2026-11-25T00:00:00Z" },
    },
    new Date("2026-11-26T06:30:00+09:00"),
  );
  assert.ok(reasons.some((x) => /直近14日/.test(x)));
});

test("食い違い: マスター進行中系×営業アプリ失注", () => {
  const reasons = detectDiscrepancies(
    {
      caseItem: { code: "B", client: "B社", state: "アプローチリスト" },
      deal: { status: "失注", progress: "失注" },
      activity: { count14d: 0, count30d: 0 },
    },
    new Date("2026-11-26T06:30:00+09:00"),
  );
  assert.deepEqual(reasons, ["マスターは進行中だが営業アプリは失注"]);
});

test("食い違いなし: マスター確定×営業アプリ失注は判定しない", () => {
  const reasons = detectDiscrepancies(
    {
      caseItem: { code: "B2", client: "B社", state: "確定" },
      deal: { status: "失注", progress: "失注" },
      activity: { count14d: 0, count30d: 0 },
    },
    new Date("2026-11-26T06:30:00+09:00"),
  );
  assert.deepEqual(reasons, []);
});

test("食い違いなし: 未知のマスター状態は判定しない", () => {
  const reasons = detectDiscrepancies(
    {
      caseItem: { code: "U", client: "U社", state: "保留中" },
      deal: { status: "失注", progress: "失注" },
      activity: { count14d: 0, count30d: 0 },
    },
    new Date("2026-11-26T06:30:00+09:00"),
  );
  assert.deepEqual(reasons, []);
});

test("食い違い: next_contact_date 超過は進行中/追いかけだけ", () => {
  const now = new Date("2026-11-26T06:30:00+09:00");
  const open = detectDiscrepancies(
    {
      caseItem: { code: "C", client: "C社", state: "アプローチリスト" },
      deal: {
        status: "進行中",
        progress: "未対応",
        next_contact_date: "2026-11-20",
      },
      activity: { count14d: 0, count30d: 0 },
    },
    now,
  );
  assert.ok(open.some((x) => /次回連絡日/.test(x)));

  const won = detectDiscrepancies(
    {
      caseItem: { code: "C2", client: "C社", state: "確定" },
      deal: {
        status: "受注",
        next_contact_date: "2026-11-20",
      },
      activity: { count14d: 0, count30d: 0 },
    },
    now,
  );
  assert.equal(won.some((x) => /次回連絡日/.test(x)), false);
});

test("食い違い: 営業アプリ未登録は残すが日報には出さない", () => {
  assert.deepEqual(
    detectDiscrepancies({
      caseItem: { code: "D", client: "D社", state: "確定" },
      deal: null,
    }),
    ["営業アプリ未登録"],
  );
  const lines = discrepancyReportLines([
    buildReconcileRow({
      caseItem: { code: "D", client: "D社", name: "案件D", state: "確定" },
      deal: null,
      discrepancies: ["営業アプリ未登録"],
    }),
    buildReconcileRow({
      caseItem: {
        code: "261101NIS",
        client: "株式会社ニッケ機械製作所",
        name: "設立50周年",
        state: "アプローチリスト",
      },
      deal: { status: "失注" },
      discrepancies: ["マスターは進行中だが営業アプリは失注"],
    }),
  ]);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /ニッケ/);
  assert.equal(lines.some((x) => /営業アプリ未登録/.test(x)), false);
});

test("マスター未掲載: 失注の古い deal は出ない", () => {
  const reasons = detectDiscrepancies(
    {
      caseItem: null,
      deal: {
        status: "失注",
        sales_owner: "佐藤優奈",
        next_contact_date: "2025-01-01",
      },
      activity: { count14d: 0, count30d: 0 },
      companyName: "古い失注株式会社",
    },
    new Date("2026-11-26T06:30:00+09:00"),
  );
  assert.deepEqual(reasons, []);
});

test("マスター未掲載: 受注済みは出ない", () => {
  const reasons = detectDiscrepancies(
    {
      caseItem: null,
      deal: {
        status: "受注",
        next_contact_date: "2026-11-20",
      },
      activity: { count14d: 2, count30d: 5 },
      companyName: "受注済み株式会社",
    },
    new Date("2026-11-26T06:30:00+09:00"),
  );
  assert.deepEqual(reasons, []);
});

test("マスター未掲載: 進行中かつ直近30日ありは出る", () => {
  const reasons = detectDiscrepancies(
    {
      caseItem: null,
      deal: {
        status: "進行中",
        next_contact_date: null,
      },
      activity: { count14d: 0, count30d: 2, latestAt: "2026-11-10T00:00:00Z" },
      companyName: "新規株式会社",
    },
    new Date("2026-11-26T06:30:00+09:00"),
  );
  assert.deepEqual(reasons, ["マスター未掲載（佐藤担当deal）"]);
});

test("マスター未掲載: テストデータと法人格のみは除外", () => {
  const now = new Date("2026-11-26T06:30:00+09:00");
  assert.deepEqual(
    detectDiscrepancies(
      {
        caseItem: null,
        deal: { status: "進行中", next_contact_date: "2026-12-01" },
        activity: { count30d: 1 },
        companyName: "取込テスト株式会社",
      },
      now,
    ),
    [],
  );
  assert.deepEqual(
    detectDiscrepancies(
      {
        caseItem: null,
        deal: { status: "進行中", next_contact_date: "2026-12-01" },
        activity: { count30d: 1 },
        companyName: "株式会社",
      },
      now,
    ),
    [],
  );
});

test("日報並び: 状態逆転 → 次回連絡超過 → マスター未掲載", () => {
  const lines = discrepancyReportLines(
    [
      buildReconcileRow({
        caseItem: null,
        deal: { status: "進行中", deal_title: "未掲載案件" },
        discrepancies: ["マスター未掲載（佐藤担当deal）"],
        customerById: new Map(),
      }),
      buildReconcileRow({
        caseItem: { code: "O", client: "超過社", name: "超過", state: "アプローチリスト" },
        deal: { status: "進行中", next_contact_date: "2026-11-01" },
        discrepancies: ["次回連絡日 2026-11-01 超過（未対応）"],
      }),
      buildReconcileRow({
        caseItem: {
          code: "261101NIS",
          client: "株式会社ニッケ機械製作所",
          name: "設立50周年",
          state: "アプローチリスト",
        },
        deal: { status: "失注" },
        discrepancies: ["マスターは進行中だが営業アプリは失注"],
      }),
    ],
    5,
  );
  assert.equal(lines.length, 3);
  assert.match(lines[0], /ニッケ|進行中だが営業アプリは失注/);
  assert.match(lines[1], /次回連絡日/);
  assert.match(lines[2], /マスター未掲載/);
});

test("GET 以外の method は拒否する", async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || "GET" });
    return new Response("[]", {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const readOnly = createReadOnlyFetch(fetchImpl);
  await readOnly("https://example.test/rest/v1/deals", { method: "GET" });
  await assert.rejects(
    () => readOnly("https://example.test/rest/v1/deals", { method: "POST", body: "{}" }),
    /GET 以外は禁止/,
  );
  await assert.rejects(
    () => readOnly("https://example.test/rest/v1/deals", { method: "PATCH" }),
    /GET 以外は禁止/,
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "GET");
});

test("reconcile は Supabase へ GET 以外を送らない", async () => {
  const methods = new Set();
  const deals = [
    {
      id: "deal-nikke",
      deal_code: "261101NIS",
      deal_title: "設立50周年",
      status: "進行中",
      progress: "見積提出済",
      sales_owner: "佐藤優奈",
      next_contact_date: null,
      customer_id: "cust-nikke",
    },
  ];
  const fetchImpl = async (url, init = {}) => {
    methods.add(String(init.method || "GET").toUpperCase());
    const u = String(url);
    if (u.includes("/deals?")) return Response.json(deals);
    if (u.includes("/customers?"))
      return Response.json([
        { id: "cust-nikke", company_name: "株式会社ニッケ機械製作所" },
      ]);
    if (u.includes("/channel_messages?"))
      return Response.json([
        {
          id: "m1",
          deal_id: "deal-nikke",
          customer_id: "cust-nikke",
          received_at: "2026-11-20T01:00:00Z",
        },
      ]);
    if (u.includes("/deal_activities?")) return Response.json([]);
    if (u.includes("/master_row_links?")) return Response.json([]);
    return Response.json([]);
  };
  const result = await reconcileSalesAppWithLedger(
    [
      {
        code: "261101NIS",
        client: "株式会社ニッケ機械製作所",
        name: "設立50周年行事",
        state: "失注",
        masterRow: 10,
      },
    ],
    {
      now: new Date("2026-11-26T06:30:00+09:00"),
      config: { url: "https://example.supabase.co", key: "test-key" },
      fetchImpl,
    },
  );
  assert.equal(result.ok, true);
  assert.deepEqual([...methods], ["GET"]);
  const nikke = result.rows.find((r) => r.code === "261101NIS");
  assert.ok(nikke);
  assert.match(nikke.discrepancy, /マスターは失注/);
  assert.equal(nikke.matchMethod, "deal_code");
  assert.equal(salesAppStatusLabel({ status: "進行中", progress: "見積提出済" }), "進行中・見積提出済");
});

test("鍵の探索: 環境変数なしで .env.local に鍵が無ければ line-send.env へ", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "satou-sales-env-"));
  const envLocal = path.join(dir, ".env.local");
  const lineSend = path.join(dir, "line-send.env");
  fs.writeFileSync(envLocal, "VERCEL_OIDC_TOKEN=only-oidc\n");
  fs.writeFileSync(
    lineSend,
    "SUPABASE_URL=https://example.supabase.co\nSUPABASE_SERVICE_ROLE_KEY=secret-key\n",
  );
  const cfg = loadSalesAppConfig({
    env: {},
    candidates: [envLocal, lineSend],
  });
  assert.equal(cfg.envFile, lineSend);
  assert.equal(cfg.url, "https://example.supabase.co");
  assert.equal(cfg.key, "secret-key");
});

test("鍵の探索: .env.local に URL+鍵があればそれを使う", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "satou-sales-env2-"));
  const envLocal = path.join(dir, ".env.local");
  const lineSend = path.join(dir, "line-send.env");
  fs.writeFileSync(
    envLocal,
    "NEXT_PUBLIC_SUPABASE_URL=https://from-local.supabase.co\nSUPABASE_SERVICE_ROLE_KEY=local-key\n",
  );
  fs.writeFileSync(
    lineSend,
    "SUPABASE_URL=https://example.supabase.co\nSUPABASE_SERVICE_ROLE_KEY=secret-key\n",
  );
  const cfg = loadSalesAppConfig({
    env: {},
    candidates: [envLocal, lineSend],
  });
  assert.equal(cfg.envFile, envLocal);
  assert.equal(cfg.url, "https://from-local.supabase.co");
});

test("鍵の探索: SALES_APP_ENV_FILE があればそれだけ見る", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "satou-sales-env3-"));
  const forced = path.join(dir, "forced.env");
  const lineSend = path.join(dir, "line-send.env");
  fs.writeFileSync(
    forced,
    "SUPABASE_URL=https://forced.supabase.co\nSUPABASE_SERVICE_ROLE_KEY=forced-key\n",
  );
  fs.writeFileSync(
    lineSend,
    "SUPABASE_URL=https://example.supabase.co\nSUPABASE_SERVICE_ROLE_KEY=secret-key\n",
  );
  const cfg = loadSalesAppConfig({
    env: { SALES_APP_ENV_FILE: forced },
  });
  assert.equal(cfg.envFile, forced);
  assert.equal(cfg.url, "https://forced.supabase.co");
});

test("鍵の既定候補に .env.local と line-send.env が含まれる", () => {
  assert.equal(DEFAULT_SALES_APP_ENV_FILE.includes("aujust-sales-automation"), true);
  assert.equal(LINE_SEND_ENV_FILE.includes("line-send.env"), true);
  const cfg = loadSalesAppConfig({ env: {} });
  assert.equal(cfg.envFile, LINE_SEND_ENV_FILE);
  assert.ok(cfg.url);
  assert.ok(cfg.key);
});

test("読み取り失敗でも日報は止まらず失敗1行を出す", async () => {
  const report = await buildDailyReport(
    {
      now: new Date("2026-11-26T06:30:00+09:00"),
      cases: [],
      messages: [],
      actions: [],
      salesApp: { ok: false, error: "接続ファイルなし", reportLines: [] },
    },
    { askLlm: async () => "なし" },
  );
  assert.match(report.text, /■営業アプリとの食い違い/);
  assert.match(report.text, /営業アプリ: 読み取り失敗（接続ファイルなし）/);
});

test("食い違い0件なら節ごと出さない", async () => {
  const report = await buildDailyReport(
    {
      now: new Date("2026-11-26T06:30:00+09:00"),
      cases: [],
      messages: [],
      actions: [],
      salesApp: { ok: true, reportLines: [], discrepancies: [] },
    },
    { askLlm: async () => "なし" },
  );
  assert.equal(report.text.includes("■営業アプリとの食い違い"), false);
});

test("safeReconcile は例外を日報停止にしない", async () => {
  const result = await safeReconcileSalesApp([], {
    config: { url: "https://example.supabase.co", key: "k" },
    fetchImpl: async () => {
      throw new Error("network down");
    },
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /network down/);
});

test("run dry-run: 営業アプリ失敗でも report を返す", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "satou-sales-dry-"));
  const dryPath = path.join(dir, "dryrun-sales-link-20261126.json");
  const masterHeader = [
    "案件名",
    "納品日",
    "営業",
    "予算項目",
    "クライアント名",
    "ｺｰﾄﾞ",
    "制作",
    "売上",
    "実施計画URL",
    "見積書URL",
    "案件ルート",
  ];
  const result = await run({
    now: new Date("2026-11-26T06:30:00+09:00"),
    dryRun: true,
    deps: {
      home: dir,
      dryRunSalesLinkPath: dryPath,
      sleepImpl: async () => {},
      searchGmail: async () => ({ messages: [] }),
      readMail: async () => ({
        messages: [],
        unanswered: [],
        departmentStoreJudgment: [],
        departmentStoreCustomers: [],
        aimitsu: [],
      }),
      readCalendar: async () => [],
      readTldv: async () => ({ items: [], note: "" }),
      reconcileSalesApp: async () => ({
        ok: false,
        error: "forced",
        rows: [],
        sheet: [[
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
        ]],
        discrepancies: [],
        reportLines: [],
        overdueActions: [],
        stats: { dealCount: 0, rowCount: 0, discrepancyCount: 0 },
      }),
      fetchImpl: async (url) => {
        if (String(url).includes("14RC6og")) {
          return Response.json({ values: [masterHeader] });
        }
        throw new Error(`unexpected fetch ${url}`);
      },
      getSheetsToken: async () => "tok",
      askLlm: async () => "なし",
    },
  });
  assert.equal(result.write.mode, "dry-run");
  assert.ok(result.errors.some((e) => /営業アプリ: 読み取り失敗/.test(e)));
  assert.match(result.report.text, /営業アプリ: 読み取り失敗（forced）/);
  assert.equal(fs.existsSync(dryPath), true);
  const saved = JSON.parse(fs.readFileSync(dryPath, "utf8"));
  assert.equal(saved.salesApp.ok, false);
});

test("discrepancyReportLines は最大5行", () => {
  const rows = Array.from({ length: 8 }, (_, i) =>
    buildReconcileRow({
      caseItem: { code: `C${i}`, client: `会社${i}`, name: `案件${i}`, state: "失注" },
      deal: { status: "進行中", progress: "未対応" },
      discrepancies: ["マスターは失注だが営業アプリは進行中系"],
      matchMethod: "deal_code",
    }),
  );
  assert.equal(discrepancyReportLines(rows, 5).length, 5);
});
