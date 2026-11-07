import { getDriveToken, driveApi } from './lib/drive-auth.mjs';
const token = await getDriveToken({});
const id = '1cYNjQH5JhTISKYqWdIMJ4IvvhjDKjZhGQtD8tbwN20g';
const res = await driveApi(token, `https://www.googleapis.com/drive/v3/files/${id}/export?mimeType=text/plain`);
const text = await res.text();
console.error('LEN=' + text.length);
const idx = text.indexOf('§3');
console.log('§3 index=' + idx);
console.log(text.slice(idx >= 0 ? Math.max(0, idx - 500) : text.length - 4000, text.length));
