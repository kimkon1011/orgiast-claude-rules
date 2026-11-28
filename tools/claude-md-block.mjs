#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntry } from './is-entry.mjs';

export function insertBlock({ file, id, block, after = '', dryRun = false }) {
  if (!/^[a-z0-9-]+$/i.test(id)) throw new Error('ブロックIDが不正です');
  const raw = fs.readFileSync(file, 'utf8');
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const source = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const begin = `<!-- BEGIN orgiast-block:${id} -->`, end = `<!-- END orgiast-block:${id} -->`;
  const wrapped = `${begin}\n${block.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').trim()}\n${end}`;
  let result, status;
  const start = source.indexOf(begin), finish = source.indexOf(end);
  if (start >= 0) {
    if (finish < start || source.indexOf(begin, start + begin.length) >= 0) throw new Error('ブロックの境界が不正です');
    result = source.slice(0, start) + wrapped + source.slice(finish + end.length); status = 'updated';
  } else {
    if (finish >= 0) throw new Error('ブロックの開始マーカーがありません');
    const lines = source.split('\n');
    let i = after ? lines.findIndex(line => line.includes(after)) : -1;
    if (i >= 0) {
      while (i < lines.length && lines[i].trim()) i++;
      lines.splice(i, 0, '', wrapped); result = lines.join('\n');
    } else result = `${source.trimEnd()}\n\n${wrapped}\n`;
    status = 'inserted';
  }
  result = result.replace(/\n/g, eol);
  if (result === raw) return 'unchanged';
  if (!dryRun) {
    const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
    let backup = `${file}.bak-presend-${stamp}`, n = 0;
    while (fs.existsSync(backup)) backup = `${file}.bak-presend-${stamp}-${++n}`;
    fs.copyFileSync(file, backup); fs.writeFileSync(file, result, 'utf8');
  }
  return status;
}
export function main(argv = process.argv.slice(2)) {
  const val = flag => { const i = argv.indexOf(flag); return i < 0 ? undefined : argv[i + 1]; };
  const defaults = argv.includes('--all-default');
  const file = val('--file') || path.join(process.env.ORGIAST_HOME || os.homedir(), '.claude', 'CLAUDE.md');
  const id = defaults ? 'presend-reply-check' : val('--id');
  const blockFile = defaults ? fileURLToPath(new URL('../config/claude-md-blocks/presend-reply-check.md', import.meta.url)) : val('--block-file');
  if (!id || !blockFile) throw new Error('--id と --block-file、または --all-default が必要です');
  const status = insertBlock({ file, id, block: fs.readFileSync(blockFile, 'utf8'), after: defaults ? '送信前の整合性チェック' : val('--after'), dryRun: argv.includes('--dry-run') });
  console.log(status); return status;
}
if (isEntry(import.meta.url)) { try { main(); } catch (error) { console.error(error.message); process.exitCode = 2; } }
