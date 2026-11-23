import { getDriveToken } from "./lib/drive-auth.mjs";
import { gwsFetch } from "./lib/gws-proxy.mjs";
import { searchGmail } from "./gmail-search.mjs";

async function main() {
  console.error("=== Step 2: Business card / exhibition greeting search ===");

  // Search 1: Greeting emails WE sent to external parties
  const r1 = await searchGmail({
    user: "seisaku-team@orgiast.jp",
    query: '(ご挨拶 OR ブースにて OR 展示会にて) newer_than:60d from:seisaku-team@orgiast.jp',
    max: 15,
    fetchImpl: gwsFetch,
    getToken: getDriveToken,
  });
  console.error("SENT greeting emails:", (r1.messages || []).length);
  for (const msg of r1.messages || []) {
    const to = msg.to || "";
    const sub = msg.subject || "";
    const date = msg.internalDate ? new Date(Number(msg.internalDate)).toISOString().slice(0, 10) : "";
    const externalRecipients = to.split(",").map(s => s.trim()).filter(s => s.includes("@") && !s.includes("orgiast.jp"));
    if (externalRecipients.length > 0) {
      console.log([date, "SENT", externalRecipients.join(";"), sub.substring(0, 60)].join("|"));
    }
  }

  // Search 2: External emails mentioning exhibition/business card
  const r2 = await searchGmail({
    user: "seisaku-team@orgiast.jp",
    query: '(名刺 OR ブース OR 展示会にて) newer_than:60d -from:seisaku-team@orgiast.jp -from:noreply -from:github',
    max: 20,
    fetchImpl: gwsFetch,
    getToken: getDriveToken,
  });
  console.error("RECEIVED exhibition-related:", (r2.messages || []).length);
  for (const msg of r2.messages || []) {
    const from = msg.from || "";
    const sub = msg.subject || "";
    const snip = msg.snippet || "";
    const date = msg.internalDate ? new Date(Number(msg.internalDate)).toISOString().slice(0, 10) : "";
    const combined = sub + " " + snip;
    if (/名刺|ブース|展示会|初めまして/.test(combined) && from.includes("@") && !from.includes("orgiast.jp") && !/(noreply|github)/.test(from)) {
      console.log([date, "EXT", from.substring(0, 50), sub.substring(0, 60)].join("|"));
    }
  }

  // Search 3: Check for messages we received from exhibition booth visitors
  const r3 = await searchGmail({
    user: "seisaku-team@orgiast.jp",
    query: '(お世話になりました OR ブースにお立ち寄り OR 展示会で) newer_than:60d -from:seisaku-team@orgiast.jp -from:noreply -from:github',
    max: 20,
    fetchImpl: gwsFetch,
    getToken: getDriveToken,
  });
  console.error("External thanks/visit emails:", (r3.messages || []).length);
  for (const msg of r3.messages || []) {
    const from = msg.from || "";
    const sub = msg.subject || "";
    const date = msg.internalDate ? new Date(Number(msg.internalDate)).toISOString().slice(0, 10) : "";
    if (from.includes("@") && !from.includes("orgiast.jp") && !/(noreply|github)/.test(from)) {
      console.log([date, "VISIT", from.substring(0, 50), sub.substring(0, 60)].join("|"));
    }
  }

  console.log("DONE");
}
main().catch(e => { console.error("FATAL:", e.message); process.exitCode = 1; });