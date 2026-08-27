#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isEntry } from './is-entry.mjs';

const ENTRY_RE = /^\s*-\s+\[([^\]]+)\]\(([^)]+\.md)\)(.*)$/;
const MARKDOWN_LINK_RE = /\[([^\]]+)\]\(([^)]+\.md)\)/g;
const HOOK_SEPARATOR = ' — ';
const JOIN_SEPARATOR = ' ／ ';
const MAX_LINE_LENGTH = 240;
const MERGED_ENTRY_SEPARATOR_RE = / ／ (?=\[[^\]]+\]\([^)]+\.md\))/;

function asSet(values) {
  return new Set(values);
}

function difference(left, right) {
  return [...left].filter((value) => !right.has(value));
}

function sameSet(left, right) {
  return difference(left, right).length === 0 && difference(right, left).length === 0;
}

export function extractLinkSet(text) {
  const links = new Set();
  for (const match of text.matchAll(/\[[^\]]+\]\(([^)]+\.md)\)|\[\[([^\]]+)\]\]/g)) {
    links.add((match[1] || match[2]).replace(/\.md$/i, ''));
  }
  return links;
}

export function extractTitleSet(text) {
  return asSet([...text.matchAll(MARKDOWN_LINK_RE)].map((match) => match[1]));
}

export function extractHookSet(text) {
  const hooks = [];
  for (const line of text.split(/\r?\n/)) {
    if (!parseEntry(line)) continue;
    for (const part of line.replace(/^\s*-\s+/, '').split(MERGED_ENTRY_SEPARATOR_RE)) {
      const index = part.indexOf(HOOK_SEPARATOR);
      if (index >= 0) hooks.push(part.slice(index + HOOK_SEPARATOR.length));
    }
  }
  return asSet(hooks);
}

function describeSetChange(label, before, after) {
  return `${label} (欠損: ${difference(before, after).join(', ') || 'なし'} / 追加: ${difference(after, before).join(', ') || 'なし'})`;
}

export function assertInvariants(before, after) {
  const checks = [
    ['リンク集合', extractLinkSet(before), extractLinkSet(after)],
    ['リンクテキスト(タイトル)集合', extractTitleSet(before), extractTitleSet(after)],
    ['hook文字列集合', extractHookSet(before), extractHookSet(after)],
  ];
  const failures = checks.filter(([, left, right]) => !sameSet(left, right));
  if (!failures.length) return;
  const error = new Error(`不変条件が壊れました: ${failures.map(([label, left, right]) => describeSetChange(label, left, right)).join(' / ')}`);
  error.code = 'INVARIANT_FAILED';
  error.resultText = after;
  throw error;
}

function parseEntry(line) {
  const match = line.match(ENTRY_RE);
  if (!match) return null;
  const separatorIndex = match[3].indexOf(HOOK_SEPARATOR);
  return {
    content: line.replace(/^\s*-\s+/, ''),
    title: match[1],
    hook: separatorIndex < 0 ? '' : match[3].slice(separatorIndex + HOOK_SEPARATOR.length),
  };
}

function lineLength(lines) {
  return lines.reduce((max, line) => Math.max(max, line.length), 0);
}

export function compactMemory(text, { target = 140, maxLineLength = MAX_LINE_LENGTH } = {}) {
  const hadFinalNewline = text.endsWith('\n');
  const lines = text.split(/\r?\n/);
  if (hadFinalNewline) lines.pop();
  const output = [];
  const notCompacted = { differentSection: 0, over240Characters: 0, noPair: 0 };

  for (let index = 0; index < lines.length;) {
    const first = parseEntry(lines[index]);
    if (!first) {
      output.push(lines[index]);
      index += 1;
      continue;
    }

    const second = index + 1 < lines.length ? parseEntry(lines[index + 1]) : null;
    if (!second) {
      output.push(lines[index]);
      if (index + 1 < lines.length) notCompacted.differentSection += 1;
      else notCompacted.noPair += 1;
      index += 1;
      continue;
    }

    const merged = `- ${first.content}${JOIN_SEPARATOR}${second.content}`;
    if (merged.length > maxLineLength) {
      output.push(lines[index], lines[index + 1]);
      notCompacted.over240Characters += 1;
    } else {
      output.push(merged);
    }
    index += 2;
  }

  const resultText = `${output.join('\n')}${hadFinalNewline ? '\n' : ''}`;
  assertInvariants(text, resultText);
  return {
    text: resultText,
    before: { lines: lines.length, longestLine: lineLength(lines) },
    after: { lines: output.length, longestLine: lineLength(output) },
    invariants: {
      links: extractLinkSet(text).size,
      titles: extractTitleSet(text).size,
      hooks: extractHookSet(text).size,
    },
    notCompacted,
    target,
    targetReached: output.length <= target,
  };
}

export function formatDiff(before, after) {
  const oldLines = before.split(/\r?\n/);
  const newLines = after.split(/\r?\n/);
  const output = ['--- before', '+++ after'];
  const count = Math.max(oldLines.length, newLines.length);
  for (let index = 0; index < count; index += 1) {
    if (oldLines[index] === newLines[index]) continue;
    if (oldLines[index] !== undefined) output.push(`-${oldLines[index]}`);
    if (newLines[index] !== undefined) output.push(`+${newLines[index]}`);
  }
  return output.join('\n');
}

function latestMemoryFile() {
  const projectsDir = path.join(os.homedir(), '.claude', 'projects');
  const candidates = fs.readdirSync(projectsDir, { withFileTypes: true })
    .filter((item) => item.isDirectory())
    .map((item) => path.join(projectsDir, item.name, 'memory', 'MEMORY.md'))
    .filter((file) => fs.existsSync(file))
    .map((file) => ({ file, mtime: fs.statSync(path.dirname(path.dirname(file))).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (!candidates.length) throw new Error(`MEMORY.md が見つかりません: ${projectsDir}`);
  return candidates[0].file;
}

function optionValue(argv, name) {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  if (!argv[index + 1] || argv[index + 1].startsWith('--')) throw new Error(`${name} の値が必要です`);
  return argv[index + 1];
}

function timestamp(date = new Date()) {
  const part = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${part(date.getMonth() + 1)}${part(date.getDate())}-${part(date.getHours())}${part(date.getMinutes())}`;
}

export function run(argv = process.argv.slice(2)) {
  const dryRun = argv.includes('--dry-run');
  const apply = argv.includes('--apply');
  if (dryRun === apply) throw new Error('--dry-run または --apply のどちらか一方を指定してください');
  const file = path.resolve(optionValue(argv, '--file') || latestMemoryFile());
  const targetText = optionValue(argv, '--target');
  const target = targetText === undefined ? 140 : Number(targetText);
  if (!Number.isInteger(target) || target < 1) throw new Error('--target は1以上の整数にしてください');
  const before = fs.readFileSync(file, 'utf8');
  let result;
  try {
    result = compactMemory(before, { target });
  } catch (error) {
    if (error.resultText) console.error(formatDiff(before, error.resultText));
    throw error;
  }

  console.log(formatDiff(before, result.text));
  console.log(`行数: ${result.before.lines} -> ${result.after.lines}`);
  console.log(`最長行長: ${result.before.longestLine} -> ${result.after.longestLine}`);
  console.log(`不変条件: リンク${result.invariants.links}件 / タイトル${result.invariants.titles}件 / hook${result.invariants.hooks}件 (すべて不変)`);
  console.log(`畳めなかった理由: 240文字超=${result.notCompacted.over240Characters}件 / ペアなし=${result.notCompacted.noPair}件 / セクション境界=${result.notCompacted.differentSection}件`);
  if (apply) {
    const backup = `${file}.bak-${timestamp()}`;
    fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL);
    const temporary = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(temporary, result.text, 'utf8');
    try {
      fs.copyFileSync(temporary, file);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
    console.log(`書き換え完了: ${file}`);
    console.log(`バックアップ: ${backup}`);
  }
  if (!result.targetReached) console.log(`目標 ${target} 行に未達です。これ以上は機械的に畳めない。`);
  return result;
}

if (isEntry(import.meta.url)) {
  try {
    run();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
