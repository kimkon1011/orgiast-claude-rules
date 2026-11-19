import fs from "node:fs/promises";
import { SpreadsheetFile, Workbook } from "@oai/artifact-tool";

const outDir = "C:/Users/user/.claude/nightly-repo/outputs/primix_20261119";
const outFile = `${outDir}/見積案（社内）_プライミクス株式会社様_100周年Party_20261119.xlsx`;
const wb = Workbook.create();

const sources = {
  ozie: "御見積書 (241108OZIE_株式会社柳田織物様 _100周年記念パーティー) / Drive ID: 1gFcImXUBuyzrLX5dNNj6M5Nyr_hyVZmW5Ta1cJsi5PI",
  hhd: "御見積書 (200331HHD_株式会社平山ホールディングス 様 _グループ会社会合後の懇親会の司会運営と動画撮影) / Drive ID: 1kJJUXLtaZYX3F26E7DT5RbmkNBmDP3cYvZ2_YcW_gag",
  staffing: "制作物価格表テンプレート - 新）社内イベント / Drive ID: 18Z6KHgEKNq1Okqx-fvoFmTgMVIBcmmMajhExk7csBWI",
};

const standard = [
  ["進行", "司会（プロMC）", "事前打合せ・当日リハーサルを含む（8時間以内）", 1, "名", 110000, sources.ozie, ""],
  ["制作", "構成・台本", "全体構成、ありがとうコメント紹介、ゲーム進行台本", 1, "式", 99000, `${sources.ozie}（企画作成66,000円＋運営台本33,000円）`, ""],
  ["企画", "全員参加ゲーム企画・制作", "テーブル対抗100年クイズ。問題作成、回答札・用紙20卓分、集計設計", 1, "式", 55000, `${sources.ozie}（社内〇×クイズ大会 企画費55,000円）`, ""],
  ["制作", "進行スライド", "タイトル、進行、クイズ問題・正答。映像制作ではない", 1, "式", 55000, `${sources.ozie}（進行スライド作成55,000円）`, ""],
  ["進行", "進行ディレクター", "当日進行、ホテル・司会・運営スタッフ連携", 1, "名", 110000, sources.staffing, ""],
  ["運営", "運営スタッフ", "回答回収・集計、誘導、コメント紹介補助", 2, "名", 33000, sources.staffing, ""],
  ["備品", "基本イベントセット", "白手袋・賞状盆・文具類・救急箱等。進行D計上時の必須セット", 1, "式", 55000, sources.staffing, ""],
  ["備品", "トランシーバー", "進行D・司会付・運営2名向け（予備含む）", 4, "機", 2200, `${sources.ozie}（2,200円/機）`, ""],
  ["準備", "事前打合せ・下見", "オンライン打合せ＋ホテル下見・会場調整", 1, "式", 55000, `${sources.ozie}（会場ディレクション費55,000円）`, ""],
  ["実費", "交通費（神戸）", "MC・進行D・スタッフ2名および下見の概算。出発地確定後に精算", 1, "式", 20000, "実額根拠を確認できず（ルール上は実費別途）", "仮：出発地・移動人数・下見回数が未確定のため"],
];

const minimum = [
  ["進行", "司会（プロMC）", "事前オンライン打合せ・当日リハーサルを含む（8時間以内）", 1, "名", 110000, sources.ozie, ""],
  ["制作", "進行台本", "全体進行とありがとうコメント紹介を中心とした簡易台本", 1, "式", 33000, `${sources.ozie}（運営台本作成33,000円）`, ""],
  ["企画", "全員参加ゲーム企画・制作（縮小）", "100年クイズの問題・回答用紙のみ。問題数と装飾を抑え、簡易進行素材を含む", 1, "式", 55000, `${sources.ozie}（社内〇×クイズ大会 企画費55,000円）`, ""],
  ["進行", "進行ディレクター", "当日進行、ホテル・司会・運営スタッフ連携", 1, "名", 110000, sources.staffing, ""],
  ["運営", "運営スタッフ", "回答回収・集計と誘導を兼務", 1, "名", 33000, sources.staffing, ""],
  ["備品", "基本イベントセット", "白手袋・賞状盆・文具類・救急箱等。進行D計上時の必須セット", 1, "式", 55000, sources.staffing, ""],
  ["備品", "トランシーバー", "進行D・司会付・運営1名向け", 3, "機", 2200, `${sources.ozie}（2,200円/機）`, ""],
  ["準備", "事前オンライン打合せ", "下見を行わず、オンライン1回を基本とする", 1, "式", 10000, `${sources.hhd}（企画提案A 10,000円）`, ""],
  ["実費", "交通費（神戸）", "MC・進行D・スタッフ1名の概算。出発地確定後に精算", 1, "式", 15000, "実額根拠を確認できず（ルール上は実費別途）", "仮：出発地・移動人数が未確定のため"],
];

function styleSheet(sheet, rows, title, subtitle) {
  sheet.showGridLines = false;
  sheet.getRange("A2:H2").merge();
  sheet.getRange("A2").values = [[title]];
  sheet.getRange("A3:H3").merge();
  sheet.getRange("A3").values = [[subtitle]];
  sheet.getRange("A5:H5").values = [["区分", "項目", "内容", "数量", "単位", "単価（税抜）", "金額（税抜）", "根拠・仮置き理由"]];
  const data = rows.map(r => [r[0], r[1], r[2], r[3], r[4], r[5], r[3] * r[5], r[7] ? `${r[6]} / ${r[7]}` : r[6]]);
  sheet.getRangeByIndexes(5, 0, data.length, 8).values = data;
  const start = 6, end = 5 + data.length;
  const t = end + 2;
  sheet.getRange(`F${t}:G${t + 4}`).values = [
    ["明細小計", null],
    ["管理費（20%）", null],
    ["税抜合計", null],
    ["消費税10%（税抜合計に対し切り捨て）", null],
    ["税込合計", null],
  ];
  sheet.getRange(`G${t}`).formulas = [[`=SUM(G${start}:G${end})`]];
  sheet.getRange(`G${t + 1}`).formulas = [[`=G${t}*20%`]];
  sheet.getRange(`G${t + 2}`).formulas = [[`=SUM(G${t}:G${t + 1})`]];
  sheet.getRange(`G${t + 3}`).formulas = [[`=ROUNDDOWN(G${t + 2}*10%,0)`]];
  sheet.getRange(`G${t + 4}`).formulas = [[`=SUM(G${t + 2}:G${t + 3})`]];
  sheet.getRange(`A${t}:D${t}`).merge();
  sheet.getRange(`A${t}`).values = [["社内用収支メモ"]];
  sheet.getRange(`A${t + 1}:D${t + 4}`).values = [
    ["確認済み原価", title.includes("標準") ? 212900 : 174100, "未確認原価", "MC・準備・交通費等を含むため利益確定不可"],
    ["マスタ準拠", "進行D・運営スタッフ・基本イベントセット・管理費", "マスタ外/過去実額", "構成・台本・ゲーム・スライド・打合せ・無線"],
    ["社長判断", "交通費の確定、マスタ外項目の最終価格", "予算", "両案とも税込100万円以内"],
    ["状態", "社内案・未送信", "作成日", "2026-11-19"],
  ];
  sheet.getRange("A2:H2").format = { font: { name: "Arial", size: 14, bold: true, color: "#202124" } };
  sheet.getRange("A3:H3").format = { font: { name: "Arial", size: 10, italic: true, color: "#5F6368" } };
  sheet.getRange("A5:H5").format = { fill: "#E8EAED", font: { name: "Arial", size: 10, bold: true, color: "#202124" }, horizontalAlignment: "center", verticalAlignment: "center", wrapText: true, borders: { preset: "outside", color: "#BDC1C6" } };
  sheet.getRange(`A${start}:H${end}`).format = { font: { name: "Arial", size: 10, color: "#202124" }, verticalAlignment: "top", wrapText: true, borders: { bottom: { style: "thin", color: "#DADCE0" } } };
  sheet.getRange(`D${start}:D${end}`).format.horizontalAlignment = "center";
  sheet.getRange(`E${start}:E${end}`).format.horizontalAlignment = "center";
  sheet.getRange(`F${start}:G${t + 4}`).format.numberFormat = "#,##0\"円\"";
  sheet.getRange(`F${t}:G${t + 4}`).format = { font: { name: "Arial", size: 10, bold: true }, fill: "#F8F9FA", borders: { preset: "outside", color: "#BDC1C6" } };
  sheet.getRange(`F${t + 4}:G${t + 4}`).format = { font: { name: "Arial", size: 11, bold: true }, fill: "#E6F4EA", borders: { preset: "doubleBottom", color: "#5F6368" } };
  sheet.getRange(`A${t}:D${t}`).format = { fill: "#F1F3F4", font: { name: "Arial", size: 10, bold: true } };
  sheet.getRange(`A${t + 1}:D${t + 4}`).format = { font: { name: "Arial", size: 9 }, wrapText: true, verticalAlignment: "top" };
  sheet.getRange("A:H").format.font = { name: "Arial", size: 10 };
  sheet.getRange("A:A").format.columnWidthPx = 72;
  sheet.getRange("B:B").format.columnWidthPx = 175;
  sheet.getRange("C:C").format.columnWidthPx = 280;
  sheet.getRange("D:E").format.columnWidthPx = 54;
  sheet.getRange("F:G").format.columnWidthPx = 112;
  sheet.getRange("H:H").format.columnWidthPx = 430;
  sheet.getRange(`A${start}:H${end}`).format.autofitRows();
  sheet.freezePanes.freezeRows(5);
  sheet.tabColor = title.includes("標準") ? "#1A73E8" : "#5F6368";
}

const s1 = wb.worksheets.add("標準案");
styleSheet(s1, standard, "見積案（社内） 標準案", "プライミクス株式会社様 100周年Party / 2027年4月17日（土）16:30〜19:00 / ANAクラウンプラザホテル神戸 / 約200名");
const s2 = wb.worksheets.add("最小案");
styleSheet(s2, minimum, "見積案（社内） 最小案", "司会・進行D・基本イベントセットは維持し、運営人数・ゲーム制作範囲・事前準備を縮小");

const n = wb.worksheets.add("前提・確認事項");
n.showGridLines = false;
n.getRange("A2:D2").merge(); n.getRange("A2").values = [["前提・確認事項"]];
n.getRange("A4:D4").values = [["分類", "確認事項・前提", "現状", "対応"]];
const notes = [
  ["基本前提", "開催日時・会場・人数", "2027/4/17（土）16:30〜19:00、ANAクラウンプラザホテル神戸、社員約200名、10名掛け約20卓は仮定", "人数・卓数を確定"],
  ["基本前提", "予算100万円以内の税区分", "税込／税抜が未確認。両案とも税込100万円以内", "お客様に確認"],
  ["ホテル", "音響・照明・映像設備", "ホテルのマイク、照明、プロジェクター、スクリーンを利用する前提。費用未計上", "設備仕様・料金・操作担当を確認"],
  ["ホテル", "搬入・リハーサル", "搬入可能時間、保管、外部スタッフ入館、リハーサル時間が未確認", "ホテルに確認"],
  ["お客様", "ありがとうコメント", "事前収集はお客様側、当社は選定補助・台本反映・当日紹介を想定", "件数・文字数・匿名可否・提出期限を確認"],
  ["お客様", "100年クイズ", "紙の回答札・回答用紙で運用し、専用システムは使わない", "社史素材・監修者・問題数を確認"],
  ["照合", "表彰式", "午後の経営方針発表会で検討中。Party見積には含めない", "変更時は再見積"],
  ["照合", "特別映像制作", "不要とのメール回答に合わせ、両案とも含めない", "変更時は別途見積"],
  ["標準案", "含むもの", "プロMC、構成・台本、紙クイズ企画制作、進行スライド、進行D、運営2名、基本セット、無線4機、下見、交通費概算", ""],
  ["最小案", "標準案から削ったもの", "独立した進行スライド制作、ホテル下見、運営スタッフ1名、無線1機、ゲームの装飾・問題数・制作範囲", "簡易進行素材はゲーム制作に統合"],
  ["仮置き", "交通費", "標準20,000円、最小15,000円。出発地・人数・下見回数が未確定", "確定後に実費へ差替え"],
  ["社内", "判断事項", "交通費の確定、マスタ外・過去実額項目の最終価格、標準案と最小案の選択", "kim判断"],
  ["送信状態", "社外送信", "未送信。メール・下書きは変更していない", "11/24打合せ資料として使用する案を選択"],
];
n.getRangeByIndexes(4,0,notes.length,4).values = notes;
n.getRange("A2:D2").format = { font: { name: "Arial", size: 14, bold: true } };
n.getRange("A4:D4").format = { fill: "#E8EAED", font: { name: "Arial", size: 10, bold: true }, horizontalAlignment: "center", wrapText: true };
n.getRange(`A5:D${4+notes.length}`).format = { font: { name: "Arial", size: 10 }, wrapText: true, verticalAlignment: "top", borders: { bottom: { style: "thin", color: "#DADCE0" } } };
n.getRange("A:A").format.columnWidthPx = 90; n.getRange("B:B").format.columnWidthPx = 200; n.getRange("C:C").format.columnWidthPx = 420; n.getRange("D:D").format.columnWidthPx = 220;
n.getRange(`A5:D${4+notes.length}`).format.autofitRows(); n.freezePanes.freezeRows(4); n.tabColor = "#9AA0A6";

wb.recalculate();
const check1 = await wb.inspect({ kind: "table", range: "標準案!A1:H22", include: "values,formulas", tableMaxRows: 25, tableMaxCols: 8 });
const check2 = await wb.inspect({ kind: "table", range: "最小案!A1:H21", include: "values,formulas", tableMaxRows: 25, tableMaxCols: 8 });
const errors = await wb.inspect({ kind: "match", searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A|#NUM!|#NULL!|#SPILL!|#CALC!", options: { useRegex: true, maxResults: 100 }, summary: "final formula error scan" });
console.log(check1.ndjson); console.log(check2.ndjson); console.log(errors.ndjson);
for (const [sheetName, range, file] of [["標準案","A1:H22","standard.png"],["最小案","A1:H21","minimum.png"],["前提・確認事項",`A1:D${4+notes.length}`,"notes.png"]]) {
  const blob = await wb.render({ sheetName, range, scale: 1 });
  await fs.writeFile(`${outDir}/${file}`, new Uint8Array(await blob.arrayBuffer()));
}
await fs.mkdir(outDir, { recursive: true });
const xlsx = await SpreadsheetFile.exportXlsx(wb);
await xlsx.save(outFile);
console.log(JSON.stringify({ outFile }));
