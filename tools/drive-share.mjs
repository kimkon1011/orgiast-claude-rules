#!/usr/bin/env node
// node tools/drive-share.mjs --id <URL|ID> --to <mail[,mail]> [--role reader|commenter|writer] [--as <mail>] [--dry]
import { getDriveToken, driveApi } from './lib/drive-auth.mjs';
import { extractFileId, shareRecipients, shareAndRecord } from './lib/drive-share.mjs';
import { isEntry } from './is-entry.mjs';

export async function main(argv = process.argv.slice(2)) {
  try {
    const args = {};
    for (let i = 0; i < argv.length; i++) {
      const flag = argv[i];
      if (flag === '--dry') { args.dry = true; continue; }
      if (!['--id', '--to', '--role', '--as'].includes(flag) || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`不正な引数: ${flag}`);
      args[flag.slice(2)] = argv[++i];
    }
    const fileId = extractFileId(args.id);
    if (!fileId) throw new Error('--id <URL|ID> は必須です');
    const recipients = shareRecipients(args.to, args.role);
    if (args.dry) {
      for (const r of recipients) console.log(`dry: ${fileId} → ${r.email} (${r.role})`);
      return 0;
    }
    const token = await getDriveToken({ impersonate: args.as });
    const meta = await (await driveApi(token, `https://www.googleapis.com/drive/v3/files/${fileId}?fields=name&supportsAllDrives=true`)).json();
    await shareAndRecord({ fileId, emails: args.to, role: args.role, auth: token, name: meta.name });
    return 0;
  } catch (error) { console.error(error.message); return 1; }
}
if (isEntry(import.meta.url)) process.exitCode = await main();
