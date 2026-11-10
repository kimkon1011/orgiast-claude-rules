import test from "node:test";
import assert from "node:assert/strict";
import {
  headerMap,
  extractCases,
  extractAimitsu,
  classifyDepartmentStoreThread,
  write,
  TABS,
  aggregateActiveCases,
  isInPreviousJstDay,
  buildDailyReport,
} from "./satou-secretary-daily.mjs";
const now = new Date("2026-11-09T06:30:00+09:00"),
  h = [
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
    "営業スタッフ",
    "案件ルート",
  ],
  r = (n, d, s, st, c, code, p = "", staff = "", route = "") => [
    n,
    d,
    s,
    st,
    c,
    code,
    p,
    100,
    "plan",
    "estimate",
    staff,
    route,
  ];
test("ヘッダー名を正規化して特定", () =>
  assert.equal(headerMap([" 営業ｻﾌﾞＰ "]).get("営業サブP"), 0));
test("一次担当は全件、担当者列は確定/アプローチのみ", () =>
  assert.deepEqual(
    extractCases(
      [
        h,
        r("a", "2026/11/01", "佐藤優奈", "失注", "A", "A"),
        r("b", "2026/12/01", "別", "確定", "B", "B", "", "佐藤優奈"),
        r("c", "2026/12/01", "別", "失注", "C", "C", "", "佐藤優奈"),
        r("d", "2026/12/01", "別", "保留", "D", "D", "佐藤優奈"),
      ],
      now,
    ).map((x) => x.code),
    ["A", "B", "D"],
  ));
test("30日より前の納品完了/失注を除外", () =>
  assert.deepEqual(
    extractCases(
      [
        h,
        r("old", "2026/10/01", "佐藤優奈", "納品完了", "A", "OLD"),
        r("new", "2026/10/20", "佐藤優奈", "納品完了", "B", "NEW"),
      ],
      now,
    ).map((x) => x.code),
    ["NEW"],
  ));
test("営業・制作・百貨店ルートを状態不問で拾い理由を記録", () => {
  const x = extractCases(
    [
      h,
      r("sales", "2026/12/01", "佐藤優奈", "保留", "A", "S"),
      r("prod", "2026/12/01", "別", "保留", "B", "P", "佐藤優奈"),
      r(
        "route1",
        "2026/12/01",
        "別",
        "失注",
        "C",
        "R1",
        "",
        "",
        "社内イベント百貨店",
      ),
      r(
        "route2",
        "2026/12/01",
        "別",
        "保留",
        "D",
        "R2",
        "",
        "",
        "https://event-shop.jp/case",
      ),
    ],
    now,
  );
  assert.deepEqual(
    x.map((v) => [v.code, v.reason]),
    [
      ["S", "営業"],
      ["P", "制作"],
      ["R1", "百貨店ルート"],
      ["R2", "百貨店ルート"],
    ],
  );
});
test("アイミツ通知抽出", () => {
  const x = extractAimitsu([
    {
      from: "info@imitsu.jp",
      threadId: "t",
      subject: "通知",
      body: "案件No: 123 企業名: 株式会社テスト\n未回答案件",
    },
  ]);
  assert.equal(x[0].caseNo, "123");
  assert.equal(x[0].company, "株式会社テスト");
  assert.equal(x[0].unanswered, true);
});
test("百貨店宛て売り込みは要判断、森・佐藤名義の返信済み顧客スレッドは要対応", () => {
  const sales = classifyDepartmentStoreThread([
    {
      internalDate: "1",
      from: "vendor@example.com",
      to: "info@event-shop.jp",
      subject: "広告のご案内",
    },
  ]);
  assert.equal(sales.judgment, true);
  assert.equal(sales.customer, false);
  const customer = classifyDepartmentStoreThread([
    {
      internalDate: "1",
      from: "社内イベント百貨店の森 <seisaku-team@orgiast.jp>",
      to: "customer@example.com",
      subject: "お問い合わせ",
    },
    {
      internalDate: "2",
      from: "customer@example.com",
      to: "seisaku-team@orgiast.jp",
      subject: "Re: お問い合わせ",
    },
  ]);
  assert.equal(customer.customer, true);
  assert.equal(customer.unanswered, true);
  assert.equal(customer.judgment, false);
});
test("前金・残金の分割行を案件コード単位で統合", () => {
  const x = aggregateActiveCases([
    { code: "261125TUM", state: "確定" },
    { code: "261125TUM_2", state: "確定" },
    { code: "261219KNM", state: "提案中" },
    { code: "OLD", state: "失注" },
  ]);
  assert.deepEqual([x.total, x.confirmed, x.adjusting], [2, 1, 1]);
});
test("昨日判定はJST 00:00境界", () => {
  const base = new Date("2026-11-10T06:30:00+09:00");
  assert.equal(isInPreviousJstDay("2026-11-09T00:00:00+09:00", base), true);
  assert.equal(isInPreviousJstDay("2026-11-09T23:59:59+09:00", base), true);
  assert.equal(isInPreviousJstDay("2026-11-10T00:00:00+09:00", base), false);
});
test("LLM全滅時は件名と送信者へフォールバックし判断なし、25行以内", async () => {
  const messages = Array.from({ length: 30 }, (_, i) => ({
      threadId: `t${i}`,
      internalDate: String(+new Date("2026-11-09T12:00:00+09:00") + i),
      subject: `件名${i}`,
      from: `顧客${i} <c${i}@example.com>`,
      to: "satou@orgiast.jp",
      snippet: "本文",
    })),
    report = await buildDailyReport(
      {
        now: new Date("2026-11-10T06:30:00+09:00"),
        cases: [],
        messages,
        actions: [],
      },
      {
        askLlm: async () => {
          throw Error("all down");
        },
      },
    );
  assert.match(report.text, /件名0（顧客0）/);
  assert.match(report.text, /■社長判断が必要なこと\n・なし/);
  assert.ok(report.lines.length <= 25);
});
test("社長判断が無いときは「なし」", async () => {
  const report = await buildDailyReport(
    {
      now: new Date("2026-11-10T06:30:00+09:00"),
      cases: [],
      messages: [],
      actions: [],
    },
    { askLlm: async () => "なし" },
  );
  assert.match(report.text, /■社長判断が必要なこと\n・なし/);
});
test("各自動タブを独立更新しシート1へ書かない", async () => {
  const writes = [],
    sheets = [
      {
        properties: {
          title: "シート1",
          sheetId: 1,
          gridProperties: { columnCount: 26 },
        },
      },
      ...TABS.map((title, i) => ({
        properties: {
          title,
          sheetId: i + 10,
          gridProperties: { columnCount: i ? 26 : 1 },
        },
      })),
    ],
    fetchImpl = async (url, o = {}) => {
      if (o.method === "POST") {
        const body = JSON.parse(o.body);
        writes.push(body);
        if (body.requests?.[0]?.repeatCell?.range?.sheetId === 11)
          return new Response('{"error":"bad tab"}', { status: 400 });
        return Response.json({});
      }
      if (url.includes("?fields=")) return Response.json({ sheets });
      if (decodeURIComponent(url).includes("'シート1'!A:L"))
        return Response.json({ values: [["keep"], ["safe"]] });
      return Response.json({ values: [["header"], ["row"]] });
    },
    tables = Object.fromEntries(TABS.map((x) => [x, [["h", "extra"], ["v"]]]));
  tables["自動_実行ログ"] = [
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
    ["now", 0, 0, 0, 0, 0, 0, 0, 0, ""],
  ];
  const result = await write(
    { tables },
    { getSheetsToken: async () => "token", fetchImpl },
  );
  assert.equal(result.sheet1Unchanged, true);
  assert.equal(result.failures.length, 1);
  assert.ok(result.failures[0].startsWith("自動_今日の要対応 更新:"));
  assert.ok(
    writes.every((x) =>
      x.requests.every(
        (r) =>
          r.repeatCell?.range?.sheetId !== 1 &&
          r.updateCells?.range?.sheetId !== 1,
      ),
    ),
  );
  assert.equal(writes[0].requests[0].appendDimension.length, 1);
  assert.ok(
    writes
      .flatMap((x) => x.requests)
      .filter((x) => x.updateCells)
      .every((x) => x.updateCells.range.endColumnIndex === undefined),
  );
  assert.ok(
    writes.some((x) => JSON.stringify(x).includes("自動_今日の要対応 更新")),
  );
});
