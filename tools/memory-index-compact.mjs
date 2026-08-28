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
export const MERGED_ENTRY_SEPARATOR_RE = / ／ (?=\[[^\]]+\]\([^)]+\.md\))/;
const WIKILINK_RE = /\[\[([^\]]+)\]\]/g;

function asSet(values) {
  return new Set(values);
}

function difference(left, right) {
  return [...left].filter((value) => !right.has(value));
}

function sameSet(left, right) {
  return difference(left, right).length === 0 && difference(right, left).length === 0;
}

function byteLength(text) {
  return Buffer.byteLength(text, 'utf8');
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

export function parseEntry(line) {
  const match = line.match(ENTRY_RE);
  if (!match) return null;
  const separatorIndex = match[3].indexOf(HOOK_SEPARATOR);
  return {
    content: line.replace(/^\s*-\s+/, ''),
    title: match[1],
    hook: separatorIndex < 0 ? '' : match[3].slice(separatorIndex + HOOK_SEPARATOR.length),
  };
}

function parseMoveEntry(part) {
  const match = part.match(/^\[([^\]]+)\]\(([^)]+\.md)\)(.*)$/);
  if (!match) return null;
  const tail = match[3];
  const separatorIndex = tail.indexOf(HOOK_SEPARATOR);
  const wikilinks = [...tail.matchAll(WIKILINK_RE)].map((item) => item[1]);
  const rawHook = separatorIndex < 0 ? '' : tail.slice(separatorIndex + HOOK_SEPARATOR.length);
  const hook = rawHook.replace(WIKILINK_RE, ' ').replace(/[\s\u3000]+/g, ' ').trim();
  return { title: match[1], file: match[2], hook, wikilinks, original: part };
}

function normalizeForMatch(text) {
  return text.replace(/[\s\u3000]+/g, ' ').trim();
}

function bodyContainsHook(body, hook) {
  return !hook || normalizeForMatch(body).includes(normalizeForMatch(hook));
}

function bodyContainsWikilinks(body, wikilinks) {
  const present = new Set([...body.matchAll(WIKILINK_RE)].map((match) => match[1]));
  return wikilinks.every((slug) => present.has(slug));
}

function appendSummary(body, hook, wikilinks) {
  const detail = [hook, ...wikilinks.map((slug) => `[[${slug}]]`)].filter(Boolean).join(' ');
  let result = body;
  if (!result.endsWith('\n')) result += '\n';
  if (!/^## 索引の要約\s*$/m.test(result)) result += '\n## 索引の要約\n';
  return `${result}- ${detail}\n`;
}

export function assertMoveInvariants(before, after, records, { readFile = (file) => fs.readFileSync(file, 'utf8') } = {}) {
  const movedLinks = records.flatMap((record) => record.wikilinks).map((slug) => `[[${slug}]]`).join(' ');
  const checks = [
    ['リンク集合', extractLinkSet(before), extractLinkSet(`${after}\n${movedLinks}`)],
    ['リンクテキスト(タイトル)集合', extractTitleSet(before), extractTitleSet(after)],
  ];
  const failures = checks.filter(([, left, right]) => !sameSet(left, right));
  if (failures.length) {
    const error = new Error(`不変条件が壊れました: ${failures.map(([label, left, right]) => describeSetChange(label, left, right)).join(' / ')}`);
    error.code = 'INVARIANT_FAILED';
    throw error;
  }
  for (const record of records) {
    const body = readFile(record.path);
    if (!bodyContainsHook(body, record.hook)) throw Object.assign(new Error(`転記後の hook が本文にありません: ${record.file} | ${record.hook}`), { code: 'INVARIANT_FAILED' });
    if (!bodyContainsWikilinks(body, record.wikilinks)) throw Object.assign(new Error(`転記後の wikilink が本文にありません: ${record.file}`), { code: 'INVARIANT_FAILED' });
  }
}

export function moveHooks(text, { directory, readFile = (file) => fs.readFileSync(file, 'utf8') } = {}) {
  if (!directory) throw new Error('memory 本体の directory が必要です');
  const hadFinalNewline = text.endsWith('\n');
  const lines = text.split(/\r?\n/);
  if (hadFinalNewline) lines.pop();
  const bodies = new Map();
  const records = [];
  let entryCount = 0;

  const output = lines.map((line) => {
    if (!parseEntry(line)) return line;
    const parts = line.replace(/^\s*-\s+/, '').split(MERGED_ENTRY_SEPARATOR_RE);
    const transformed = parts.map((part) => {
      const entry = parseMoveEntry(part);
      if (!entry) return part;
      entryCount += 1;
      if (!entry.hook && !entry.wikilinks.length) return part;
      const bodyPath = path.resolve(directory, entry.file);
      if (path.dirname(bodyPath) !== path.resolve(directory)) throw new Error(`memory ディレクトリ外のリンクです: ${entry.title} (${entry.file})`);
      let body;
      try { body = bodies.has(bodyPath) ? bodies.get(bodyPath) : readFile(bodyPath); } catch (error) {
        throw new Error(`リンク先ファイルが読めません: ${entry.title} (${entry.file}): ${error.message}`);
      }
      const transferred = bodyContainsHook(body, entry.hook) && bodyContainsWikilinks(body, entry.wikilinks);
      if (!transferred) body = appendSummary(body, entry.hook, entry.wikilinks);
      bodies.set(bodyPath, body);
      records.push({ ...entry, path: bodyPath, transferred, preview: entry.hook.slice(0, 40) });
      return `[${entry.title}](${entry.file})`;
    });
    return `- ${transformed.join(JOIN_SEPARATOR)}`;
  });
  const resultText = `${output.join('\n')}${hadFinalNewline ? '\n' : ''}`;
  assertMoveInvariants(text, resultText, records, { readFile: (file) => bodies.get(file) ?? readFile(file) });
  return {
    text: resultText, bodies, records, entryCount,
    hookCount: records.filter((record) => Boolean(record.hook)).length,
    transferredCount: records.filter((record) => record.transferred).length,
    appendCount: records.filter((record) => !record.transferred).length,
    before: { bytes: byteLength(text), lines: lines.length },
    after: { bytes: byteLength(resultText), lines: output.length },
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

function allMemoryFiles() {
  const projectsDir = path.join(os.homedir(), '.claude', 'projects');
  const candidates = fs.readdirSync(projectsDir, { withFileTypes: true })
    .filter((item) => item.isDirectory())
    .map((item) => path.join(projectsDir, item.name, 'memory', 'MEMORY.md'))
    .filter((file) => fs.existsSync(file))
    .map((file) => ({ file, mtime: fs.statSync(path.dirname(path.dirname(file))).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (!candidates.length) throw new Error(`MEMORY.md が見つかりません: ${projectsDir}`);
  return candidates.map((candidate) => candidate.file);
}

function latestMemoryFile() {
  return allMemoryFiles()[0];
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

const BACKUP_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

export function cleanupOldBackups(directory, { now = Date.now() } = {}) {
  let deleted = 0;
  for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
    const isIndexBackup = item.isFile() && /^MEMORY\.md\.bak-/.test(item.name);
    const isBodyBackup = item.isDirectory() && /^\.memory-body-backup-/.test(item.name);
    if (!isIndexBackup && !isBodyBackup) continue;
    const target = path.join(directory, item.name);
    if (fs.statSync(target).mtimeMs >= now - BACKUP_MAX_AGE_MS) continue;
    fs.rmSync(target, { recursive: isBodyBackup, force: false });
    deleted += 1;
  }
  return deleted;
}

function parseNonNegativeInteger(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) throw new Error(`${name} は0以上の整数にしてください`);
  return number;
}

function processFile(file, { dryRun, apply, moveHooksMode, target, minBytes }) {
  const before = fs.readFileSync(file, 'utf8');
  if (minBytes !== undefined && byteLength(before) <= minBytes) {
    console.log(`しきい値未満のためスキップ: ${file}`);
    return { file, skipped: true, reason: 'min-bytes' };
  }
  if (moveHooksMode) {
    const result = moveHooks(before, { directory: path.dirname(file) });
    if (result.appendCount === 0 && result.text === before) {
      console.log(`変更なし: ${file}`);
      return { ...result, file, skipped: true, reason: 'unchanged' };
    }
    for (const record of result.records) {
      console.log(`${record.file} | ${record.transferred ? '転記済み' : '要追記'} | ${record.preview}`);
    }
    console.log(`集計: エントリ数 ${result.entryCount} / hook あり件数 ${result.hookCount} / 既に転記済み件数 ${result.transferredCount} / 追記する件数 ${result.appendCount}`);
    const reduction = result.before.bytes ? ((result.before.bytes - result.after.bytes) / result.before.bytes) * 100 : 0;
    console.log(`索引 ${result.before.bytes} B -> ${result.after.bytes} B (-${reduction.toFixed(1)}%)`);
    console.log(`行数 ${result.before.lines} -> ${result.after.lines}`);
    console.log(`24.4KB(24985B) 未満: ${result.after.bytes < 24985 ? 'OK' : 'NG'}`);
    console.log(`17.1KB(17510B) 以下: ${result.after.bytes <= 17510 ? 'OK' : 'NG'}`);
    if (!apply) return result;

    const stamp = timestamp();
    const indexChanged = result.text !== before;
    const indexBackup = `${file}.bak-${stamp}`;
    const bodyBackupDir = path.join(path.dirname(file), `.memory-body-backup-${stamp}`);
    const changedBodies = [...new Set(result.records.filter((record) => !record.transferred).map((record) => record.path))];
    if (indexChanged) fs.copyFileSync(file, indexBackup, fs.constants.COPYFILE_EXCL);
    if (changedBodies.length) {
      fs.mkdirSync(bodyBackupDir, { recursive: false });
      for (const bodyPath of changedBodies) fs.copyFileSync(bodyPath, path.join(bodyBackupDir, path.basename(bodyPath)), fs.constants.COPYFILE_EXCL);
    }

    const writeAtomic = (target, content) => {
      const temporary = `${target}.tmp-${process.pid}`;
      fs.writeFileSync(temporary, content, 'utf8');
      try { fs.renameSync(temporary, target); } finally { fs.rmSync(temporary, { force: true }); }
    };
    try {
      for (const bodyPath of changedBodies) writeAtomic(bodyPath, result.bodies.get(bodyPath));
      if (indexChanged) writeAtomic(file, result.text);
      const readBackIndex = fs.readFileSync(file, 'utf8');
      assertMoveInvariants(before, readBackIndex, result.records);
      if (readBackIndex !== result.text) throw Object.assign(new Error('索引の read-back が書き込み内容と一致しません'), { code: 'INVARIANT_FAILED' });
    } catch (error) {
      if (indexChanged) fs.copyFileSync(indexBackup, file);
      for (const bodyPath of changedBodies) fs.copyFileSync(path.join(bodyBackupDir, path.basename(bodyPath)), bodyPath);
      throw new Error(`適用後検証に失敗したためバックアップから復元しました: ${error.message}`);
    }
    console.log(`書き換え完了: ${file}`);
    if (indexChanged) console.log(`索引バックアップ: ${indexBackup}`);
    if (changedBodies.length) console.log(`本文バックアップ: ${bodyBackupDir}`);
    const deleted = cleanupOldBackups(path.dirname(file));
    if (deleted) console.log(`古いバックアップを削除: ${deleted}件`);
    return result;
  }
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
    try { fs.copyFileSync(temporary, file); } finally { fs.rmSync(temporary, { force: true }); }
    console.log(`書き換え完了: ${file}`);
    console.log(`バックアップ: ${backup}`);
    const deleted = cleanupOldBackups(path.dirname(file));
    if (deleted) console.log(`古いバックアップを削除: ${deleted}件`);
  }
  if (!result.targetReached) console.log(`目標 ${target} 行に未達です。これ以上は機械的に畳めない。`);
  return result;
}

export function run(argv = process.argv.slice(2)) {
  const dryRun = argv.includes('--dry-run');
  const apply = argv.includes('--apply');
  if (dryRun === apply) throw new Error('--dry-run または --apply のどちらか一方を指定してください');
  const fileOption = optionValue(argv, '--file');
  const allProjects = argv.includes('--all-projects');
  if (fileOption && allProjects) throw new Error('--file と --all-projects は同時に指定できません');
  const moveHooksMode = argv.includes('--move-hooks');
  const targetText = optionValue(argv, '--target');
  const target = targetText === undefined ? 140 : Number(targetText);
  if (!Number.isInteger(target) || target < 1) throw new Error('--target は1以上の整数にしてください');
  const minBytesText = optionValue(argv, '--min-bytes');
  const minBytes = minBytesText === undefined ? undefined : parseNonNegativeInteger(minBytesText, '--min-bytes');
  const files = fileOption ? [path.resolve(fileOption)] : allProjects ? allMemoryFiles() : [latestMemoryFile()];
  if (!allProjects) return processFile(files[0], { dryRun, apply, moveHooksMode, target, minBytes });
  const results = [];
  const failures = [];
  for (const file of files) {
    try { results.push(processFile(file, { dryRun, apply, moveHooksMode, target, minBytes })); }
    catch (error) {
      failures.push({ file, error });
      console.error(`処理失敗: ${file}: ${error.message}`);
    }
  }
  if (failures.length) throw new Error(`全プロジェクト処理: ${failures.length}件失敗`);
  return results;
}

if (isEntry(import.meta.url)) {
  try {
    run();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
