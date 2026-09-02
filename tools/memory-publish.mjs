#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exportMemories } from './memory-share.mjs';
import { isEntry } from './is-entry.mjs';

function argValue(argv, name) { const at = argv.indexOf(name); return at >= 0 ? argv[at + 1] : undefined; }

export function publishMemories(options = {}) {
  if (!options.keyserveRepo) throw new Error('--keyserve-repo <path> は必須です');
  const dryRun = Boolean(options.dryRun);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-bundle-'));
  try {
    const exported = exportMemories({ home: options.home, outDir: temporary, channel: 'private', emit: () => {} });
    const destination = path.join(options.keyserveRepo, 'memory-bundle');
    const sourceNames = new Set(fs.readdirSync(temporary));
    let copied = 0, removed = 0;
    for (const name of sourceNames) {
      const source = path.join(temporary, name);
      if (!fs.statSync(source).isFile()) continue;
      copied++;
      if (!dryRun) { fs.mkdirSync(destination, { recursive: true }); fs.copyFileSync(source, path.join(destination, name)); }
    }
    if (fs.existsSync(destination)) {
      for (const entry of fs.readdirSync(destination, { withFileTypes: true })) {
        if (entry.isFile() && !sourceNames.has(entry.name)) { removed++; if (!dryRun) fs.rmSync(path.join(destination, entry.name)); }
      }
    }
    const result = { exported: exported.exported, copied, removed };
    (options.emit || console.log)(`${dryRun ? 'dry-run: ' : ''}memory bundle: exported=${result.exported} copied=${copied} removed=${removed}`);
    return result;
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

export function run(argv = process.argv.slice(2)) {
  return publishMemories({ keyserveRepo: argValue(argv, '--keyserve-repo'), dryRun: argv.includes('--dry-run') });
}

if (isEntry(import.meta.url)) {
  try { run(); } catch (error) { console.error(`memory-publish 失敗: ${String(error.message || error).split(/\r?\n/)[0]}`); process.exitCode = 1; }
}
