import { sheetsMetadata, sheetsGet, createSheetsClient } from "../tools/lib/sheets-dwd.mjs";
const SPREADSHEET_ID = "1Qa5bPpvjgpm2lFPfeG08jVMem1FWk1QkbsCHSf5eS4o";
const TAB = "打ち手";
const STATUS_NEW = "送付承認待ち（上位10社・2026-11-22）";
const EVIDENCE_APPEND = "　送付承認Doc https://docs.google.com/document/d/1SjcZuM-5Y9ej1q95GJv7W90g9V12udASgDanQ1f_4JY/edit?authuser=kim@orgiast.jp ／ 営業リストv3 https://docs.google.com/spreadsheets/d/1GdCQxTzxcbMxsKMvSgnf7mvQS8dhN-Km69fMr_AW5yk/edit?authuser=kim@orgiast.jp ／ 見込み【推計】10社×3%×1,100,470円=330,141円（2,000万には634社相当）";

async function main() {
  // 1. Read header
  console.log("=== READING SPREADSHEET ===");
  const meta = await sheetsMetadata(SPREADSHEET_ID);
  const tabs = meta.sheets.map(s => s.properties.title);
  console.log("Tabs:", JSON.stringify(tabs));
  if (!tabs.includes(TAB)) throw new Error("Tab not found: " + TAB);
  const header = await sheetsGet(SPREADSHEET_ID, TAB + "!A1:K1");
  console.log("Header (A1:K1):");
  const cols = "ABCDEFGHIJK";
  if (header.length > 0) { header[0].forEach((h,i) => { if(h!==undefined&&h!==null&&h!=="") console.log("  " + cols[i] + "1: " + String(h)); }); }
  // 2. Read row 5
  console.log("\\n=== ROW 5 (A5:K5) ===");
  const row5 = await sheetsGet(SPREADSHEET_ID, TAB + "!A5:K5");
  if (row5.length > 0) { row5[0].forEach((v,i) => { if(v!==undefined&&v!==null&&v!=="") console.log("  " + cols[i] + "5: " + String(v).slice(0,200)); }); }
  else { console.log("  (empty)"); }
  // 3. Read I5, K5 specifically for update
  const i5 = await sheetsGet(SPREADSHEET_ID, TAB + "!I5");
  const k5 = await sheetsGet(SPREADSHEET_ID, TAB + "!K5");
  const currentStatus = (i5.length > 0 && i5[0][0] !== undefined && i5[0][0] !== null) ? String(i5[0][0]) : "";
  const currentEvidence = (k5.length > 0 && k5[0][0] !== undefined && k5[0][0] !== null) ? String(k5[0][0]) : "";
  console.log("\\n=== BEFORE UPDATE ===");
  console.log("  I5 (status): "" + currentStatus + """);
  console.log("  K5 (evidence): "" + currentEvidence.slice(0,200) + """);
  // 4. Update
  console.log("\\n=== UPDATING ===");
  const client = createSheetsClient();
  console.log("  Setting I5 to: " + STATUS_NEW);
  await client.update(SPREADSHEET_ID, TAB + "!I5", [[STATUS_NEW]]);
  console.log("  I5 updated OK");
  const newEvidence = currentEvidence ? currentEvidence + "\\n" + EVIDENCE_APPEND : EVIDENCE_APPEND;
  console.log("  Setting K5 (append mode)");
  await client.update(SPREADSHEET_ID, TAB + "!K5", [[newEvidence]]);
  console.log("  K5 updated OK");
  // 5. Read back
  console.log("\\n=== READBACK ===");
  const i5after = await sheetsGet(SPREADSHEET_ID, TAB + "!I5");
  const k5after = await sheetsGet(SPREADSHEET_ID, TAB + "!K5");
  const afterStatus = (i5after.length > 0 && i5after[0][0] !== undefined && i5after[0][0] !== null) ? String(i5after[0][0]) : "(empty)";
  const afterEvidence = (k5after.length > 0 && k5after[0][0] !== undefined && k5after[0][0] !== null) ? String(k5after[0][0]) : "(empty)";
  console.log("  I5: "" + afterStatus + """);
  console.log("  K5: "" + afterEvidence + """);
  console.log("\\n=== DONE - Sheet write successful ===");
}
main().catch(e => { console.error("FATAL:", e.message); if(e.cause) console.error("CAUSE:", e.cause.message); process.exit(1); });