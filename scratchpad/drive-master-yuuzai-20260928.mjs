// 【マスター】保有機材リストの本文を取得（読み取り専用）
import { getDriveToken, driveApi } from '../tools/lib/drive-auth.mjs';

const token = await getDriveToken();
const id = '1GPaySeZy7wyMIIHLQ3cY2yyJv44PwKClgcMSIJGm2go';
const res = await driveApi(token, `https://www.googleapis.com/drive/v3/files/${id}/export?mimeType=text/plain`);
const text = await res.text();
console.log(text);
