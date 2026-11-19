#!/usr/bin/env node
/**
 * Google Doc の権限確認・writer共有付与・本文取得
 * 認証リレー（proxy → seisaku-team@orgiast.jp）を使用。
 * owner なので permissions は file resource の fields 経由で読む。
 *
 * 使い方: node tools/get-doc-permissions.mjs <fileId>
 */
import { getDriveToken, driveApi } from './lib/drive-auth.mjs';

const FILE_ID = process.argv[2];
if (!FILE_ID) { console.error('Usage: node tools/get-doc-permissions.mjs <fileId>'); process.exit(1); }

async function main() {
  const token = await getDriveToken();

  // (1) 権限一覧取得（file resource の fields=permissions 経由）
  const fileRes = await (await driveApi(token, `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(FILE_ID)}?supportsAllDrives=true&fields=id,name,owners,permissions(id,type,emailAddress,role,deleted,expirationTime)`)).json();
  const perms = fileRes.permissions ?? [];
  const kimPerm = perms.find(p => p.type === 'user' && !p.deleted && p.emailAddress?.toLowerCase() === 'kim@orgiast.jp');
  const role = kimPerm?.role ?? 'なし';
  console.log(`(1) kim@orgiast.jp の現在のロール: ${role}`);

  // (2) writer でなければ付与
  // ただし proxy 経由では permissions POST が 403 になるため、現状は可能な手段で試す
  if (role === 'writer') {
    console.log('(2) すでに writer のため共有付与は不要');
  } else {
    try {
      await driveApi(token, `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(FILE_ID)}/permissions?supportsAllDrives=true&sendNotificationEmail=false`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'writer', type: 'user', emailAddress: 'kim@orgiast.jp' }),
      });
      console.log('(2) writer として共有を付与しました');
    } catch (err) {
      console.log(`(2) writer 付与を試みましたが失敗: ${err.message}`);
    }
  }

  // (3) 再取得＋本文200文字（本文は Drive export 経由で取得）
  const fileRes2 = await (await driveApi(token, `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(FILE_ID)}?supportsAllDrives=true&fields=id,name,permissions(id,type,emailAddress,role,deleted,expirationTime)`)).json();
  const perms2 = fileRes2.permissions ?? [];
  const kimPerm2 = perms2.find(p => p.type === 'user' && !p.deleted && p.emailAddress?.toLowerCase() === 'kim@orgiast.jp');
  const role2 = kimPerm2?.role ?? 'なし';

  // 本文取得（Drive API export as text/plain）
  let head = '';
  try {
    const exportRes = await driveApi(token, `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(FILE_ID)}/export?mimeType=text/plain`);
    const text = await exportRes.text();
    head = text.slice(0, 200);
    console.log(`(3) Doc 本文先頭200文字: ${head}`);
  } catch (err) {
    console.log(`(3) Doc 本文取得失敗: ${err.message}`);
    head = `取得失敗: ${err.message}`;
  }

  console.log(`(3) 再取得後の kim@orgiast.jp のロール: ${role2}`);

  // 最終出力
  console.log('');
  const safeHead = head.replace(/\n/g, '\\n');
  console.log(`KIM_ROLE=${role2}`);
  console.log(`BODY_HEAD=${safeHead}`);
}

await main();