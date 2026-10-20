#!/usr/bin/env node
// C④ 定期タスク移行のための棚卸し。register-*.ps1 から
// タスク名・時刻・繰り返し・実行対象を静的に抽出し、対応する .mjs の有無を数える。
// このツールは移行そのものではなく、`config/scheduled-tasks.json` の元データを作る。
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const TIME = /-At\s+['"]?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?['"]?/gi;
// Hashtable/pscustomobject definitions use `At = '04:10'` instead of `-At`.
const TIME_ASSIGN = /\bAt\s*=\s*['"](\d{1,2}):(\d{2})['"]/gi;
const EVERY = /-RepetitionInterval\s*\(New-TimeSpan\s+-Minutes\s+(\d+)\)/gi;
const NAME_ASSIGN = /\$taskName\s*=\s*['"]([^'"]+)['"]/gi;
const NAME_ARRAY = /\$names\s*=\s*@\(([^)]*)\)/gi;
const NAME_INLINE = /Register-ScheduledTask[^\r\n]*-TaskName\s+['"]([^'"]+)['"]/gi;
// `TaskName = 'X'` (pscustomobject) and `Name = 'X'` (hashtable) definitions.
const NAME_FIELD = /\bTaskName\s*=\s*['"]([^'"]+)['"]/gi;
const NAME_HASHTABLE = /\bName\s*=\s*['"](Orgiast[^'"]*)['"]/gi;
const TARGET = /tools[\\/][A-Za-z0-9_.-]+\.(?:mjs|ps1)/gi;
const SCRIPT_NAME = /\bScriptName\s*=\s*['"]([^'"]+\.(?:mjs|ps1))['"]/gi;

export function normalizeTime(hour, minute, meridiem) {
  let h = Number(hour);
  if (meridiem) {
    if (h < 1 || h > 12) throw new Error(`Invalid 12-hour time: ${hour}${meridiem}`);
    if (meridiem.toLowerCase() === 'pm' && h !== 12) h += 12;
    if (meridiem.toLowerCase() === 'am' && h === 12) h = 0;
  }
  if (h > 23) throw new Error(`Invalid hour: ${hour}`);
  return `${String(h).padStart(2, '0')}:${String(Number(minute ?? '0')).padStart(2, '0')}`;
}

export function parseRegisterPs1(text) {
  const taskNames = new Set();
  for (const match of text.matchAll(NAME_ASSIGN)) taskNames.add(match[1]);
  for (const match of text.matchAll(NAME_INLINE)) taskNames.add(match[1]);
  for (const match of text.matchAll(NAME_FIELD)) taskNames.add(match[1]);
  for (const match of text.matchAll(NAME_HASHTABLE)) taskNames.add(match[1]);
  for (const match of text.matchAll(NAME_ARRAY)) {
    for (const name of match[1].match(/['"]([^'"]+)['"]/g) ?? []) taskNames.add(name.slice(1, -1));
  }
  const times = new Set();
  for (const match of text.matchAll(TIME)) times.add(normalizeTime(match[1], match[2], match[3]));
  for (const match of text.matchAll(TIME_ASSIGN)) times.add(normalizeTime(match[1], match[2]));
  const every = new Set();
  // Only explicit repetition intervals count; -ExecutionTimeLimit -Minutes must not.
  for (const match of text.matchAll(EVERY)) every.add(Number(match[1]));
  const targets = new Set();
  for (const match of text.matchAll(TARGET)) targets.add(match[0].replaceAll('\\', '/'));
  for (const match of text.matchAll(SCRIPT_NAME)) targets.add(`tools/${match[1]}`);
  return {
    taskNames: [...taskNames].sort(),
    times: [...times].sort(),
    everyMinutes: [...every].sort((a, b) => a - b),
    targets: [...targets].sort(),
    windowsOnly: {
      schtasks: (text.match(/schtasks/gi) ?? []).length,
      taskkill: (text.match(/taskkill/gi) ?? []).length,
      registry: (text.match(/reg query|Get-ItemProperty/gi) ?? []).length,
    },
  };
}

export function inventory(root) {
  const toolsDir = path.join(root, 'tools');
  const files = fs.readdirSync(toolsDir)
    .filter(name => /^register-.*\.ps1$/.test(name))
    .sort();
  if (files.length === 0) throw new Error('measurement impossible: no register-*.ps1 under tools/');
  const items = files.map(ps1 => {
    const parsed = parseRegisterPs1(fs.readFileSync(path.join(toolsDir, ps1), 'utf8'));
    return {
      ps1,
      mjs: fs.existsSync(path.join(toolsDir, ps1.replace(/\.ps1$/, '.mjs'))),
      ...parsed,
    };
  });
  return {
    ps1Total: items.length,
    parsedTaskTotal: items.reduce((sum, item) => sum + item.taskNames.length, 0),
    filesWithMjs: items.filter(item => item.mjs).length,
    filesWithoutTaskName: items.filter(item => item.taskNames.length === 0).map(item => item.ps1),
    windowsOnlyTotals: {
      schtasks: items.reduce((sum, item) => sum + item.windowsOnly.schtasks, 0),
      taskkill: items.reduce((sum, item) => sum + item.windowsOnly.taskkill, 0),
      registry: items.reduce((sum, item) => sum + item.windowsOnly.registry, 0),
    },
    items,
  };
}

export function toMarkdown(result) {
  const rows = result.items.map(item => `| ${item.ps1} | ${item.taskNames.join(', ') || '**未抽出**'} | ${item.times.join(', ') || '-'} | ${item.everyMinutes.join(', ') || '-'} | ${item.targets.join(', ') || '-'} | ${item.mjs ? 'あり' : 'なし'} |`);
  return [
    '# 定期タスク棚卸し（C④-1）',
    '',
    `- register-*.ps1: ${result.ps1Total}`,
    `- 抽出したタスク名: ${result.parsedTaskTotal}`,
    `- 対応する .mjs がある ps1: ${result.filesWithMjs}/${result.ps1Total}`,
    `- タスク名を抽出できなかった ps1: ${result.filesWithoutTaskName.length === 0 ? '0' : result.filesWithoutTaskName.join(', ')}`,
    `- Windows 専用呼び出し（ps1 内の文字列数）: schtasks=${result.windowsOnlyTotals.schtasks} / taskkill=${result.windowsOnlyTotals.taskkill} / registry=${result.windowsOnlyTotals.registry}`,
    '',
    '| ps1 | タスク名 | 時刻 | 繰り返し(分) | 対象 | .mjs |',
    '| --- | --- | --- | --- | --- | --- |',
    ...rows,
    '',
  ].join('\n');
}

function cli(argv, root) {
  const result = inventory(root);
  if (argv.includes('--check')) {
    if (result.filesWithoutTaskName.length) {
      console.error(`task names not extracted: ${result.filesWithoutTaskName.join(', ')}`);
      return 1;
    }
    console.log(`task inventory OK: ps1=${result.ps1Total} tasks=${result.parsedTaskTotal} mjs=${result.filesWithMjs}`);
    return 0;
  }
  if (argv.includes('--write')) {
    const reports = path.join(root, 'reports');
    fs.mkdirSync(reports, { recursive: true });
    fs.writeFileSync(path.join(reports, 'linux-port-tasks.json'), `${JSON.stringify(result, null, 2)}\n`);
    fs.writeFileSync(path.join(reports, 'linux-port-tasks.md'), toMarkdown(result));
    console.log(`wrote reports/linux-port-tasks.{json,md} (ps1=${result.ps1Total} tasks=${result.parsedTaskTotal})`);
    return 0;
  }
  console.log(JSON.stringify(result, null, 2));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const root = path.resolve(import.meta.dirname, '..', '..');
    process.exitCode = cli(process.argv.slice(2), root);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}
