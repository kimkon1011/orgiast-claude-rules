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
    const names = fs.readdirSync(temporary, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md') && entry.name !== 'EXCLUDED.md')
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
    const generatedAt = (options.now || new Date()).toISOString();
    const fileLines = names.map((name) =>
      `    ${JSON.stringify(name)}: ${JSON.stringify(fs.readFileSync(path.join(temporary, name), 'utf8'))},`);
    const source = [
      '// 自動生成。編集しない。コミットしない。orgiast-claude-rules の tools/memory-publish.mjs が作る。',
      'module.exports = {',
      '  version: 1,',
      '  channel: "private",',
      `  generatedAt: ${JSON.stringify(generatedAt)},`,
      '  files: {',
      ...fileLines,
      '  }',
      '};',
      '',
    ].join('\n');
    const bytes = Buffer.byteLength(source, 'utf8');
    const destination = path.join(options.keyserveRepo, 'api', '_memory-bundle.generated.js');
    const legacyDirectory = path.join(options.keyserveRepo, 'memory-bundle');
    const legacyPath = path.join(options.keyserveRepo, 'memory-bundle.generated.js');
    const emit = options.emit || console.log;
    let removedLegacyDirectory = false;
    let removedLegacyPath = false;
    if (!dryRun) {
      if (fs.existsSync(legacyDirectory)) {
        fs.rmSync(legacyDirectory, { recursive: true });
        removedLegacyDirectory = true;
        emit(`旧 memory-bundle/ ディレクトリを削除: ${legacyDirectory}`);
      }
      if (fs.existsSync(legacyPath)) {
        fs.rmSync(legacyPath);
        removedLegacyPath = true;
        emit(`旧 memory-bundle.generated.js を削除（直下配信の再漏洩防止）: ${legacyPath}`);
      }
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, source, 'utf8');
    }
    const result = { exported: exported.exported, files: names.length, bytes, removedLegacyDirectory, removedLegacyPath };
    emit(`${dryRun ? 'dry-run: ' : ''}memory bundle: files=${names.length} bytes=${bytes}`);
    return result;
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

export function run(argv = process.argv.slice(2)) {
  return publishMemories({ keyserveRepo: argValue(argv, '--keyserve-repo'), dryRun: argv.includes('--dry-run') });
}

if (isEntry(import.meta.url)) {
  try { run(); } catch (error) { console.error(`memory-publish 失敗: ${String(error.message || error).split(/\r?\n/)[0]}`); process.exitCode = 1; }
}
