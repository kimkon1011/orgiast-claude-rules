#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MARKER = '<!-- NEXT-SESSION v1 -->';
const HEADING_RE = /^##\s+(.+?)\s*$/;
const ORDER = ['🔁 毎日進める継続タスク', '次の1目的', '残TODO', '未決', '触る前に読む memory'];

function byteLength(text) {
  return Buffer.byteLength(text, 'utf8');
}

export function normalizeLine(line) {
  return line
    .trim()
    .replace(/^(?:(?:[-*])|(?:\d+\.))\s+/, '')
    .replace(/^\*\*|\*\*$/g, '')
    .replace(/\u3000/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isCompleted(line) {
  return line.includes('✅') || /~~[^~]+~~/.test(line);
}

function sectionRank(name) {
  const index = ORDER.findIndex((label) => name.includes(label));
  return index < 0 ? ORDER.length : index;
}

function splitLines(text) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  if (text.endsWith('\n')) lines.pop();
  return { lines, eol };
}

function collapseBlankLines(lines, stats, { count = true } = {}) {
  const output = [];
  let blank = false;
  for (const line of lines) {
    if (line.trim() === '') {
      if (blank || output.length === 0) {
        if (count) stats.empty += 1;
        continue;
      }
      blank = true;
    } else {
      blank = false;
    }
    output.push(line);
  }
  while (output.at(-1)?.trim() === '') {
    output.pop();
    if (count) stats.empty += 1;
  }
  return output;
}

export function compactHandoff(input, { now = new Date() } = {}) {
  const { lines, eol } = splitLines(input);
  const blockCount = lines.filter((line) => line === MARKER).length;
  const markerIndexes = lines.flatMap((line, index) => line === MARKER ? [index] : []);
  const firstMarker = markerIndexes[0] ?? lines.length;
  const preamble = lines.slice(0, firstMarker);
  const body = firstMarker === lines.length ? [] : lines.slice(firstMarker + 1);
  const stats = { completed: 0, duplicate: 0, empty: 0 };
  const sections = new Map();
  const sectionOrder = [];
  const unsectioned = [];
  let current = null;

  for (const line of body) {
    if (line === MARKER) {
      current = null;
      continue;
    }
    if (/^<!-- compacted: .* -->$/.test(line)) continue;
    if (isCompleted(line)) {
      stats.completed += 1;
      continue;
    }
    const heading = line.match(HEADING_RE);
    if (heading) {
      const name = heading[1];
      if (!sections.has(name)) {
        sections.set(name, { heading: line, lines: [], order: sectionOrder.length });
        sectionOrder.push(name);
      }
      current = sections.get(name);
      continue;
    }
    (current ? current.lines : unsectioned).push(line);
  }

  const groups = [unsectioned, ...sectionOrder.map((name) => sections.get(name).lines)];
  const winners = new Map();
  for (const group of groups) {
    for (let index = 0; index < group.length; index += 1) {
      const line = group[index];
      if (line.trim() === '') continue;
      const key = normalizeLine(line);
      const candidate = { group, index, line, bytes: byteLength(line) };
      const winner = winners.get(key);
      if (!winner || candidate.bytes > winner.bytes) winners.set(key, candidate);
    }
  }

  const removedDuplicates = [];
  for (const group of groups) {
    const kept = [];
    for (let index = 0; index < group.length; index += 1) {
      const line = group[index];
      if (line.trim() === '') {
        kept.push(line);
        continue;
      }
      const winner = winners.get(normalizeLine(line));
      if (winner.group === group && winner.index === index) kept.push(line);
      else {
        stats.duplicate += 1;
        removedDuplicates.push(line);
      }
    }
    group.splice(0, group.length, ...collapseBlankLines(kept, stats));
  }

  const cleanPreamble = collapseBlankLines(
    preamble.filter((line) => line !== MARKER && !/^<!-- compacted: .* -->$/.test(line)), stats,
  );
  const sortedSections = [...sections.values()].sort((left, right) => {
    const rank = sectionRank(left.heading.match(HEADING_RE)[1]);
    const otherRank = sectionRank(right.heading.match(HEADING_RE)[1]);
    return rank - otherRank || left.order - right.order;
  });
  const content = [];
  if (cleanPreamble.length) content.push(...cleanPreamble);
  if (unsectioned.length) {
    if (content.length) content.push('');
    content.push(...unsectioned);
  }
  for (const section of sortedSections) {
    if (content.length && content.at(-1) !== '') content.push('');
    content.push(section.heading, ...section.lines);
  }
  const compactedContent = collapseBlankLines(content, stats, { count: false });
  const originalBytes = byteLength(input);
  const timestamp = now.toISOString();
  const prefix = `${MARKER}${eol}<!-- compacted: ${timestamp} / ${originalBytes} -> `;
  const suffix = ` / 元ブロック数 ${blockCount} -->${eol}`;
  let newBytes = 0;
  let output = '';
  for (let attempt = 0; attempt < 8; attempt += 1) {
    output = `${prefix}${newBytes}${suffix}${compactedContent.join(eol)}${eol}`;
    const measured = byteLength(output);
    if (measured === newBytes) break;
    newBytes = measured;
  }
  return { text: output, originalBytes, newBytes: byteLength(output), blockCount, stats, removedDuplicates };
}

function parseArgs(argv) {
  const options = { input: path.join(os.homedir(), '.claude', 'next-session.md'), output: null, dryRun: false, report: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--report') options.report = true;
    else if (arg === '--in' || arg === '--out') {
      const value = argv[++index];
      if (!value) throw new Error(`${arg} にはパスが必要です`);
      if (arg === '--in') options.input = value;
      else options.output = value;
    } else throw new Error(`不明な引数です: ${arg}`);
  }
  options.output ??= options.input;
  return options;
}

export function run(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const input = fs.readFileSync(options.input, 'utf8');
  const result = compactHandoff(input);
  if (!options.dryRun) fs.writeFileSync(options.output, result.text, 'utf8');
  console.log(`${result.originalBytes} -> ${result.newBytes} bytes`);
  console.log(`削除行: 完了 ${result.stats.completed} / 重複 ${result.stats.duplicate} / 空行 ${result.stats.empty}`);
  if (options.report) {
    console.log('採用しなかった短い重複行（最大20件）:');
    for (const line of result.removedDuplicates.slice(0, 20)) console.log(line);
  }
  return result;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    run();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
