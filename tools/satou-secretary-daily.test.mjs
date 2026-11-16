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
  run,
  deliveryFailureNoticeText,
  notifyDeliveryFailure,
} from "./satou-secretary-daily.mjs";
import { register, TASK_NAME, TASK_RETRY_NAME } from "./satou-secretary-daily-register.mjs";
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
  assert.equal(reportDeliveryText(report.text),`おはようございます。毎日の業務状況報告です。\n\n${report.text}`);
  assert.doesNotMatch(reportDeliveryText(report.text).replace(/https?:\/\/\S+/g,''),/ください|\?|？/);
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
test("送信前履歴照合は日次DMを定期報告（佐藤さん本人・毎日の状況報告）として渡す", async t => {
  const home=fs.mkdtempSync(path.join(os.tmpdir(),"satou-periodic-")); t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  let gateOptions;
  const deps={home,fetchSendHistory:async()=>({target:"dm-1",messages:[]}),
    checkSendContext:async(_history,_text,opts)=>{gateOptions=opts;return{ok:true,reason:"整合"};},
    sendDiscordDm:async()=>({delivered:true,channelId:"dm-1",messageId:"m-1"})};
  await deliverReport({text:"本文"},{now:new Date("2026-11-10T06:30:00+09:00"),deps});
  assert.equal(gateOptions.periodicReport.recipient,"佐藤優奈");
  assert.equal(gateOptions.periodicReport.kind,"毎日の状況報告");
});
test("送信済みの印があれば再実行（07:30枠）は何もしない", async t => {
  const home=fs.mkdtempSync(path.join(os.tmpdir(),"satou-skip-")); t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  const dir=path.join(home,".claude","satou-secretary"); fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(dir,"delivered-2026-11-10"),"{}\n");
  let sources=0;
  const p=await run({now:new Date("2026-11-10T07:30:00+09:00"),deps:{home,searchGmail:async()=>{sources++;return{messages:[]};}}});
  assert.equal(p.skipped,"already-delivered");
  assert.equal(p.write.mode,"skipped");
  assert.equal(sources,0);
});

test("ソース単位で最大4回試し、成功ソースとメール原本を本番配信ゲートまで保持する", async t => {
  const home=fs.mkdtempSync(path.join(os.tmpdir(),"satou-sources-")); t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  const delays=[], counts={evidence:0,mail:0,calendar:0,tldv:0}; let gate;
  const message={threadId:"original",from:"小川 <ogawa@example.jp>",to:"satou@orgiast.jp",subject:"原本",body:"x".repeat(800)+"小川様、11月14日、金額は12万円。",internalDate:String(+new Date("2026-11-12T12:00:00+09:00"))};
  const sheets=[{properties:{title:"シート1",sheetId:1,gridProperties:{columnCount:26}}},...TABS.map((title,i)=>({properties:{title,sheetId:i+10,gridProperties:{columnCount:26}}}))];
  const result=await run({now:new Date("2026-11-13T06:30:00+09:00"),deps:{
    home,sleepImpl:async ms=>delays.push(ms),getSheetsToken:async()=>"test",askLlm:async()=>"なし",
    searchGmail:async()=>{counts.evidence++;return{messages:[]};},
    readMail:async()=>{if(++counts.mail<3)throw Error("channel gws: HTTP 500");return{messages:[message],unanswered:[],departmentStoreJudgment:[],departmentStoreCustomers:[],aimitsu:[]};},
    readCalendar:async()=>{counts.calendar++;throw new TypeError("fetch failed");},
    readTldv:async()=>{counts.tldv++;return{items:[],note:""};},
    fetchImpl:async(url,o={})=>o.method==="POST"?Response.json({}):String(url).includes("fields=sheets.properties")?Response.json({sheets}):Response.json({values:decodeURIComponent(url).includes("案件一覧")?[h]:[["keep"]]}),
    fetchSendHistory:async()=>({target:"dm",messages:[]}),checkSendContext:async(_history,_text,opts)=>{gate=opts;return{ok:true,reason:"整合"};},
    sendDiscordDm:async()=>({delivered:true,messageId:"m",channelId:"dm"}),
  }});
  assert.deepEqual(counts,{evidence:1,mail:3,calendar:4,tldv:1});
  assert.deepEqual(delays,[60000,180000,60000,180000,600000]);
  assert.match(gate.periodicReport.sourceEvidence,/小川様、11月14日、金額は12万円/);
  assert.equal(result.delivery.delivered,true);
  assert.match(result.report.text,/（メール取得失敗のため一部未反映）$/);
});

test("定期報告でも質問・日付・金額・人名の不一致NGは配信を止める", async t => {
  for(const reason of ["佐藤さんへの質問","日付が原本と不一致","金額が原本と不一致","人名が原本と不一致"]){
    const home=fs.mkdtempSync(path.join(os.tmpdir(),"satou-gate-ng-")); t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
    await assert.rejects(deliverReport({text:reason},{now:new Date("2026-11-13T06:30:00+09:00"),sourceMessages:[{body:"原本"}],deps:{home,
      fetchSendHistory:async()=>({target:"dm",messages:[]}),checkSendContext:(_history,_text,opts)=>{assert.match(opts.periodicReport.sourceEvidence,/原本/);return{ok:false,reason};},
      sendDiscordDm:async()=>assert.fail("NGでは送らない"),
    }}),/履歴照合NG/);
    assert.equal(fs.existsSync(path.join(home,".claude/satou-secretary/delivered-2026-11-13")),false);
  }
});

test("案内DMの応答消失も台帳に記録し、同日の再実行で重ねて送らない", async t=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),"satou-notice-fail-")); t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  const logs=[];let sends=0;
  const options={now:new Date("2026-11-13T06:30:00+09:00"),deps:{home,getSheetsToken:async()=>"test",
    fetchImpl:async(_url,o)=>{logs.push(JSON.parse(o.body).values[0][9]);return Response.json({updates:{}});},
    fetchSendHistory:async()=>({target:"dm",messages:[]}),sendDiscordDm:async()=>{sends++;throw Error("fetch failed");},
  }};
  await notifyDeliveryFailure("本報告NG\n理由",options);
  await notifyDeliveryFailure("本報告NG",options);
  assert.equal(sends,1);assert.equal(logs.length,3);
  assert.equal(logs[0],"DM送信失敗: 本報告NG 理由");assert.match(logs[1],/^案内DMも失敗:/);
});
test("1ソース最後まで失敗しても取れた分で報告を作り、末尾に1行だけ断りを書く", async t => {
  const home=fs.mkdtempSync(path.join(os.tmpdir(),"satou-partial-")); t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  const previousKey=process.env.GOOGLE_SA_KEY;
  process.env.GOOGLE_SA_KEY=path.join(home,"nonexistent-sa.json"); // カレンダートークンをrelayに固定し、実認証を呼ばない
  t.after(()=>{ if(previousKey===undefined) delete process.env.GOOGLE_SA_KEY; else process.env.GOOGLE_SA_KEY=previousKey; });
  const sheetsHeader=["案件名","納品日","営業","予算項目","クライアント名","ｺｰﾄﾞ","制作","売上","実施計画URL","見積書URL","営業スタッフ","案件ルート"];
  const p=await run({now:new Date("2026-11-10T06:30:00+09:00"),dryRun:true,deps:{
    home,
    sleepImpl: async () => {},
    searchGmail:async()=>{throw Error("channel gws: HTTP 500");},
    getSheetsToken:async()=>"t",
    askLlm:async()=>"なし",
    fetchImpl:async url=>{
      url=String(url);
      if(url.includes("calendar.googleapis.com"))return Response.json({items:[]});
      if(url.includes("pasta.tldv.io"))return Response.json({results:[]});
      if(url.includes("fields=sheets.properties"))return Response.json({sheets:[{properties:{title:"案件一覧"}}]});
      return Response.json({values:[sheetsHeader,["案件","2026/12/01","別","確定","B社","B","","100","","","佐藤優奈",""]]});
    },
  }});
  assert.equal(p.status["Gmail"],"error");
  assert.equal(p.status["Gmail60日"],"error");
  assert.equal(p.status["案件一覧"],"ok");
  assert.match(p.report.text,/■昨日の動き/);
  assert.equal(p.report.text.split("（メール取得失敗のため一部未反映）").length-1,1);
  assert.match(p.report.text,/（メール取得失敗のため一部未反映）$/);
});
test("DM送信失敗時は台帳へ理由1行と佐藤さんへの案内DM1通（1日1回）を残す", async t => {
  const home=fs.mkdtempSync(path.join(os.tmpdir(),"satou-notify-")); t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  const previousKey=process.env.GOOGLE_SA_KEY;
  process.env.GOOGLE_SA_KEY=path.join(home,"nonexistent-sa.json"); // 実認証・実Gmailを呼ばない
  t.after(()=>{ if(previousKey===undefined) delete process.env.GOOGLE_SA_KEY; else process.env.GOOGLE_SA_KEY=previousKey; });
  const sheets=[{properties:{title:"シート1",sheetId:1,gridProperties:{columnCount:26}}},
    ...TABS.map((title,i)=>({properties:{title,sheetId:i+10,gridProperties:{columnCount:26}}}))];
  const appends=[],dmTexts=[];
  const deps={
    home,
    searchGmail:async()=>({messages:[]}),
    getSheetsToken:async()=>"t",
    askLlm:async()=>"なし",
    fetchImpl:async(url,o={})=>{
      url=String(url);
      if(o.method==="POST"&&url.includes(":append")){appends.push(JSON.parse(o.body));return Response.json({updates:{updatedRange:"自動_実行ログ!A3:J3"}});}
      if(o.method==="POST")return Response.json({});
      if(url.includes("fields=sheets.properties"))return Response.json({sheets});
      if(decodeURIComponent(url).includes("'シート1'!A:L"))return Response.json({values:[["keep"],["safe"]]});
      return Response.json({values:[["header"],["row"]]});
    },
    fetchSendHistory:async()=>({target:"dm-1",messages:[]}),
    checkSendContext:()=>({ok:false,reason:"重複"}),
    sendDiscordDm:async(_target,text)=>{dmTexts.push(text);return{delivered:true,channelId:"dm-1",messageId:"m-notice"};},
  };
  const now=new Date("2026-11-13T06:30:00+09:00");
  await assert.rejects(()=>run({now,deps}),/履歴照合NG/);
  assert.equal(appends.length,1);
  assert.match(appends[0].values[0][9],/^DM送信失敗: Discord送信前履歴照合NG/);
  assert.deepEqual(dmTexts,[deliveryFailureNoticeText()]);
  assert.match(dmTexts[0],/台帳の『自動_社長報告』タブに本文があります/);
  assert.ok(fs.existsSync(path.join(home,".claude","satou-secretary","notice-2026-11-13")));
  // 同日の再失敗では案内DMを重ねず、失敗理由だけ追記する
  await assert.rejects(()=>run({now,deps}),/履歴照合NG/);
  assert.equal(dmTexts.length,1);
  assert.equal(appends.length,2);
});
test("台帳書き込み失敗でも報告ファイルを残し配信は試みる。配信も失敗したら案内文を切替える", async t => {
  const home=fs.mkdtempSync(path.join(os.tmpdir(),"satou-writefail-")); t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  const previousKey=process.env.GOOGLE_SA_KEY;
  process.env.GOOGLE_SA_KEY=path.join(home,"nonexistent-sa.json"); // 実認証・実Gmailを呼ばない
  t.after(()=>{ if(previousKey===undefined) delete process.env.GOOGLE_SA_KEY; else process.env.GOOGLE_SA_KEY=previousKey; });
  const dmTexts=[];
  const makeDeps=gate=>({
    home,
    searchGmail:async()=>({messages:[]}),
    getSheetsToken:async()=>"t",
    askLlm:async()=>"なし",
    fetchImpl:async(_url,o={})=>{
      // 台帳メタ取得（write の先頭）から落として、write() 自体を失敗させる
      if(o.method==="POST"||String(_url).includes("fields=sheets.properties"))return new Response('{"error":"sheet down"}',{status:500});
      return Response.json({values:[["header"],["row"]]});
    },
    fetchSendHistory:async()=>({target:"dm-1",messages:[]}),
    checkSendContext:gate,
    sendDiscordDm:async(_target,text)=>{dmTexts.push(text);return{delivered:true,channelId:"dm-1",messageId:"m-2"};},
  });
  const now=new Date("2026-11-13T06:30:00+09:00");
  // 台帳が落ちていても配信が成功すれば完了扱い（sendDiscordDm には報告本文だけが1通）
  const ok=await run({now,deps:makeDeps(()=>({ok:true,reason:"整合"}))});
  assert.equal(ok.write.mode,"failed");
  assert.equal(ok.delivery.messageId,"m-2");
  assert.equal(dmTexts.length,1);
  assert.match(dmTexts[0],/^おはようございます。/);
  assert.ok(fs.existsSync(path.join(home,".claude","satou-secretary","report-2026-11-12.md")));
  assert.ok(fs.existsSync(path.join(home,".claude","satou-secretary","delivered-2026-11-13")));
  // 配信も失敗したら、台帳に本文が無い状況向けの案内文に切り替える
  const home2=fs.mkdtempSync(path.join(os.tmpdir(),"satou-writefail2-")); t.after(()=>fs.rmSync(home2,{recursive:true,force:true}));
  const deps2=makeDeps(()=>({ok:false,reason:"重複"})); deps2.home=home2;
  await assert.rejects(()=>run({now,deps:deps2}),/履歴照合NG/);
  assert.equal(dmTexts.length,2);
  assert.match(dmTexts[1],/台帳への本文の保存にも失敗/);
});
test("register は06:30本番と07:30再実行の2タスクを同じ非表示ランチャーで登録する", t => {
  const home=fs.mkdtempSync(path.join(os.tmpdir(),"satou-register-")); t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  const calls=[];
  const out=register({home,spawn:(exe,args)=>{calls.push(args);return{status:0,stdout:"ok",stderr:""};}});
  const creates=calls.filter(a=>a.includes("/create"));
  assert.equal(creates.length,2);
  assert.deepEqual([...new Set(creates.map(a=>a[a.indexOf("/tr")+1]))].sort(),[out.command].sort());
  assert.deepEqual(creates.map(a=>({name:a[a.indexOf("/tn")+1],time:a[a.indexOf("/st")+1]})),[
    {name:TASK_NAME,time:"06:30"},
    {name:TASK_RETRY_NAME,time:"07:30"},
  ]);
  assert.match(out.command,/run-hidden\.vbs/);
  const bat=fs.readFileSync(path.join(home,".claude","tools","satou-secretary-daily-wrapper.bat"),"utf8");
  assert.match(bat,/satou-secretary-daily\.mjs/);
  assert.ok(bat.includes(path.join(home,".claude","satou-secretary","run.log")));
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
  const logWrite=writes.flatMap(x=>x.requests).find(x=>x.updateCells?.range.sheetId===12);
  assert.equal(logWrite.updateCells.rows[1].values[0].userEnteredValue.stringValue,"row");
  assert.equal(logWrite.updateCells.rows[2].values[0].userEnteredValue.stringValue,"now");
});

test("Discordが未送信を確定した失敗では07:30の再試行を許可する",async t=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),"satou-retry-dm-"));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  let attempts=0;
  const deps={home,fetchSendHistory:async()=>({target:"dm",messages:[]}),checkSendContext:()=>({ok:true,reason:"整合"}),sendDiscordDm:async()=>{
    if(++attempts===1)throw Object.assign(Error("DM送信が HTTP 429"),{deliveryUncertain:false});
    return{delivered:true,messageId:"retry-ok",channelId:"dm"};
  }};
  await assert.rejects(deliverReport({text:"本文"},{now:new Date("2026-11-13T06:30:00+09:00"),deps}),/429/);
  const sent=await deliverReport({text:"本文"},{now:new Date("2026-11-13T07:30:00+09:00"),deps});
  assert.equal(sent.messageId,"retry-ok");assert.equal(attempts,2);
});
