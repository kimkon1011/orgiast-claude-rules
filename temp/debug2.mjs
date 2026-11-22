import { getDriveToken } from "../tools/lib/drive-auth.mjs";
import { existsSync } from "node:fs";
try {
  console.log("ENV_GOOGLE_SA_KEY:" + (process.env.GOOGLE_SA_KEY || "NOT_SET"));
  console.log("KEY_EXISTS:" + existsSync(process.env.GOOGLE_SA_KEY || ""));
  console.log("DEFAULT_KEY_PATH:" + require("path").join(require("os").homedir(),"Downloads","aujust-sales-automation-cb4734ceefba.json"));
  console.log("THAT_EXISTS:" + existsSync(require("path").join(require("os").homedir(),"Downloads","aujust-sales-automation-cb4734ceefba.json")));
  const token = await getDriveToken({ scope: "https://www.googleapis.com/auth/spreadsheets", impersonate: "kim@orgiast.jp" });
  console.log("TOKEN_OK:" + token.slice(0,20));
} catch(e) {
  console.log("ERR:" + e.message);
  if(e.cause) console.log("CAUSE:" + e.cause.message);
}