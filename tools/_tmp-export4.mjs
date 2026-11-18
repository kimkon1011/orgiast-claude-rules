import { getDriveToken, driveApi } from 'file:///C:/Users/user/.claude/nightly-repo/tools/lib/drive-auth.mjs';
import { writeFileSync } from 'node:fs';
const id='1skM83a1N4fVIDY6YXnjpSOLRBI4F7ewRqkbITAaHGL8';
const t=await getDriveToken();
const u=`https://docs.google.com/spreadsheets/d/${id}/export?format=pdf&gid=470920608&range=A1:N52&portrait=true&size=A4&fitw=true&gridlines=false&printtitle=false&sheetnames=false&pagenumbers=false`;
const r=await driveApi(t,u);
const b=Buffer.from(await r.arrayBuffer());
writeFileSync('C:/Users/user/AppData/Local/Temp/claude/ec29f026d20d029c/99c9f5a4-e5c2-4eef-899e-f2775d395313/scratchpad/御見積書_270301FDL_AR_20261118.pdf',b);
console.log('bytes',b.length);
