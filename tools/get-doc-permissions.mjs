#!/usr/bin/env node
/**
 * Google Doc の権限確認・writer共有付与・本文取得
 * 使い方: node tools/get-doc-permissions.mjs <fileId>
 * 認証リレーは drive-share.mjs / drive-upload.mjs と同じ経路（seisaku-team@orgiast.jp subject）
 */
import { getDriveToken, driveApi } from './lib/drive-auth.mjs';

const FILE_ID = process.argv[2];
if (!FILE_ID) { console.error('Usage: node tools/get-doc-permissions.mjs <fileId>'); process.exit(1); }

async function listPermissions(fileId, token) {
  const endpoint = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/permissions`;
  const all = [];
  let pageToken;
  do {
    const params = new URLSearchParams({
      supportsAllDrives: 'true',
      fields: 'nextPageToken,permissions(id,type,emailAddress,role,deleted,expirationTime)',
      pageSize: '100',
    });
    if (pageToken) params.set('pageToken', pageToken);
    const res = await driveApi(token, `${endpoint}?${params}`);
    const page = await res.json();
    all.push(...(page.permissions ?? []));
    pageToken = page.nextPageToken;
  } while (pageToken);
  return all;
}

function findUserRole(perms, email) {
  const match = perms.find(p =>
    p.type === 'user' && !p.deleted && p.emailAddress?.toLowerCase() === email.toLowerCase()
    && (!p.expirationTime || Date.parse(p.expirationTime) > Date.now())
  );
  return match?.role ?? null;
}

async function addWriter(fileId, token, email) {
  const endpoint = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/permissions`;
  await driveApi(token, `${endpoint}?sendNotificationEmail=false&supportsAllDrives=true`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'user', emailAddress: email, role: 'writer' }),
  });
}

async function getDocBodyHead(fileId, token) {
  // Google Docs API で本文取得
  const res = await driveApi(token, `https://docs.googleapis.com/v1/documents/${encodeURIComponent(fileId)}`);
  const doc = await res.json();
  const text = doc.body?.content?.reduce((acc, el) => {
    if (el.paragraph?.elements) {
      for (const e of el.paragraph.elements) {
        if (e.textRun?.content) acc += e.textRun.content;
      }
    }
    return acc;
  }, '') ?? '';
  return text.slice(0, 200);
}

async function main() {
  const token = await getDriveToken(); // subject seisaku-team@orgiast.jp

  // (1) 権限一覧取得
  const perms = await listPermissions(FILE_ID, token);
  const role = findUserRole(perms, 'kim@orgiast.jp');
  console.log(`(1) kim@orgiast.jp の現在のロール: ${role ?? 'なし'}`);

  // (2) writer でなければ付与
  if (role !== 'writer') {
    await addWriter(FILE_ID, token, 'kim@orgiast.jp');
    console.log('(2) writer として共有を付与しました');
  } else {
    console.log('(2) すでに writer のため共有付与は不要');
  }

  // (3) 再取得＋先頭200文字
  const perms2 = await listPermissions(FILE_ID, token);
  const role2 = findUserRole(perms2, 'kim@orgiast.jp');
  const head = await getDocBodyHead(FILE_ID, token);
  console.log(`(3) 再取得後の kim@orgiast.jp のロール: ${role2}`);
  console.log(`(3) Doc 本文先頭200文字: ${head}`);

  // 最終出力
  console.log('');
  const safeHead = head.replace(/\n/g, '\\n');
  console.log(`KIM_ROLE=${role2}`);
  console.log(`BODY_HEAD=${safeHead}`);
}

await main();