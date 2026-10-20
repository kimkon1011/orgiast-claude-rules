import { getDriveToken, driveApi } from '../../tools/lib/drive-auth.mjs';
const id = '1vipx1bPMEiLJjNKUqpWVvmtH0Vrz_hm4B4SxPN6ua1A';
const token = await getDriveToken();
const meta = await (await driveApi(token, `https://www.googleapis.com/drive/v3/files/${id}?supportsAllDrives=true&fields=name,owners(emailAddress),modifiedTime`)).json();
const perms = await (await driveApi(token, `https://www.googleapis.com/drive/v3/files/${id}/permissions?supportsAllDrives=true&fields=permissions(type,emailAddress,domain,role)`)).json();
console.log(JSON.stringify({ meta, perms: perms.permissions }, null, 1));
