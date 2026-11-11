import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
  isSatouCustomerMail,
  deliverReport,
  prioritizeActions,
  eligiblePriorityActions,
  calendarPriorityText,
  capReportLines,
  reportDeliveryText,
  LEDGER_FOOTER,
  shouldDeliver,
  currentMessageBody,
  caseForMessage,
  threadPersonNames,
  replaceUnknownPersonNames,
  completeReportSentence,
  finalizeReportLine,
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
test("メール担当は佐藤本人送信かつ顧客独自ドメインだけ", () => {
  assert.equal(isSatouCustomerMail({from:"佐藤 <satou@orgiast.jp>",to:"customer@example.co.jp"}),true);
  assert.equal(isSatouCustomerMail({from:"customer@example.co.jp",to:"satou@orgiast.jp"}),false);
  assert.equal(isSatouCustomerMail({from:"佐藤 <satou@orgiast.jp>",to:"person@gmail.com"}),false);
  assert.equal(isSatouCustomerMail({from:"佐藤 <satou@orgiast.jp>",to:"kim@orgiast.jp"}),false);
});
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
test("案件紐づきなしはLLMを呼ばず、判断なし・25行以内", async () => {
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
  assert.match(report.text, /■昨日の動き\n・なし/);
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
test("昨日の動きは案件紐づきだけで社内転送とLEADを除外し、優先0件はなし", async () => {
  const base={internalDate:String(+new Date("2026-11-09T12:00:00+09:00")),to:"satou@orgiast.jp",snippet:"相談です"};
  const report=await buildDailyReport({now:new Date("2026-11-10T06:30:00+09:00"),cases:[{code:"C1",client:"鹿沼CATV",name:"鹿沼催事",state:"確定",deliveryText:"2026-12-19"}],messages:[
    {...base,threadId:"1",subject:"鹿沼催事 打合せ",from:"小川 <ogawa@example.jp>"},
    {...base,threadId:"2",subject:"Fwd: 鹿沼催事",from:"kim@orgiast.jp",to:"satou@orgiast.jp"},
    {...base,threadId:"3",subject:"[LEAD:鹿沼催事]",from:"notice@example.jp"},
    {...base,threadId:"4",subject:"無関係",from:"other@example.jp"},
  ],actions:[]},{askLlm:async prompt=>prompt.includes("社長判断")||prompt.includes("問題候補")?"なし":"打合せ日程の相談が来た"});
  assert.match(report.text,/鹿沼CATV.*打合せ日程の相談が来た/);
  assert.doesNotMatch(report.text,/Fwd:|LEAD|無関係/);
  assert.match(report.text,/■今日の優先\n・なし/);
});
test("日次報告DMは1日1回、フッターなし・kim写しなし", async t => {
  const home=fs.mkdtempSync(path.join(os.tmpdir(),"satou-deliver-")); t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  let sends=0, options;
  const deps={home,fetchSendHistory:async()=>({target:"dm-1",messages:[]}),checkSendContext:()=>({ok:true,reason:"整合"}),sendDiscordDm:async(_target,_text,o)=>{sends++;options=o;return{delivered:true,channelId:"dm-1",messageId:"m-1"};}};
  const first=await deliverReport({text:"本文"},{now:new Date("2026-11-10T06:30:00+09:00"),deps});
  const second=await deliverReport({text:"本文"},{now:new Date("2026-11-10T07:00:00+09:00"),deps});
  assert.equal(first.messageId,"m-1"); assert.equal(second.reason,"already-delivered"); assert.equal(sends,1);
  assert.equal(options.noCopyKim,true); assert.equal(options.noReplyFooter,true);
});
test("通知・フリーメール・社内転送はメール担当の根拠にしない", () => {
  for (const to of ["no-reply@customer.jp", "notice@notifications.customer.jp", "info@imitsu.jp", "x@outlook.jp", "x@sub.orgiast.jp"])
    assert.equal(isSatouCustomerMail({from:"satou@orgiast.jp",to}), false, to);
  assert.equal(isSatouCustomerMail({from:"satou@orgiast.jp",to:"x@customer.jp",subject:"Fwd: LEAD"}),false);
  assert.equal(isSatouCustomerMail({from:"satou@orgiast.jp",to:"kim@orgiast.jp",cc:"x@customer.jp"}),true);
});
test("優先順位は今日の予定、期限、古い未返信、未来予定の順で日時はJST", () => {
  const row=(kind,date,name,state="未返信")=>[kind,date,name,"",state,""];
  const rows=[row("予定","2026/11/11 9:00:00","明日"),row("未返信メール","2026/11/9 9:00:00","新"),row("未返信メール","2026/11/2 9:00:00","古"),row("納品期限","2026-11-12","期限"),row("予定","2026/11/10 14:00:00","今日"),row("百貨店問い合わせ","2026/10/1 9:00:00","済","対応済み")];
  assert.deepEqual(prioritizeActions(rows,new Date("2026-11-10T06:30:00+09:00")).map(x=>x[2]),["今日","期限","古"]);
});
test("今日の優先は完了案件と百貨店ルートだけの他担当案件を除外し予定を短く表示", () => {
  const actions=[
    ["予定","2026/11/10 14:00:00","【打合せ】ビッグ東北様 2027全社員大会（丸山社長・加藤様）","","48時間以内",""],
    ["納品期限","2026-11-10","ジャパンホームショー 65インチモニターレンタル","Cocolive株式会社","納品完了",""],
    ["納品期限","2026-11-10","パレス催事","合同会社パレス","アプローチリスト",""],
    ["未返信メール","2026/11/9 9:00:00","返信してください","顧客","未返信",""]
  ];
  const cases=[
    {code:"261117COC",client:"Cocolive株式会社",name:"ジャパンホームショー 65インチモニターレンタル",state:"納品完了",reason:"営業"},
    {code:"261102PAL",client:"合同会社パレス",name:"パレス催事",state:"アプローチリスト",reason:"百貨店ルート"}
  ];
  const result=eligiblePriorityActions(actions,cases,new Date("2026-11-10T06:30:00+09:00"));
  assert.deepEqual(result.map(x=>x[2]),[actions[0][2],"返信してください"]);
  assert.equal(calendarPriorityText(actions[0]),"14:00 ビッグ東北様 打合せ");
});
test("報告末尾は25行制限外の台帳リンクだけでDMにも余計な一文を加えない", async () => {
  const report=await buildDailyReport({now:new Date("2026-11-10T06:30:00+09:00"),cases:[],messages:[],actions:[]},{askLlm:async()=>"なし"});
  assert.ok(report.lines.length<=25);
  assert.ok(report.text.endsWith(`\n\n${LEDGER_FOOTER}`));
  assert.equal(report.text.match(/https?:\/\//g)?.length,1);
  assert.equal(reportDeliveryText(report.text),`おはようございます。社長への業務報告の下書きです（このまま社長とのグループへ転送できます。直したい所は Claude に伝えてください）\n\n${report.text}`);
  assert.doesNotMatch(reportDeliveryText(report.text),/10\/26|到達確認/);
});
test("25行に収めても全見出しと優先3件は残す", () => {
  const headings=["■昨日の動き","■問題点","■解決が必要なこと","■社長判断が必要なこと"];
  const lines=["報告","■担当案件：14件",...headings.flatMap(x=>[x,...Array.from({length:9},(_,i)=>`・項目${i}`)]),"■今日の優先","1. 今日","2. 期限","3. 返信"];
  const capped=capReportLines(lines);
  assert.equal(capped.length,25);
  for(const h of headings) assert.ok(capped.includes(h));
  assert.deepEqual(capped.slice(-4),lines.slice(-4));
});
test("過去引用を今回の約束にせず、案件コード未採番は別枠にする", () => {
  assert.equal(currentMessageBody({body:"写真を送ります\n\nOn Thu, Nov 05 wrote:\n> 11/11までに回答を"}),"写真を送ります");
  assert.equal(currentMessageBody({body:"13日希望です\n\nFrom: someone\n9日確定"}),"13日希望です");
  const c=aggregateActiveCases([{code:"",client:"未採番",state:"確定",reason:"営業"},{code:"C1",state:"確定",reason:"営業"},{code:"C1_2",state:"確定",reason:"担当者列"}]);
  assert.equal(c.total,1); assert.equal(c.unnumbered.length,1);
  assert.deepEqual(c.reasonCounts,{営業:1,担当者列:1});
});
test("顧客が法人格を省略した返信も案件に結び、引用だけの顧客名は使わない", () => {
  const cases=[{code:"261219KNM",client:"鹿沼ケーブルテレビ株式会社"}];
  assert.equal(caseForMessage({body:"鹿沼ケーブルテレビ 小川です。13日11時希望です"},cases)?.code,"261219KNM");
  assert.equal(caseForMessage({body:"別の案件\nFrom: other\n鹿沼ケーブルテレビ株式会社"},cases),undefined);
});
test("要約入力は時系列、最終送信者と本文を含み、内部転送を他の節にも混ぜない", async () => {
  const prompts=[];
  const c={code:"261125TUM",client:"株式会社TOKIUM",state:"確定",deliveryText:"2026-11-25"};
  const m=(hour,from,body,subject="261125TUM")=>({internalDate:String(+new Date(`2026-11-09T${hour}:00:00+09:00`)),subject,from,to:"satou@orgiast.jp, c@tokium.jp",body,snippet:"短縮"});
  await buildDailyReport({now:new Date("2026-11-10T06:30:00+09:00"),cases:[c],messages:[m("13","satou@orgiast.jp","申込書の返送をお願いします"),m("12","c@tokium.jp","発注します"),m("14","kim@orgiast.jp","混ぜない転送本文","Fwd: 261125TUM")]},{askLlm:async p=>{prompts.push(p);return "なし";}});
  assert.match(prompts[0],/最終メッセージの送信者: satou@orgiast.jp（自社送信）/);
  assert.ok(prompts[0].indexOf("発注します")<prompts[0].indexOf("申込書の返送"));
  assert.ok(prompts.every(p=>!p.includes("混ぜない転送本文")));
});
test("案件内でもスレッドを分離し、別スレッドの人名を報告に出さない", async () => {
  const prompts = [], base = { internalDate: String(+new Date("2026-11-09T12:00:00+09:00")), to: "佐藤 優奈 <satou@orgiast.jp>", subject: "261125TUM 入館者", snippet: "確認" };
  const report = await buildDailyReport({ now: new Date("2026-11-10T06:30:00+09:00"), cases: [{ code: "261125TUM", client: "株式会社TOKIUM", state: "確定" }], messages: [
    { ...base, threadId: "tokium", from: "小形 <ogata@tokium.jp>", body: "入館者は稲沼です。\n\n小形" },
    { ...base, threadId: "other", from: "小川 <ogawa@example.jp>", body: "別件です。\n\n小川" },
  ], actions: [] }, { askLlm: async prompt => { prompts.push(prompt); if (prompt.includes("社長判断") || prompt.includes("問題候補")) return "なし"; return prompt.includes("ogata@tokium.jp") ? "稲沼氏の氏名を小川様に通知" : "小川様から別件の連絡を受領"; } });
  assert.equal(prompts.filter(x => x.includes("社長への報告本文")).length, 2);
  const tokiumLine = report.lines.find(line => line.includes("氏名を"));
  assert.equal(tokiumLine, "・TOKIUM：先方の氏名を先方に通知。");
  assert.doesNotMatch(tokiumLine, /小川様/);
});
test("報告行は70字以内の完結文で、省略記号では終わらない", async () => {
  let movementCalls = 0;
  const report = await buildDailyReport({ now: new Date("2026-11-10T06:30:00+09:00"), cases: [{ code: "261219KNM", client: "鹿沼ケーブルテレビ株式会社", state: "確定" }], messages: [
    { threadId: "one", internalDate: String(+new Date("2026-11-09T12:00:00+09:00")), subject: "261219KNM", from: "小川 <ogawa@example.jp>", to: "satou@orgiast.jp", body: "確認事項です。\n\n小川" },
  ], actions: [] }, { askLlm: async prompt => { if (prompt.includes("社長判断") || prompt.includes("問題候補")) return "なし"; movementCalls++; return movementCalls === 1 ? `小川様が${"確認事項を回答し".repeat(12)}…` : `小川様が${"確認事項を回答した。追加資料は後日送付する。".repeat(4)}`; } });
  const movement = report.lines.find(line => line.startsWith("・鹿沼CATV："));
  assert.equal(movementCalls, 2);
  assert.ok(movement.length <= 70, movement);
  assert.match(movement, /[。！？]$/);
  assert.doesNotMatch(movement, /…$/);
});
test("人名検査と完結文への縮約", () => {
  const names = threadPersonNames([{ from: "小形 <a@example.jp>", to: "佐藤 <satou@orgiast.jp>", body: "よろしくお願いします。\n小形" }]);
  assert.equal(replaceUnknownPersonNames("小形様が小川様へ連絡", names), "小形様が先方へ連絡");
  assert.equal(completeReportSentence("回答済み。追加説明が非常に長く続く。", 6), "回答済み。");
  assert.doesNotMatch(completeReportSentence("回答内容が長すぎて途中で省略される…", 10), /…$/);
  assert.equal(finalizeReportLine("・判断内容が途中で切れる…"), "・判断内容が途中で切れる。");
});
test("dry-runとno-deliverは配信しない", () => {
  assert.equal(shouldDeliver({dryRun:true}),false);
  assert.equal(shouldDeliver({noDeliver:true}),false);
  assert.equal(shouldDeliver({}),true);
});
test("同時実行と応答消失時は再送せず、ゲートNG時は送信済みにしない", async t => {
  const home=fs.mkdtempSync(path.join(os.tmpdir(),"satou-lock-")); t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  const now=new Date("2026-11-10T06:30:00+09:00");
  const deps={home,fetchSendHistory:async()=>({target:"dm",messages:[]}),checkSendContext:()=>({ok:false,reason:"重複"}),sendDiscordDm:async()=>assert.fail("NGでは送信しない")};
  await assert.rejects(()=>deliverReport({text:"本文"},{now,deps}),/履歴照合NG/);
  assert.equal(fs.existsSync(path.join(home,".claude/satou-secretary/delivered-2026-11-10")),false);
  let sends=0;
  deps.checkSendContext=()=>({ok:true,reason:"OK"});
  deps.sendDiscordDm=async()=>{sends++; await assert.rejects(()=>deliverReport({text:"本文"},{now,deps}),/実行中/);throw Error("応答消失");};
  await assert.rejects(()=>deliverReport({text:"本文"},{now,deps}),/応答消失/);
  await assert.rejects(()=>deliverReport({text:"本文"},{now,deps}),/送信結果未確認/);
  assert.equal(sends,1);
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
