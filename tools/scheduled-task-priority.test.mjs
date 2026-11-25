import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const self = fileURLToPath(import.meta.url);
const excluded = new Set(['.git', 'node_modules', 'fixtures']);

function* scripts(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory() && !excluded.has(entry.name)) yield* scripts(file);
    if (entry.isFile() && file !== self && /\.(ps1|mjs)$/i.test(entry.name)) yield file;
  }
}

function* missingPriority(source, embedded = false) {
  // Each candidate starts a PowerShell command, including commands embedded in JS strings.
  const call = /(?:^|[=;&|({]|\\n|\\r|["'`])\s*(?:&\s*)?(?<command>New-ScheduledTaskSettingsSet)\b(?=[ \t\r\n`;)\]|]|\\[nr]|$)/gim;
  for (const match of source.matchAll(call)) {
    const offset = match.index + match[0].length - match.groups.command.length;
    const lineStart = source.lastIndexOf('\n', offset - 1) + 1;
    if (/^\s*#/.test(source.slice(lineStart, offset))) continue;

    const args = source.slice(offset + match.groups.command.length);
    const tokens = /`\r?\n|\r?\n|\\[nr]|#[^\r\n]*|'(?:[^']|'')*'|"(?:[^"`]|\`[\s\S])*"|[(){};|&]|-Priority(?=[:\s;|)&}]|$)|[^]/gi;
    let depth = 0;
    let hasPriority = false;
    for (const { 0: token, index } of args.matchAll(tokens)) {
      if (depth === 0 && (/^[\r\n;|&)}#]/.test(token) || (embedded && /^(?:\\[nr]|`)$/.test(token)))) break;
      if (token === '(' || token === '{') depth++;
      if (token === ')' || token === '}') depth--;
      if (depth === 0 && /^-priority$/i.test(token) && /\s/.test(args[index - 1] ?? '')) hasPriority = true;
    }
    if (!hasPriority) yield source.slice(0, offset).split('\n').length;
  }
}

test('every New-ScheduledTaskSettingsSet call specifies -Priority', () => {
  const violations = [];
  for (const file of scripts(root)) {
    const source = readFileSync(file, 'utf8');
    if (!/New-ScheduledTaskSettingsSet/i.test(source)) continue;
    for (const line of missingPriority(source, file.endsWith('.mjs'))) {
      violations.push(`${path.relative(root, file)}:${line}`);
    }
  }
  assert.equal(violations.length, 0, `-Priority がない定期タスク設定:\n${violations.sort().join('\n')}`);
});

test('checks each invocation, ignoring quoted and commented arguments', () => {
  const source = [
    '$good = New-ScheduledTaskSettingsSet `',
    '  -Priority 4',
    '$bad = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 1) # -Priority 4',
    '$alsoBad = New-ScheduledTaskSettingsSet -Option "-Priority 4"; $x = New-ScheduledTaskSettingsSet -Priority:4',
    '# $ignored = New-ScheduledTaskSettingsSet',
  ].join('\n');
  assert.deepEqual([...missingPriority(source)], [3, 4]);
  assert.deepEqual([...missingPriority('const code = `$s=New-ScheduledTaskSettingsSet\\n$x=New-ScheduledTaskSettingsSet -Priority 4;`;', true)], [1]);
});
