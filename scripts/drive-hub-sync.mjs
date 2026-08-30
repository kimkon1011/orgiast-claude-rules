#!/usr/bin/env node
// drive-hub-sync.mjs — claude-common-rules Drive ハブとの同期 CLI（依存ゼロ）
//
// 認証: SA aujust-sheets-reader (DWD 設定済み, scope=drive) で kim@orgiast.jp を impersonate
//   key は env GOOGLE_SA_KEY か既定パス（aujust-sales-automation/.gcp/sheets-sa.json）
//
// 使い方:
//   node drive-hub-sync.mjs list [parentId]
//   node drive-hub-sync.mjs push <localPath> <title> [parentId]   # 同名があれば in-place 更新（ID 保持）
//   node drive-hub-sync.mjs pull <title> <localPath> [parentId]   # 同名複数なら modifiedTime 最新
//
// parentId 省略時はハブ直下 (claude-common-rules)

import { readFileSync, writeFileSync } from 'node:fs';
import { driveApi as api, getDriveToken } from './lib/drive-auth.mjs';

const HUB = '1RLYbK6CKyPWRJsG6LY0WB9OzlbFYSFvw'; // claude-common-rules
async function findByTitle(token, title, parent) {
  const q = encodeURIComponent(`name='${title.replace(/'/g, "\\'")}' and '${parent}' in parents and trashed=false`);
  const res = await api(token, `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,modifiedTime)&orderBy=modifiedTime desc`);
  return (await res.json()).files ?? [];
}

const [cmd, a1, a2, a3] = process.argv.slice(2);
const parent = a3 ?? (cmd === 'list' ? (a1 ?? HUB) : HUB);
const usage = 'usage: drive-hub-sync.mjs list [parentId] | push <local> <title> [parentId] | pull <title> <local> [parentId] | share-domain <id> <reader|writer> | perms <id> | unshare-anyone <id> [--apply]';
if (!cmd) {
  console.error(usage);
  process.exit(1);
}
const token = await getDriveToken();

if (cmd === 'list') {
  const q = encodeURIComponent(`'${parent}' in parents and trashed=false`);
  const res = await api(token, `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,mimeType,modifiedTime)&orderBy=name`);
  for (const f of (await res.json()).files ?? []) console.log(`${f.id}\t${f.mimeType.includes('folder') ? '[dir]' : '     '}\t${f.modifiedTime}\t${f.name}`);
} else if (cmd === 'push') {
  const content = readFileSync(a1);
  const existing = await findByTitle(token, a2, parent);
  if (existing.length > 0) {
    await api(token, `https://www.googleapis.com/upload/drive/v3/files/${existing[0].id}?uploadType=media`, {
      method: 'PATCH', headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: content,
    });
    console.log(`updated (id kept): ${a2} ${existing[0].id}${existing.length > 1 ? ` (WARN: ${existing.length} 個の同名あり、最新を更新)` : ''}`);
  } else {
    const meta = JSON.stringify({ name: a2, parents: [parent], mimeType: 'text/plain' });
    const boundary = 'x-claude-hub-sync';
    const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${content.toString('utf8')}\r\n--${boundary}--`;
    const res = await api(token, 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', {
      method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body,
    });
    console.log(`created: ${a2} ${(await res.json()).id}`);
  }
} else if (cmd === 'pull') {
  const files = await findByTitle(token, a1, parent);
  if (files.length === 0) { console.error(`not found: ${a1}`); process.exit(1); }
  const res = await api(token, `https://www.googleapis.com/drive/v3/files/${files[0].id}?alt=media`);
  writeFileSync(a2, Buffer.from(await res.arrayBuffer()));
  console.log(`pulled: ${a1} (${files[0].modifiedTime}) -> ${a2}`);
} else if (cmd === 'share-domain') {
  // share-domain <fileOrFolderId> <reader|writer>
  const res = await api(token, `https://www.googleapis.com/drive/v3/files/${a1}/permissions?fields=id,role,type,domain`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'domain', domain: 'orgiast.jp', role: a2 ?? 'reader', allowFileDiscovery: true }),
  });
  console.log(`shared: ${JSON.stringify(await res.json())}`);
} else if (cmd === 'perms') {
  const res = await api(token, `https://www.googleapis.com/drive/v3/files/${a1}/permissions?fields=permissions(id,type,role,domain,emailAddress,allowFileDiscovery,permissionDetails)&supportsAllDrives=true`);
  for (const p of (await res.json()).permissions ?? []) console.log(JSON.stringify(p));
} else if (cmd === 'unshare-anyone') {
  const permissionsUrl = `https://www.googleapis.com/drive/v3/files/${a1}/permissions?fields=permissions(id,type,role,domain,emailAddress)&supportsAllDrives=true`;
  const res = await api(token, permissionsUrl);
  const targets = ((await res.json()).permissions ?? []).filter((p) => p.type === 'anyone');
  const apply = process.argv.includes('--apply');

  if (targets.length === 0) console.log(`anyone 公開なし: ${a1}`);
  for (const p of targets) {
    if (apply) {
      await api(token, `https://www.googleapis.com/drive/v3/files/${a1}/permissions/${p.id}?supportsAllDrives=true`, { method: 'DELETE' });
      console.log(`deleted: ${JSON.stringify(p)}`);
    } else {
      console.log(`[dry-run] would delete: ${JSON.stringify(p)}`);
    }
  }

  // 削除後の権限を再取得し、実際に残った権限を確認する
  const afterRes = await api(token, permissionsUrl);
  console.log(`after: ${JSON.stringify((await afterRes.json()).permissions ?? [])}`);
} else {
  console.error(usage);
  process.exit(1);
}
