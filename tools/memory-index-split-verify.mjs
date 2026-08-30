#!/usr/bin/env node
// split 生成側とはコードを共有せず、ディスク上の結果だけを独立に照合する。
import fs from 'node:fs';
import path from 'node:path';
import { isEntry } from './is-entry.mjs';

const MARKER = '<!-- MEMORY-INDEX v2 split -->';
const LINK_RE = /\[([^\]]+)\]\(([^)]+\.md)\)/g;

function optionValue(argv, name) {
  const index = argv.indexOf(name);
  if (index < 0) throw new Error(`${name} が必要です`);
  if (!argv[index + 1] || argv[index + 1].startsWith('--')) throw new Error(`${name} の値が必要です`);
  return argv[index + 1];
}

function rootMemoryFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((item) => item.isFile() && item.name.endsWith('.md') && item.name !== 'MEMORY.md' && !item.name.includes('.bak'))
    .map((item) => item.name).sort();
}

function links(text) {
  return [...text.matchAll(LINK_RE)].map((match) => ({ title: match[1], target: match[2] }));
}

export function verify(directory) {
  const problems = [];
  const memoryPath = path.join(directory, 'MEMORY.md');
  if (!fs.existsSync(memoryPath)) return { problems: ['MEMORY.md が存在しません'], stats: {} };
  const memoryBuffer = fs.readFileSync(memoryPath);
  const memory = memoryBuffer.toString('utf8');
  if (!memory.includes(MARKER)) problems.push('MEMORY.md に v2 マーカーがありません');
  if (memoryBuffer.length > 5120) problems.push(`MEMORY.md が 5,120B を超えています: ${memoryBuffer.length}B`);

  const indexDirectory = path.join(directory, 'index');
  const indexNames = fs.existsSync(indexDirectory)
    ? fs.readdirSync(indexDirectory, { withFileTypes: true }).filter((item) => item.isFile() && item.name.endsWith('.md')).map((item) => item.name).sort()
    : [];
  const memoryIndexRefs = new Set();
  const pinTargets = [];
  for (const link of links(memory)) {
    const resolved = path.resolve(directory, link.target);
    if (!fs.existsSync(resolved)) problems.push(`壊れリンク: MEMORY.md -> ${link.target}`);
    const relative = path.relative(indexDirectory, resolved).replaceAll(path.sep, '/');
    if (!relative.startsWith('../') && relative.endsWith('.md')) memoryIndexRefs.add(relative);
    else if (path.dirname(resolved) === path.resolve(directory) && path.basename(resolved) !== 'MEMORY.md') pinTargets.push(path.basename(resolved));
  }

  for (const name of memoryIndexRefs) if (!indexNames.includes(name)) problems.push(`MEMORY.md が参照するサブ索引が存在しません: index/${name}`);
  for (const name of indexNames) if (!memoryIndexRefs.has(name)) problems.push(`MEMORY.md から参照されないサブ索引: index/${name}`);

  const expected = rootMemoryFiles(directory);
  const counts = new Map(expected.map((file) => [file, 0]));
  for (const name of indexNames) {
    const indexPath = path.join(indexDirectory, name);
    const text = fs.readFileSync(indexPath, 'utf8');
    for (const link of links(text)) {
      const resolved = path.resolve(indexDirectory, link.target);
      if (!fs.existsSync(resolved)) problems.push(`壊れリンク: index/${name} -> ${link.target}`);
      if (path.dirname(resolved) === path.resolve(directory) && counts.has(path.basename(resolved))) {
        const file = path.basename(resolved);
        counts.set(file, counts.get(file) + 1);
      }
    }
  }
  const missing = [...counts].filter(([, count]) => count === 0).map(([file]) => file);
  const duplicates = [...counts].filter(([, count]) => count >= 2).map(([file, count]) => `${file} (${count}回)`);
  if (missing.length) problems.push(`取りこぼし: ${missing.join(', ')}`);
  if (duplicates.length) problems.push(`重複: ${duplicates.join(', ')}`);
  for (const pin of pinTargets) if ((counts.get(pin) || 0) === 0) problems.push(`pin がサブ索引にありません: ${pin}`);

  return {
    problems,
    stats: { memoryBytes: memoryBuffer.length, memories: expected.length, indexes: indexNames.length, pins: pinTargets.length },
  };
}

export function run(argv = process.argv.slice(2)) {
  const directory = path.resolve(optionValue(argv, '--dir'));
  const result = verify(directory);
  if (result.problems.length) {
    console.error(`検証 NG (${result.problems.length}件):`);
    for (const problem of result.problems) console.error(`- ${problem}`);
    throw new Error('v2 memory 索引の独立検証に失敗しました');
  }
  console.log(`検証 OK: memory ${result.stats.memories}件 / sub index ${result.stats.indexes}件 / pin ${result.stats.pins}件 / MEMORY.md ${result.stats.memoryBytes}B`);
  return result;
}

if (isEntry(import.meta.url)) {
  try { run(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
