#!/usr/bin/env node
/**
 * Google Doc の権限確認・writer共有付与・本文取得
 * drive-share.mjs の shareFile を使用（認証リレー共用）
 *
 * 使い方: node tools/get-doc-permissions.mjs <fileId>
 */
import { shareFile } from './lib/drive-share.mjs';
import { getDriveToken, driveApi } from './lib/drive-auth.mjs';

const FILE_ID = process.argv[2];
if (!FILE_ID) { console.error('Usage: node tools/get-doc-permissions.mjs <fileId>'); process.exit(1); }

async function main() {
  // まずトークン取得（proxy 経由 seisaku-team@orgiast.jp）
  const token = await getDriveToken();
  console.error(`getDriveToken returned type: ${typeof token} len:${token.length} isMarker:${token.startsWith('orgiast')}`);

  // shareFile を使って kim@orgiast.jp の権限確認＋writer付与
  // shareFile は emails の各宛先について権限を確認し、不足なら付与する
  // Note: shareFile は内部で driveApi を使って API を叩く
  const results = await shareFile({ fileId: FILE_ID, emails: 'kim@orgiast.jp', auth: token });
  for (const r of results) {
    const stat = r.status === 'exists' ? '既存' : r.status === 'added' ? '追加' : r.status;
    console.error(`shareFile: ${r.email} role=${r.role} status=${stat}`);
  }

  // 権限再取得
  const permsEnd = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(FILE_ID)}/permissions`;
  const all = [];
  let pageToken;
  do {
    const params = new URLSearchParams({ supportsAllDrives: 'true', fields: 'nextPageToken,permissions(id,type,emailAddress,role,deleted,expirationTime)', pageSize: '100' });
    if (pageToken) params.set('pageToken', pageToken);
    const page = await (await driveApi(token, `${permsEnd}?${params}`)).json();
    all.push(...(page.permissions ?? []));
    pageToken = page.nextPageToken;
  } while (pageToken);

  const kimPerm = all.find(p => p.type === 'user' && !p.deleted && p.emailAddress?.toLowerCase() === 'kim@orgiast.jp');
  const role = kimPerm?.role ?? 'なし';
  console.log(`(1) kim@orgiast.jp のロール: ${role}`);

  // 本文取得（Docs API）
  try {
    const docRes = await (await driveApi(token, `https://docs.googleapis.com/v1/documents/${encodeURIComponent(FILE_ID)}`)).json();
    const text = docRes.body?.content?.reduce((acc, el) => {
      if (el.paragraph?.elements) {
        for (const e of el.paragraph.elements) {
          if (e.textRun?.content) acc += e.textRun.content;
        }
      }
      return acc;
    }, '') ?? '';
    const head = text.slice(0, 200);
    console.log(`(3) Doc 本文先頭200文字: ${head}`);
    const safeHead = head.replace(/\n/g, '\\n');
    console.log(`KIM_ROLE=${role}`);
    console.log(`BODY_HEAD=${safeHead}`);
  } catch (e) {
    console.error(`getDocBody: ${e.message}`);
    console.log(`KIM_ROLE=${role}`);
    console.log(`BODY_HEAD=取得失敗: ${e.message}`);
  }
}

await main();