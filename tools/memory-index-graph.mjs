#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntry } from './is-entry.mjs';

export const DEFAULT_KEEP = path.join(path.dirname(fileURLToPath(import.meta.url)), 'memory-index-keep.txt');
const ENTRY_LINE_RE = /^\s*-\s+\[/;
const ENTRY_SEPARATOR = ' ／ ';
const ENTRY_RE = /^\[([^\]]+)\]\(([^)]+\.md)\)(.*)$/;
const WIKILINK_RE = /\[\[([^\]]+)\]\]/g;

export function normalizeSlug(value) {
  return path.basename(value.trim()).replace(/\.md$/i, '').replace(/-/g, '_').toLowerCase();
}

export function parseIndex(text) {
  const entries = [];
  const bom = text.startsWith('\uFEFF') ? '\uFEFF' : '';
  const content = bom ? text.slice(1) : text;
  const lines = content.split(/\r?\n/);
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    if (!ENTRY_LINE_RE.test(line)) continue;
    const prefix = line.match(/^\s*-\s+/)?.[0] ?? '- ';
    const parts = line.slice(prefix.length).split(ENTRY_SEPARATOR);
    for (let partIndex = 0; partIndex < parts.length; partIndex += 1) {
      const match = parts[partIndex].match(ENTRY_RE);
      if (!match) continue;
      entries.push({ title: match[1], file: match[2], slug: normalizeSlug(match[2]), lineIndex, partIndex, fragment: parts[partIndex], prefix });
    }
  }
  return { entries, lines, bom };
}

export function reachableFrom(roots, edges) {
  const reached = new Set();
  const queue = [...roots];
  while (queue.length) {
    const slug = queue.shift();
    if (reached.has(slug)) continue;
    reached.add(slug);
    for (const next of edges.get(slug) ?? []) if (!reached.has(next)) queue.push(next);
  }
  return reached;
}

export function removeEntries(indexText, removed) {
  const parsed = parseIndex(indexText);
  const newline = indexText.includes('\r\n') ? '\r\n' : '\n';
  const hadFinalNewline = indexText.endsWith('\n');
  const byLine = new Map();
  for (const entry of parsed.entries) {
    if (!removed.has(entry.slug)) continue;
    if (!byLine.has(entry.lineIndex)) byLine.set(entry.lineIndex, new Set());
    byLine.get(entry.lineIndex).add(entry.partIndex);
  }
  const afterLines = parsed.lines.map((line, lineIndex) => {
    const removedParts = byLine.get(lineIndex);
    if (!removedParts) return line;
    const prefix = line.match(/^\s*-\s+/)?.[0] ?? '- ';
    const kept = line.slice(prefix.length).split(ENTRY_SEPARATOR)
      .filter((_, partIndex) => !removedParts.has(partIndex));
    return kept.length ? `${prefix}${kept.join(ENTRY_SEPARATOR)}` : null;
  }).filter((line) => line !== null);
  if (hadFinalNewline && afterLines.at(-1) === '') afterLines.pop();
  return `${parsed.bom}${afterLines.join(newline)}${hadFinalNewline ? newline : ''}`;
}

function readGraph(directory, indexText = fs.readFileSync(path.join(directory, 'MEMORY.md'), 'utf8')) {
  const names = fs.readdirSync(directory).filter((name) => name.endsWith('.md') && name !== 'MEMORY.md').sort();
  const files = new Map(names.map((name) => [normalizeSlug(name), name]));
  if (files.size !== names.length) throw new Error('正規化後のファイル名が重複しています');
  const parsed = parseIndex(indexText);
  const indexed = new Set(parsed.entries.map((entry) => entry.slug).filter((slug) => files.has(slug)));
  const edges = new Map();
  for (const [slug, name] of files) {
    const body = fs.readFileSync(path.join(directory, name), 'utf8');
    edges.set(slug, new Set([...body.matchAll(WIKILINK_RE)].map((match) => normalizeSlug(match[1])).filter((target) => files.has(target))));
  }
  return { names, files, parsed, indexed, edges, indexText };
}

function byteStats(before, after) {
  const beforeBytes = Buffer.byteLength(before, 'utf8');
  const afterBytes = Buffer.byteLength(after, 'utf8');
  return { beforeBytes, afterBytes, savedBytes: beforeBytes - afterBytes };
}

export function analyze(directory) {
  const graph = readGraph(directory);
  const reached = reachableFrom(graph.indexed, graph.edges);
  const incoming = new Map();
  for (const root of graph.indexed) for (const target of graph.edges.get(root) ?? []) {
    if (graph.indexed.has(target) && target !== root) incoming.set(target, (incoming.get(target) ?? 0) + 1);
  }
  const roots = new Set(graph.indexed);
  const removable = [];
  for (const [candidate] of [...incoming].sort((a, b) => b[1] - a[1] || graph.files.get(a[0]).localeCompare(graph.files.get(b[0]), 'ja'))) {
    roots.delete(candidate);
    if (reachableFrom(roots, graph.edges).size === graph.files.size) removable.push(candidate);
    else roots.add(candidate);
  }
  const after = removeEntries(graph.indexText, new Set(removable));
  return {
    directory, totalFiles: graph.files.size, indexEntries: graph.parsed.entries.length,
    unindexedFiles: graph.files.size - graph.indexed.size,
    unreachableFiles: [...graph.files.keys()].filter((slug) => !reached.has(slug)).map((slug) => graph.files.get(slug)),
    removableFiles: removable.map((slug) => graph.files.get(slug)), removableCount: removable.length,
    ...byteStats(graph.indexText, after),
  };
}

function loadKeep(file) {
  if (!fs.existsSync(file)) throw new Error(`キープリストがありません: ${file}`);
  return new Set(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#')).map(normalizeSlug));
}

export function planApply(directory, { budget = 15000, keepFile = DEFAULT_KEEP } = {}) {
  const graph = readGraph(directory);
  const keep = loadKeep(keepFile);
  const initialReached = reachableFrom(graph.indexed, graph.edges);
  if (initialReached.size !== graph.files.size) throw new Error(`適用前から到達不能です: ${[...graph.files.keys()].filter((slug) => !initialReached.has(slug)).map((slug) => graph.files.get(slug)).join(', ')}`);
  const roots = new Set(graph.indexed);
  const removed = new Set();
  let afterText = graph.indexText;
  while (Buffer.byteLength(afterText, 'utf8') > budget) {
    const ranked = [...roots].filter((slug) => !keep.has(slug) && !removed.has(slug)).map((slug) => {
      let incoming = 0;
      for (const source of roots) if (source !== slug && graph.edges.get(source)?.has(slug)) incoming += 1;
      return [slug, incoming];
    }).sort((a, b) => b[1] - a[1] || graph.files.get(a[0]).localeCompare(graph.files.get(b[0]), 'ja'));
    let selected;
    for (const [candidate] of ranked) {
      const trialRoots = new Set(roots); trialRoots.delete(candidate);
      if (reachableFrom(trialRoots, graph.edges).size === graph.files.size) { selected = candidate; break; }
    }
    if (!selected) break;
    roots.delete(selected); removed.add(selected);
    afterText = removeEntries(graph.indexText, removed);
  }
  return {
    directory, budget, beforeText: graph.indexText, afterText, removed,
    removedFiles: [...removed].map((slug) => graph.files.get(slug)),
    remainingEntries: graph.parsed.entries.length - removed.size,
    reached: reachableFrom(roots, graph.edges), totalFiles: graph.files.size,
    ...byteStats(graph.indexText, afterText),
  };
}

function stamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

function sleepForTest() {
  const ms = Number(process.env.MEMORY_INDEX_TEST_PREWRITE_DELAY_MS ?? 0);
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function applyPlan(directory, options = {}) {
  const indexPath = path.join(directory, 'MEMORY.md');
  const firstBuffer = fs.readFileSync(indexPath);
  const firstStat = fs.statSync(indexPath);
  const plan = planApply(directory, options);
  if (!firstBuffer.equals(Buffer.from(plan.beforeText, 'utf8'))) throw new Error('計画中に MEMORY.md が変更されたため中止しました');
  if (plan.removed.size === 0) return { ...plan, backupPath: undefined };
  const backupPath = `${indexPath}.bak-${stamp()}`;
  fs.copyFileSync(indexPath, backupPath, fs.constants.COPYFILE_EXCL);
  sleepForTest();
  const current = fs.readFileSync(indexPath);
  const currentStat = fs.statSync(indexPath);
  if (!current.equals(firstBuffer) || current.length !== firstBuffer.length || currentStat.mtimeMs !== firstStat.mtimeMs) {
    throw new Error('書き込み直前に MEMORY.md のバイト数または mtime が変化したため、書かずに中止しました');
  }
  try {
    fs.writeFileSync(indexPath, plan.afterText, 'utf8');
    if (process.env.MEMORY_INDEX_TEST_CORRUPT_AFTER_WRITE === '1') fs.appendFileSync(indexPath, '\n破損注入');
    const actual = fs.readFileSync(indexPath);
    const actualText = actual.toString('utf8');
    const actualEntries = parseIndex(actualText).entries.map((entry) => entry.slug);
    const expectedEntries = parseIndex(plan.afterText).entries.map((entry) => entry.slug);
    const graph = readGraph(directory, actualText);
    const reached = reachableFrom(new Set(actualEntries.filter((slug) => graph.files.has(slug))), graph.edges);
    const problems = [];
    if (!actual.equals(Buffer.from(plan.afterText, 'utf8'))) problems.push('削除対象以外のバイト列が変化');
    if (actualEntries.join('\0') !== expectedEntries.join('\0')) problems.push('残ったエントリ集合が期待値と不一致');
    if (reached.size !== graph.files.size) problems.push('到達不能な memory が発生');
    if (actual.length > plan.budget) problems.push(`予算超過: ${actual.length} B > ${plan.budget} B`);
    if (problems.length) throw new Error(problems.join(' / '));
    return { ...plan, backupPath };
  } catch (error) {
    fs.copyFileSync(backupPath, indexPath);
    throw new Error(`適用後検証に失敗したためバックアップから復元しました: ${error.message}`);
  }
}

export function formatReport(result) {
  const unreachable = result.unreachableFiles.length ? result.unreachableFiles.map((name) => `- ${name}`).join('\n') : '- なし';
  const removable = result.removableFiles.length ? result.removableFiles.map((name) => `- ${name}`).join('\n') : '- なし';
  return [`総ファイル数: ${result.totalFiles}`, `索引エントリ数: ${result.indexEntries}`, `索引に無いファイル数: ${result.unindexedFiles}`, `索引から到達不能: ${result.unreachableFiles.length}件`, unreachable, `索引から安全に外せる候補: ${result.removableCount}件`, removable, `推定削減: ${result.savedBytes} B`, `削減後: ${result.afterBytes} B（現在 ${result.beforeBytes} B）`].join('\n');
}

function optionValue(argv, name) {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  if (!argv[index + 1] || argv[index + 1].startsWith('--')) throw new Error(`${name} の値が必要です`);
  return argv[index + 1];
}

function parseNonNegativeInteger(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) throw new Error(`${name} は0以上の整数にしてください`);
  return number;
}

function allMemoryDirectories() {
  const projectsDir = path.join(os.homedir(), '.claude', 'projects');
  if (!fs.existsSync(projectsDir)) return [];
  return fs.readdirSync(projectsDir, { withFileTypes: true })
    .filter((item) => item.isDirectory())
    .map((item) => path.join(projectsDir, item.name, 'memory'))
    .filter((directory) => fs.existsSync(path.join(directory, 'MEMORY.md')))
    .map((directory) => ({ directory, mtime: fs.statSync(path.dirname(directory)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .map((candidate) => candidate.directory);
}

function processDirectory(directory, { apply, dryRun, budget, minBytes, keepFile }) {
  const indexPath = path.join(directory, 'MEMORY.md');
  const beforeBytes = fs.statSync(indexPath).size;
  if (beforeBytes <= minBytes) {
    console.log(`しきい値未満のためスキップ: ${indexPath}`);
    return { directory, skipped: true, reason: 'min-bytes', beforeBytes };
  }
  if (apply || dryRun) {
    const result = apply ? applyPlan(directory, { budget, keepFile }) : planApply(directory, { budget, keepFile });
    console.log(`${apply ? '適用完了' : 'ドライラン'}: ${indexPath}: 削除 ${result.removed.size}件 / ${result.beforeBytes} B -> ${result.afterBytes} B / 残エントリ ${result.remainingEntries}件`);
    return result;
  }
  const result = analyze(directory);
  return result;
}

export function run(argv = process.argv.slice(2)) {
  const valued = new Set(['--dir', '--budget', '--keep-file', '--min-bytes']);
  const known = new Set(['--report', '--json', '--apply', '--dry-run', '--all-projects', ...valued]);
  for (let i = 0; i < argv.length; i += 1) { if (!known.has(argv[i])) throw new Error(`不明なオプションです: ${argv[i]}`); if (valued.has(argv[i])) i += 1; }
  if (argv.includes('--apply') && argv.includes('--dry-run')) throw new Error('--apply と --dry-run は同時に指定できません');
  if (argv.includes('--report') && argv.includes('--json')) throw new Error('--report と --json は同時に指定できません');
  const directoryOption = optionValue(argv, '--dir');
  const allProjects = argv.includes('--all-projects');
  if (directoryOption && allProjects) throw new Error('--dir と --all-projects は同時に指定できません');
  const directories = directoryOption ? [path.resolve(directoryOption)] : allMemoryDirectories();
  if (!directories.length) {
    console.log('対象の MEMORY.md はありません');
    return [];
  }
  const targets = allProjects ? directories : [directories[0]];
  const budget = parseNonNegativeInteger(optionValue(argv, '--budget') ?? '15000', '--budget');
  const minBytes = parseNonNegativeInteger(optionValue(argv, '--min-bytes') ?? '16000', '--min-bytes');
  const options = { apply: argv.includes('--apply'), dryRun: argv.includes('--dry-run'), budget, minBytes, keepFile: path.resolve(optionValue(argv, '--keep-file') ?? DEFAULT_KEEP) };
  const results = [];
  const failures = [];
  for (const directory of targets) {
    try { results.push(processDirectory(directory, options)); }
    catch (error) {
      if (!allProjects) throw error;
      failures.push({ directory, error });
      console.error(`処理失敗: ${directory}: ${error.message}`);
    }
  }
  if (failures.length) throw new Error(`全プロジェクト処理: ${failures.length}件失敗`);
  if (!options.apply && !options.dryRun) {
    if (argv.includes('--json')) console.log(JSON.stringify(allProjects ? results : results[0], null, 2));
    else for (const result of results) if (!result.skipped) console.log(formatReport(result));
  }
  if (results.every((result) => result.skipped)) console.log('処理対象なし');
  return allProjects ? results : results[0];
}

if (isEntry(import.meta.url)) {
  try { run(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
