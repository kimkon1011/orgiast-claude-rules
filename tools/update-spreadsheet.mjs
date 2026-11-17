#!/usr/bin/env node
/**
 * Update an existing Google Sheets spreadsheet with a local xlsx file.
 * Usage: node tools/update-spreadsheet.mjs --file <xlsx> --id <sheetId> [--as <email>]
 */
import { getDriveToken, driveApi } from './lib/drive-auth.mjs';
import { readFileSync } from 'node:fs';
import { isEntry } from './is-entry.mjs';
import path from 'node:path';

const MIME = {
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

async function main() {
  const args = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--file') { args.file = argv[++i]; }
    else if (argv[i] === '--id') { args.id = argv[++i]; }
    else if (argv[i] === '--as') { args.as = argv[++i]; }
    else { throw new Error(`unknown: ${argv[i]}`); }
  }
  if (!args.file || !args.id) throw new Error('--file and --id required');

  const as = args.as || 'seisaku-team@orgiast.jp';
  const token = await getDriveToken({ impersonate: as });
  const content = readFileSync(args.file);
  const mime = MIME[path.extname(args.file).toLowerCase()] || 'application/octet-stream';

  // Use PATCH to update existing file content
  const url = `https://www.googleapis.com/upload/drive/v3/files/${args.id}?uploadType=media&supportsAllDrives=true`;
  const res = await driveApi(token, url, {
    method: 'PATCH',
    headers: {
      'Content-Type': mime,
      'Content-Length': String(content.length),
    },
    body: content,
  });
  
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Drive API error ${res.status}: ${text}`);
  }
  
  const json = await res.json();
  console.log(JSON.stringify({
    ok: true,
    id: json.id,
    name: json.name,
    mimeType: json.mimeType,
    size: json.size,
  }));
}

if (isEntry(import.meta.url)) {
  main().catch(err => {
    console.error(`update-spreadsheet: ${err.message}`);
    process.exitCode = 1;
  });
}