#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { DOMAINS, V2_MARKER } from './memory-index-split.mjs';
import { isEntry } from './is-entry.mjs';

const LINK_RE = /\[[^\]]+\]\(([^)]+\.md)\)/g;

function optionValue(argv, name) {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  if (!argv[index + 1] || argv[index + 1].startsWith('--')) throw new Error(`${name} の値が必要です`);
  return argv[index + 1];
}

function memoryFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((item) => item.isFile() && item.name.endsWith('.md') && item.name !== 'MEMORY.md' && !item.name.includes('.bak'))
    .map((item) => item.name).sort();
}

function section(text, heading) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start < 0) return '';
  const endOffset = lines.slice(start + 1).findIndex((line) => /^##\s/.test(line));
  return lines.slice(start + 1, endOffset < 0 ? undefined : start + 1 + endOffset).join('\n');
}

function targets(text) {
  return [...text.matchAll(LINK_RE)].map((match) => match[1]);
}

function atomicWrite(filename, content) {
  const resolved = path.resolve(filename);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const temporary = `${resolved}.memory-index-domains-${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, content, 'utf8');
    fs.renameSync(temporary, resolved);
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary);
  }
}

export function run(argv = process.argv.slice(2)) {
  const dirValue = optionValue(argv, '--dir');
  if (!dirValue) throw new Error('--dir が必要です');
  const directory = path.resolve(dirValue);
  const memoryPath = path.join(directory, 'MEMORY.md');
  const indexDirectory = path.join(directory, 'index');
  if (!fs.existsSync(indexDirectory) || !fs.existsSync(memoryPath)) {
    console.error(`対象外: v2 split 索引ではありません: ${directory}`);
    return { exitCode: 2, assignments: {}, pins: [], unclassified: [] };
  }
  const memory = fs.readFileSync(memoryPath, 'utf8').replace(/^\uFEFF/, '');
  if (!memory.startsWith(V2_MARKER)) {
    console.error(`対象外: MEMORY.md が v2 split マーカーで始まりません: ${directory}`);
    return { exitCode: 2, assignments: {}, pins: [], unclassified: [] };
  }

  const assignments = {};
  const duplicates = [];
  for (const item of fs.readdirSync(indexDirectory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!item.isFile() || !item.name.endsWith('.md')) continue;
    const key = item.name.slice(0, -3);
    const text = fs.readFileSync(path.join(indexDirectory, item.name), 'utf8');
    const allTargets = targets(text);
    const externalTargets = allTargets.filter((target) => {
      if (!target.startsWith('../')) return false;
      const resolved = path.resolve(indexDirectory, target);
      return path.dirname(resolved) !== directory;
    });
    const hasLocalTargets = allTargets.some((target) => {
      if (!target.startsWith('../')) return false;
      const resolved = path.resolve(indexDirectory, target);
      return path.dirname(resolved) === directory;
    });
    const isExternal = externalTargets.length > 0 && !hasLocalTargets;

    if (!Object.hasOwn(DOMAINS, key)) {
      if (isExternal) {
        continue;
      }
      console.error(`警告: 未知のドメイン索引を無視します: index/${item.name}`);
      continue;
    }
    for (const target of allTargets) {
      if (!target.startsWith('../')) continue;
      const resolved = path.resolve(indexDirectory, target);
      if (path.dirname(resolved) !== directory) continue;
      const file = path.basename(resolved);
      if (Object.hasOwn(assignments, file) && assignments[file] !== key) {
        duplicates.push(`${file}: ${assignments[file]}, ${key}`);
        continue;
      }
      assignments[file] = key;
    }
  }

  const files = memoryFiles(directory);
  const fileSet = new Set(files);
  const stale = Object.keys(assignments).filter((file) => !fileSet.has(file));
  if (stale.length) throw new Error(`索引が存在しない memory ファイルを参照しています:\n${stale.map((file) => `- ${file}`).join('\n')}`);
  const unclassified = files.filter((file) => !Object.hasOwn(assignments, file));
  const fallback = optionValue(argv, '--fallback');
  if (fallback && !Object.hasOwn(DOMAINS, fallback)) throw new Error(`未知のドメインキー: ${fallback}`);
  if (duplicates.length) {
    console.error(`複数ドメインにある memory ファイル (${duplicates.length}件):`);
    for (const duplicate of duplicates) console.error(`* ${duplicate}`);
  }
  if (unclassified.length && !fallback) {
    console.error(`未分類の memory ファイル (${unclassified.length}件):`);
    for (const file of unclassified) console.error(`- ${file}`);
  }
  if (duplicates.length || (unclassified.length && !fallback)) {
    return { exitCode: 1, assignments, pins: [], unclassified, duplicates };
  }
  if (fallback) for (const file of unclassified) assignments[file] = fallback;

  const pins = targets(section(memory, '## 常に効くルール'))
    .filter((target) => !target.startsWith('../') && path.dirname(target) === '.')
    .map((target) => path.basename(target));
  if (fallback && unclassified.length) console.log(`未分類 ${unclassified.length}件を ${fallback} へ割当`);
  const domainsText = `${JSON.stringify(Object.fromEntries(Object.entries(assignments).sort(([a], [b]) => a.localeCompare(b))), null, 2)}\n`;
  const pinsText = pins.length ? `${pins.join('\n')}\n` : '';
  const domainsOut = optionValue(argv, '--out-domains');
  const pinsOut = optionValue(argv, '--out-pins');
  if (domainsOut) atomicWrite(domainsOut, domainsText); else process.stdout.write(domainsText);
  if (pinsOut) atomicWrite(pinsOut, pinsText);
  return { exitCode: 0, assignments, pins, unclassified };
}

if (isEntry(import.meta.url)) {
  try { process.exitCode = run().exitCode; } catch (error) { console.error(error.message); process.exitCode = 1; }
}
