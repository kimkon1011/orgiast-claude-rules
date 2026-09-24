#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntry } from './is-entry.mjs';

export function parseArgs(argv) {
  const args = { list: false, dry: false, critical: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--list') args.list = true;
    else if (arg === '--dry') args.dry = true;
    else if (arg === '--critical') args.critical = true;
    else if (['--memory-dir', '--bump', '--queue-out'].includes(arg)) {
      if (!argv[i + 1]) throw new Error(`${arg} にパスが必要です`);
      args[arg.slice(2).replace('-', '_')] = argv[++i];
    } else throw new Error(`不明な引数: ${arg}`);
  }
  if (!args.bump && !args.list && !args.queue_out) args.list = true;
  return args;
}

export function parseMemory(text, file = '') {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  if (lines[0] !== '---') throw new Error('frontmatter開始区切りがありません');
  const end = lines.indexOf('---', 1);
  if (end < 0) throw new Error('frontmatter終了区切りがありません');
  const metadataIndex = lines.slice(1, end).findIndex((line) => /^metadata:\s*$/.test(line)) + 1;
  if (metadataIndex <= 0) throw new Error('metadataがありません');
  let metadataEnd = end;
  for (let i = metadataIndex + 1; i < end; i += 1) {
    if (/^[^\s#][^:]*:/.test(lines[i])) { metadataEnd = i; break; }
  }
  const values = {};
  for (let i = metadataIndex + 1; i < metadataEnd; i += 1) {
    const match = lines[i].match(/^\s{2}([a-z_]+):\s*(.*?)\s*$/);
    if (match) values[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
  const rawCount = values.count === undefined ? 1 : Number(values.count);
  if (!Number.isInteger(rawCount) || rawCount < 1) throw new Error('metadata.countが正の整数ではありません');
  const status = values.status || 'ACTIVE';
  if (!['ACTIVE', 'PROMOTE', 'PROMOTED', 'ARCHIVED'].includes(status)) throw new Error('metadata.statusが不正です');
  return { file, text, lines, eol, end, metadataIndex, metadataEnd, type: values.type, count: rawCount, status, critical: values.critical === 'true' };
}

function setMetadata(parsed, key, value) {
  const pattern = new RegExp(`^(\\s{2})${key}:`);
  for (let i = parsed.metadataIndex + 1; i < parsed.metadataEnd; i += 1) {
    const match = parsed.lines[i].match(pattern);
    if (match) { parsed.lines[i] = `${match[1]}${key}: ${value}`; return; }
  }
  parsed.lines.splice(parsed.metadataEnd, 0, `  ${key}: ${value}`);
  parsed.metadataEnd += 1;
  parsed.end += 1;
}

export function bumpMemory(text, { critical = false, file = '' } = {}) {
  const parsed = parseMemory(text, file);
  const before = { count: parsed.count, status: parsed.status, critical: parsed.critical };
  const count = parsed.count + 1;
  const isCritical = critical || parsed.critical;
  const status = parsed.status === 'PROMOTED' || parsed.status === 'ARCHIVED'
    ? parsed.status : (count >= 3 || isCritical ? 'PROMOTE' : parsed.status);
  setMetadata(parsed, 'count', count);
  if (critical) setMetadata(parsed, 'critical', 'true');
  if (status !== parsed.status || status === 'PROMOTE') setMetadata(parsed, 'status', status);
  return { text: parsed.lines.join(parsed.eol), before, after: { count, status, critical: isCritical } };
}

function walkMarkdown(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md') && entry.name !== 'MEMORY.md')
    .map((entry) => path.join(dir, entry.name));
}

export function defaultMemoryDirs(home = os.homedir()) {
  const projects = path.join(home, '.claude', 'projects');
  if (!fs.existsSync(projects)) return [];
  return fs.readdirSync(projects, { withFileTypes: true })
    .filter((entry) => entry.isDirectory()).map((entry) => path.join(projects, entry.name, 'memory'));
}

export function scanMemory(dirs, { onError = (message) => console.error(message) } = {}) {
  const result = { scanned: 0, targets: [], excluded: 0, invalid: 0 };
  for (const file of dirs.flatMap(walkMarkdown).sort()) {
    result.scanned += 1;
    try {
      const item = parseMemory(fs.readFileSync(file, 'utf8'), file);
      if (item.type !== 'feedback') result.excluded += 1;
      else if ((item.count >= 3 && item.status !== 'PROMOTED') || (item.critical && item.status === 'ACTIVE')) result.targets.push(item);
      else result.excluded += 1;
    } catch (error) {
      result.invalid += 1;
      onError(`[learning-ledger] skip: ${file} (${error.message})`);
    }
  }
  return result;
}

function queueText(targets) {
  if (!targets.length) return '# Promotion Queue\n\nPROMOTE 待ち: 0件\n';
  return `# Promotion Queue\n\nPROMOTE 待ち: ${targets.length}件\n\n${targets.map((item) => `- ${path.basename(item.file, '.md')} (count: ${item.count}, status: ${item.status}${item.critical ? ', critical: true' : ''})`).join('\n')}\n`;
}

const MEMORY_LIMIT = 24985;

export function inspectAutoloadLayer(dir) {
  const memoryFile = path.join(dir, 'MEMORY.md');
  if (!fs.existsSync(memoryFile)) return { lines: ['自動ロード層: MEMORY.md なし', '掃除候補: 0件'] };
  const buffer = fs.readFileSync(memoryFile);
  const text = buffer.toString('utf8');
  const section = text.match(/^## 常に効くルール\s*$([\s\S]*?)(?=^## |$(?![\s\S]))/mu)?.[1] ?? '';
  const links = [...section.matchAll(/^\s*-\s+\[[^\]]+\]\(([^)]+\.md)\)\s*$/gmu)];
  const candidates = [];
  for (const [, linked] of links) {
    const file = path.resolve(dir, linked);
    try {
      const { status } = parseMemory(fs.readFileSync(file, 'utf8'), file);
      if (status === 'PROMOTED' || status === 'ARCHIVED') candidates.push(`掃除候補: ${linked}（${status} だが常時ロードに残存）`);
    } catch { /* 壊れたリンク先は台帳本体の走査で報告する */ }
  }
  const pct = Math.round(buffer.byteLength / MEMORY_LIMIT * 100);
  return { lines: [
    `自動ロード層: MEMORY.md ${buffer.byteLength}B / 上限 ${MEMORY_LIMIT}B (${pct}%) / 常に効くルール ${links.length}行`,
    ...(candidates.length ? candidates : ['掃除候補: 0件']),
  ] };
}

export function run(argv, io = {}) {
  const args = parseArgs(argv);
  const out = io.out || console.log;
  const err = io.err || console.error;
  if (args.bump) {
    const original = fs.readFileSync(args.bump, 'utf8');
    const changed = bumpMemory(original, { critical: args.critical, file: args.bump });
    if (!args.dry) fs.writeFileSync(args.bump, changed.text, 'utf8');
    out(`[learning-ledger] ${args.dry ? 'dry ' : ''}${args.bump}: count ${changed.before.count}→${changed.after.count}, status ${changed.before.status}→${changed.after.status}${changed.after.critical ? ', critical=true' : ''}`);
  }
  if (args.list || args.queue_out) {
    const dirs = args.memory_dir ? [path.resolve(args.memory_dir)] : defaultMemoryDirs(io.home);
    const result = scanMemory(dirs, { onError: err });
    for (const item of result.targets) out(`${item.file}\tcount=${item.count}\tstatus=${item.status}${item.critical ? '\tcritical=true' : ''}`);
    const autoloadLines = dirs.flatMap((dir) => inspectAutoloadLayer(dir).lines);
    for (const line of autoloadLines) out(line);
    if (args.queue_out && !args.dry) {
      fs.mkdirSync(path.dirname(path.resolve(args.queue_out)), { recursive: true });
      fs.writeFileSync(args.queue_out, `${queueText(result.targets).trimEnd()}\n\n${autoloadLines.join('\n')}\n`, 'utf8');
    }
    out(`走査 ${result.scanned} = 対象 ${result.targets.length} + 対象外 ${result.excluded} + 解析不能 ${result.invalid}`);
    return result;
  }
  return null;
}

if (isEntry(import.meta.url)) {
  try { run(process.argv.slice(2)); }
  catch (error) { console.error(`[learning-ledger] ${error.message}`); process.exitCode = 2; }
}
