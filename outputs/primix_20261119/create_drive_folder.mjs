import { getDriveToken, driveApi } from "../../tools/lib/drive-auth.mjs";

const token = await getDriveToken({ impersonate: "seisaku-team@orgiast.jp" });
const response = await driveApi(token, "https://www.googleapis.com/drive/v3/files?fields=id,name,mimeType,owners(emailAddress)&supportsAllDrives=true", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    name: "プライミクス株式会社様_100周年Party（案件フォルダ未作成）",
    mimeType: "application/vnd.google-apps.folder",
  }),
});
console.log(JSON.stringify(await response.json()));
