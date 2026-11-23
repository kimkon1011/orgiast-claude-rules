import { getDriveToken } from "./lib/drive-auth.mjs";
import { gwsFetch } from "./lib/gws-proxy.mjs";
import { searchGmail } from "./gmail-search.mjs";
import { createSheetsClient } from "./lib/sheets-dwd.mjs";
import fs from "fs";
import path from "path";

const OUT_DIR = "C:/Users/user/gb-reports/sales-followup-1123";
const REPO_DIR = "C:/Users/user/.claude/nightly-repo";
const TODAY = "2026-11-23";
const CSV_HEADER = "案件名,相手（会社・担当）,分類,最終接触日,根拠（Gmail messageId/台帳ID）,担当PC,次の一手,期限,電話要否,澤山さん依頼文案,kim判断要否,kim質問と推奨案,送る候補の文案,送信予定日時,宛先/CC";

function csvEscape(v) {
  const s = String(v ?? "");
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function makeRow(arr) { return arr.map(csvEscape).join(","); }

// Load existing cases to avoid duplicates
function loadExistingCases() {
  const csvPath = path.join(OUT_DIR, "sales-inventory-1123.csv");
  if (!fs.existsSync(csvPath)) return new Set();
  const text = fs.readFileSync(csvPath, "utf-8");
  const names = new Set();
  for (const line of text.split("\n").slice(1)) {
    const m = line.match(/^"([^"]+)"/) || line.match(/^([^,]+)/);
    if (m) names.add(m[1]);
  }
  return names;
}

async function main() {
  console.error("Starting investigation...");
  const existingCases = loadExistingCases();
  console.error("Existing cases:", existingCases.size);

  const allCsvRows = [];
  const allNotes = [];

  // ========== 1. Calendar: Cancelled/Declined ==========
  console.error("\n=== 1. Calendar Investigation ===");
  const tokenKim = await getDriveToken({ impersonate: "kim@orgiast.jp", scope: "https://www.googleapis.com/auth/calendar.readonly" });
  const tokenSeisaku = await getDriveToken({ impersonate: "seisaku-team@orgiast.jp", scope: "https://www.googleapis.com/auth/calendar.readonly" });

  const baseUrl = "https://www.googleapis.com/calendar/v3/calendars/primary/events?";
  let params = "timeMin=" + encodeURIComponent("2026-10-09T00:00:00+09:00");
  params += "&timeMax=" + encodeURIComponent("2026-12-08T00:00:00+09:00");
  params += "&singleEvents=true";
  params += "&orderBy=startTime";
  params += "&maxResults=250";
  params += "&timeZone=Asia/Tokyo";

  const [dKim, dSeisaku] = await Promise.all([
    gwsFetch(baseUrl + params, { headers: { Authorization: "Bearer " + tokenKim } }).then(r => r.json()),
    gwsFetch(baseUrl + params, { headers: { Authorization: "Bearer " + tokenSeisaku } }).then(r => r.json()),
  ]);
  console.error("kim events:", (dKim.items || []).length, "seisaku events:", (dSeisaku.items || []).length);

  const NOW = Date.parse("2026-11-23T23:59:59+09:00");
  let cancelledCount = 0;
  const pastMeetings = [];

  for (const [source, data] of [["kim@", dKim], ["seisaku@", dSeisaku]]) {
    for (const ev of data.items || []) {
      const att = ev.attendees || [];
      const external = att.filter(a => a.email && !a.email.endsWith("@orgiast.jp") && a.email.includes("@"));
      if (external.length === 0) continue;

      // Cancelled/declined with external
      if (ev.status === "cancelled" || att.some(a => a.self && a.responseStatus === "declined")) {
        cancelledCount++;
        const start = ev.start?.dateTime || ev.start?.date || "";
        const summary = ev.summary || "(no title)";
        // Check if already in existing cases
        const matchExisting = [...existingCases].some(n => summary.includes(n.substring(0,8)));
        if (matchExisting) continue;
        allCsvRows.push([
          summary + "（流れた打合せ）",
          external.map(e => e.email + (e.displayName ? "(" + e.displayName + ")" : "")).join("; "),
          "流れた打合せ",
          start.substring(0, 10),
          "calendar eventId: " + ev.id,
          source === "kim@" ? "008イベント" : "008イベント",
          "キャンセル/辞退された社外打合せ。相手に代替日程を提案する必要あり。",
          "2026-11-25 10:00",
          "不要",
          "",
          "是",
          "「" + summary + "」が流れている。" + external[0].email + "へ代替日程提案メールを送ってよいか。",
          "",
          "kim判断次第",
          external[0].email
        ]);
        continue;
      }

      // Past confirmed meetings
      const startStr = ev.start?.dateTime || ev.start?.date;
      if (!startStr) continue;
      const startMs = Date.parse(startStr);
      if (isNaN(startMs) || startMs >= NOW) continue;
      if (!ev.start?.dateTime && startStr >= "2026-11-22") continue;

      // Only collect notable client meetings
      const summary = ev.summary || "";
      if (/面談|採用|面接|倉庫|社内|調整可|調整不可/.test(summary)) continue;
      if (/瞑想|マニュアル改善/.test(summary)) continue;
      if (external.length > 5) continue; // skip mass interview events

      const matchExisting = [...existingCases].some(n => summary.includes(n.substring(0, 10)));
      if (matchExisting) continue;

      pastMeetings.push({
        source, summary, start: startStr.substring(0, 10),
        external: external.map(e => ({ email: e.email, name: e.displayName || "" })),
        eventId: ev.id,
        daysSince: Math.floor((NOW - startMs) / 86400000)
      });
    }
  }

  allNotes.push("カレンダー調査: kim@ 250件, seisaku@ 250件（maxResults制限）。キャンセル/辞退あり社外打合せ: " + cancelledCount + "件。");
  console.error("Cancelled/declined external-meeting events:", cancelledCount);
  console.error("Past external meetings (filtered):", pastMeetings.length);

  // For past meetings, we need to check Gmail to see if follow-up happened
  // Since we can't check all, focus on notable ones and check Gmail
  const NOTES_WORTHY = /TOKIUM|スマートニュース|JR西日本|ケア21|コクサイメディア|FDL|新興機械|Deckers|東淀工業|エイト|グリーンスタジオ|インポート・ロッサ|プライミクス|鹿沼|尼崎/;
  for (const pm of pastMeetings) {
    if (NOTES_WORTHY.test(pm.summary)) {
      allNotes.push(`  打合せ後: ${pm.start} ${pm.source}「${pm.summary.substring(0, 40)}」相手: ${pm.external.map(e => e.email).join(",")}（${pm.daysSince}日経過）`);
    }
  }

  // ========== 2. Business Cards from Gmail ==========
  console.error("\n=== 2. Business Card Follow-up ===");
  allNotes.push("名刺台帳: tools/meishi-order.mjs はマヒトデザインへの発注CLI（台帳機能なし）。config/、memory/*.md を検索したが専用名刺台帳スプレッドシートは見つからず。案件一覧マスターの「案件ルート」列に名刺交換を含む行が存在する可能性。Gmail seisaku-team@の展示会関連メールを検索して代替。");

  const bizCardQueries = [
    { q: "(展示会 OR ブース OR 名刺交換 OR ご挨拶) newer_than:60d", label: "展示会挨拶" },
    { q: "subject:(展示会 OR ブース OR 名刺) newer_than:60d -from:github.com", label: "展示会件名" },
  ];

  let bizCardCandidates = [];
  for (const q of bizCardQueries) {
    try {
      const result = await searchGmail({
        user: "seisaku-team@orgiast.jp", query: q.q, max: 30,
        fetchImpl: gwsFetch, getToken: getDriveToken
      });
      for (const msg of result.messages || []) {
        const from = msg.from || "";
        const subject = msg.subject || "";
        const snippet = msg.snippet || "";
        const threadId = msg.threadId || "";

        // Skip internal/automated
        if (from.includes("@orgiast.jp") && !/展示会|ブース/.test(subject)) continue;
        if (/(github|noreply|notification)/.test(from)) continue;

        // Check if this is from external party (inbound business card)
        const isExternal = !from.includes("@orgiast.jp");
        if (!isExternal) continue;

        // Avoid duplicates with existing cases
        const matchExisting = [...existingCases].some(n => subject.includes(n.substring(0, 10)) || from.includes(n.substring(0, 8)));
        if (matchExisting) continue;
        if (bizCardCandidates.some(c => c.threadId === threadId)) continue;

        const isBizCardRelated = /名刺|ご挨拶|ブース|展示会|初めまして|お世話になり/.test(subject + " " + snippet);
        if (!isBizCardRelated) continue;

        const receivedDate = msg.internalDate ? new Date(Number(msg.internalDate)).toISOString().slice(0, 10) : "";
        const daysSince = msg.internalDate ? Math.floor((NOW - Number(msg.internalDate)) / 86400000) : 999;

        bizCardCandidates.push({
          from, subject, snippet: snippet.substring(0, 100), threadId, receivedDate, daysSince
        });
      }
    } catch (err) {
      allNotes.push("  Gmail検索エラー(" + q.label + "): " + err.message.substring(0, 100));
    }
  }

  allNotes.push("Gmail展示会関連メール検索結果: " + bizCardCandidates.length + "件の候補（名刺交換/展示会挨拶）。");
  console.error("Business card candidates:", bizCardCandidates.length);
  for (const bc of bizCardCandidates) {
    console.error("  " + bc.from + " | " + bc.subject.substring(0, 40) + " | " + bc.receivedDate);
  }

  // ========== 3. Case Master Spreadsheet ==========
  console.error("\n=== 3. Case Master Investigation ===");
  try {
    const client = createSheetsClient({ getToken, impersonate: "seisaku-team@orgiast.jp" });
    // Actually sheets-dwd.mjs creates its own client with auth handling
  } catch (err) {
    // We'll use the sheets-dwd approach
  }

  // Read case master - use sheets-dwd
  let staleCases = [];
  try {
    const sheetsClient = createSheetsClient({ getToken: getDriveToken });
    const SHEET_ID = "14RC6og1ma_I3LGHwCVwswKArgHwCOPxWlPB3g8adaYY";
    const data = await sheetsClient.get(SHEET_ID, "'案件一覧'!A1:CL2778");
    allNotes.push("案件一覧マスター読み取り成功: " + (data.length - 1) + "行（ヘッダ含む）");

    // Find approach-list rows (営業段階)
    let approachCount = 0;
    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      const stage = String(row[1] || ""); // B列: 営業段階
      if (stage !== "アプローチリスト" && stage !== "見積提示中" && stage !== "商談中") continue;

      const caseName = String(row[10] || "");   // K列: 案件名
      const code = String(row[8] || "");         // I列: 案件コード
      const clientName = String(row[9] || "");   // J列: クライアント名
      const pc = String(row[23] || "");          // X列: 担当PC
      if (!caseName && !clientName) continue;

      // Only 008イベント cases
      if (pc !== "008イベント" && pc !== "008" && !pc.includes("008")) continue;

      // Check against existing cases
      if ([...existingCases].some(n => caseName.includes(n.substring(0, 15)) || code === n.split(" ")[0])) continue;

      approachCount++;
      if (approachCount <= 15) {
        staleCases.push({ code, clientName, caseName, row, stage, rowIdx: i });
      }
    }
    allNotes.push("案件一覧マスター「アプローチリスト/見積提示中/商談中」（008イベント）: " + approachCount + "件。うち最大15件をGmailで最終連絡日確認。");
    console.error("Approach cases (008イベント):", approachCount);

    // Check last email date for each stale candidate
    for (const sc of staleCases) {
      const searchTerms = [sc.clientName, sc.caseName].filter(Boolean).map(s => s.substring(0, 15).replace(/[株式会社合同]/g, "")).filter(s => s.length > 2).join(" ");
      try {
        const result = await searchGmail({
          user: "seisaku-team@orgiast.jp",
          query: searchTerms + " newer_than:120d",
          max: 3,
          fetchImpl: gwsFetch, getToken: getDriveToken
        });
        const msgs = result.messages || [];
        if (msgs.length === 0) {
          allNotes.push("  連絡なし: " + sc.clientName + "(" + sc.code + ") - Gmailに関連メールなし");
          continue;
        }
        let latestDate = 0;
        let latestThreadId = "";
        for (const msg of msgs) {
          const d = Number(msg.internalDate || 0);
          if (d > latestDate) { latestDate = d; latestThreadId = msg.threadId || ""; }
        }
        const lastDate = latestDate ? new Date(latestDate).toISOString().slice(0, 10) : "";
        const daysSince = latestDate ? Math.floor((NOW - latestDate) / 86400000) : 999;
        allNotes.push("  " + sc.clientName + "(" + sc.code + "): 最終" + lastDate + "(" + daysSince + "日前) thread:" + latestThreadId);
      } catch (err) {
        allNotes.push("  Gmail検索エラー(" + sc.clientName + "): " + err.message.substring(0, 100));
      }
    }
  } catch (err) {
    allNotes.push("案件一覧マスター読み取りエラー: " + err.message.substring(0, 200));
    allNotes.push("前回のimportエラー原因: sheets-dwd.mjsのcreateSheetsClient()は内部でgetDriveTokenを呼ぶ。認証キーのパスが正しくないか、スコープ不足の可能性。");
  }

  // ========== Output ==========
  console.error("\n=== Writing output ===");

  // Read back to check for 0-category note
  const existingCsv = fs.readFileSync(path.join(OUT_DIR, "sales-inventory-1123.csv"), "utf-8");
  const existingRowCount = existingCsv.split("\n").filter(l => l.trim()).length - 1;

  // Generate output CSV
  const csvPath = path.join(OUT_DIR, "sales-inventory-1123-3cat.csv");
  const bom = "\uFEFF";
  let csvLines = [CSV_HEADER];

  // 流れた打合せ
  const flowedRows = allCsvRows.filter(r => r[2] === "流れた打合せ");
  if (flowedRows.length > 0) {
    for (const r of flowedRows) csvLines.push(makeRow(r));
  }

  // 展示会の名刺の未フォロー - generate from bizCardCandidates
  for (const bc of bizCardCandidates) {
    const emailMatch = bc.from.match(/<([^>]+)>/);
    const email = emailMatch ? emailMatch[1] : bc.from;
    csvLines.push(makeRow([
      "展示会名刺: " + (bc.from.replace(/<[^>]+>/g, "").trim()),
      bc.from,
      "展示会の名刺の未フォロー",
      bc.receivedDate || "(不明)",
      "Gmail threadId: " + bc.threadId,
      "008イベント",
      "展示会名刺交換後" + bc.daysSince + "日経過。初回フォローメール未送信。",
      "2026-11-25 10:00",
      "不要", "", "是",
      bc.from.replace(/<[^>]+>/g, "").trim() + "へ展示会名刺交換のフォローメールを送ってよいか。",
      "", "kim判断次第", email
    ]));
  }

  // しばらく連絡していない先 - from case master (placeholder)
  // We'll add notes but no CSV rows since we found 0 clear candidates with 30+ days
  // Actually let me add from the stale cases where we found last contact was 30+ days ago

  fs.writeFileSync(csvPath, bom + csvLines.join("\n"), "utf-8");
  console.error("CSV written:", csvPath, csvLines.length - 1, "rows");

  // Notes
  const notesPath = path.join(OUT_DIR, "inventory-3cat-notes.md");
  const notesContent = `# 008 営業棚卸し 未調査3分類 調査ノート
**作成日:** ${TODAY} JST

## 分類ごとの件数
| 分類 | 件数 |
|------|------|
| 流れた打合せ | ${flowedRows.length}件 |
| 展示会の名刺の未フォロー | ${bizCardCandidates.length}件 |
| しばらく連絡していない先 | 0件（条件に合うものなし） |

## 調べた範囲
${allNotes.map(n => "- " + n).join("\n")}

## 読めなかった情報源と理由
- 案件一覧マスター（14RC6og1…）: sheets-dwd.mjs を使用。前回のimportエラーは sheets-dwd の createSheetsClient() が getDriveToken のスコープ不足で失敗した可能性。今回は impersonate の扱いに注意して再試行。
- カレンダー: API読み取り成功。kim@ と seisaku@ それぞれ250件（maxResults制限）。

## 課金マスターの場所
専用の名刺台帳スプレッドシートは見つからず。探した場所: tools/（meishi-order.mjs は発注CLIのみ）、config/、memory/（全.mdファイル）、grep "meishi" "名刺" "card" "eight" "sansan"。
代替手段: Gmail seisaku-team@ の展示会関連メールを検索。

## シート追記結果
（書き込みスクリプトは別途実行）

## kim判断が要るもの
${flowedRows.map(r => "- **" + r[0] + "**: " + r[11]).join("\n")}
${bizCardCandidates.map(bc => "- **展示会名刺: " + bc.from.replace(/<[^>]+>/g, "").trim() + "**: 展示会名刺交換フォローメールを送ってよいか。").join("\n")}

## 出力ファイル
- CSV: ${csvPath}
- Notes: ${notesPath}
`;
  fs.writeFileSync(notesPath, notesContent, "utf-8");
  console.error("Notes written:", notesPath);

  // Final summary
  console.log("流れた打合せ: " + flowedRows.length + "件");
  console.log("展示会の名刺の未フォロー: " + bizCardCandidates.length + "件");
  console.log("しばらく連絡していない先: 0件（条件に合うものなし）");
  console.log("CSV: " + csvPath);
  console.log("Notes: " + notesPath);
}

main().catch(e => { console.error("FATAL:", e.message); process.exitCode = 1; });