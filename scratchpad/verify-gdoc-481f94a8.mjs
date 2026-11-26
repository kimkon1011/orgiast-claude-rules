import { getDriveToken, driveApi } from '../tools/lib/drive-auth.mjs';

const title = '社外下書き3通と乳癌学会請求書の支払い準備（2026-11-26）';
const token = await getDriveToken({ impersonate: 'kim@orgiast.jp' });
const q = encodeURIComponent(`name = '${title.replaceAll("'", "\\'")}' and trashed = false`);
const found = await (await driveApi(token, `https://www.googleapis.com/drive/v3/files?q=${q}&orderBy=createdTime desc&fields=files(id,name,createdTime,owners(emailAddress))&supportsAllDrives=true`)).json();
if (!found.files?.length) throw new Error('作成済み Doc が見つかりません');
const file = found.files[0];
const permissions = await (await driveApi(token, `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}/permissions?fields=permissions(id,type,emailAddress,domain,role,permissionDetails(inherited,inheritedFrom))&supportsAllDrives=true`)).json();
const active = permissions.permissions ?? [];
const kim = active.find(p => p.type === 'user' && p.emailAddress?.toLowerCase() === 'kim@orgiast.jp');
if (!kim || !['owner', 'writer', 'organizer', 'fileOrganizer'].includes(kim.role)) throw new Error('kim@orgiast.jp の編集権限がありません');
const forbidden = active.filter(p => p.type === 'anyone' || (p.type === 'domain' && p.domain !== 'orgiast.jp') || (p.emailAddress && !p.emailAddress.toLowerCase().endsWith('@orgiast.jp')));
if (forbidden.length) throw new Error(`社外権限あり: ${forbidden.map(p => `${p.type}:${p.domain ?? p.emailAddress ?? ''}:${p.role}`).join(',')}`);
console.log(`権限一覧: ${active.map(p => `${p.type}:${p.emailAddress ?? p.domain ?? ''}:${p.role}`).join(', ')}`);
console.log(`https://docs.google.com/a/orgiast.jp/document/d/${file.id}/edit?authuser=kim@orgiast.jp`);
console.log(`kim@orgiast.jp の権限ロール: ${kim.role}`);
