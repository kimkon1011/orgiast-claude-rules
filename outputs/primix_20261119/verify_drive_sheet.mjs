import { getDriveToken, driveApi } from "../../tools/lib/drive-auth.mjs";

const fileId = "1bvdoxERt6ExrT0KCcjryMvPS8rI6K8fP0x4-aOU1_JY";
const token = await getDriveToken({ impersonate: "seisaku-team@orgiast.jp" });
const meta = await (await driveApi(token, `https://www.googleapis.com/drive/v3/files/${fileId}?fields=id,name,mimeType,parents,owners(emailAddress),permissions(id,type,role,emailAddress,displayName)&supportsAllDrives=true`)).json();
const ranges = ["'標準案'!G19:G21", "'最小案'!G18:G20"];
const qs = new URLSearchParams();
for (const range of ranges) qs.append("ranges", range);
qs.set("valueRenderOption", "UNFORMATTED_VALUE");
const values = await (await driveApi(token, `https://sheets.googleapis.com/v4/spreadsheets/${fileId}/values:batchGet?${qs}`)).json();
console.log(JSON.stringify({ meta, values }, null, 2));
