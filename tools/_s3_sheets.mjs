import { createSheetsClient } from "./lib/sheets-dwd.mjs";

async function main() {
  console.error("Reading case master spreadsheet...");
  try {
    const client = createSheetsClient();
    const data = await client.get("14RC6og1ma_I3LGHwCVwswKArgHwCOPxWlPB3g8adaYY", "'案件一覧'!A1:X200");
    console.error("Total rows:", data.length);
    if (data.length > 0) {
      console.error("Headers:", data[0].join("|"));
    }
    let count = 0;
    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      const stage = String(row[1] || "");
      if (stage === "アプローチリスト" || stage === "見積提示中" || stage === "商談中") {
        const name = String(row[10] || "");
        const code = String(row[8] || "");
        const clientName = String(row[9] || "");
        const pc = String(row[23] || "");
        if (pc.includes("008") || pc.includes("イベント")) {
          console.log([code, clientName, name.substring(0,30), stage, pc].join("|"));
          count++;
        }
      }
    }
    console.error("Total 008 approach cases:", count);
    console.log("DONE|" + count);
  } catch (e) {
    console.error("SHEETS ERROR:", e.message);
    console.log("ERROR|" + e.message.substring(0, 200));
  }
}
main().catch(e => { console.error("FATAL:", e.message); process.exitCode = 1; });