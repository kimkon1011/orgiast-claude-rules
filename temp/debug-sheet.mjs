import { getDriveToken } from "../tools/lib/drive-auth.mjs";
try {
  const token = await getDriveToken({ scope: "https://www.googleapis.com/auth/spreadsheets", impersonate: "kim@orgiast.jp" });
  console.log("TOKEN_LEN:" + token.length);
  console.log("TOKEN_PREFIX:" + token.slice(0,30));
  const res = await fetch("https://sheets.googleapis.com/v4/spreadsheets/1Qa5bPpvjgpm2lFPfeG08jVMem1FWk1QkbsCHSf5eS4o?fields=spreadsheetId,spreadsheetUrl", { headers: { Authorization: "Bearer " + token } });
  console.log("STATUS:" + res.status);
  const txt = await res.text();
  console.log("BODY:" + txt.slice(0,500));
} catch(e) {
  console.log("ERR:" + e.message);
  if(e.cause) console.log("CAUSE:" + e.cause.message);
  process.exit(1);
}