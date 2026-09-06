import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { compactHandoff, run } from './handoff-compact.mjs';

const MARKER = '<!-- NEXT-SESSION v1 -->';
const compact = (body) => compactHandoff(body, { now: new Date('2026-09-06T00:00:00.000Z') }).text;

test('✅ と取り消し線を含む完了行を削除する', () => {
  const output = compact(`${MARKER}\n## 残TODO\n- ✅ 完了\n- ~~取り消し線~~ の項目\n- 未完了\n`);
  assert.doesNotMatch(output, /✅|取り消し線/);
  assert.match(output, /- 未完了/);
});

test('箇条書き記号と ** だけが違う重複は長い原行を残す', () => {
  const output = compact(`${MARKER}\n## 残TODO\n- **同じ項目**\n1. 同じ項目\n`);
  assert.match(output, /- \*\*同じ項目\*\*/);
  assert.doesNotMatch(output, /1\. 同じ項目/);
});

test('正規化した文字列ではなく原文をそのまま出力する', () => {
  const original = '- **原文　の   空白**';
  const output = compact(`${MARKER}\n## 残TODO\n${original}\n* 原文 の 空白\n`);
  assert.match(output, new RegExp(original.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(output, /- 原文 の 空白\n/);
});

test('同名見出しを統合して配下の行を合流する', () => {
  const output = compact(`${MARKER}\n## 残TODO\n- A\n${MARKER}\n## 残TODO\n- B\n`);
  assert.equal((output.match(/^## 残TODO$/gm) ?? []).length, 1);
  assert.match(output, /## 残TODO\n- A\n- B/);
});

test('指定された優先順でセクションを並べ、その他を末尾に置く', () => {
  const output = compact(`${MARKER}\n## その他\n- Z\n## 未決\n- D\n## 残TODO\n- C\n## 次の1目的\n- B\n## 🔁 毎日進める継続タスク\n- A\n## 触る前に読む memory\n- E\n`);
  const headings = [...output.matchAll(/^## .+$/gm)].map((match) => match[0]);
  assert.deepEqual(headings, ['## 🔁 毎日進める継続タスク', '## 次の1目的', '## 残TODO', '## 未決', '## 触る前に読む memory', '## その他']);
});

test('--dry-run は入力も出力先も書き換えない', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-compact-'));
  const inputFile = path.join(directory, 'input.md');
  const outputFile = path.join(directory, 'output.md');
  const input = `${MARKER}\n## 残TODO\n- A\n`;
  fs.writeFileSync(inputFile, input);
  fs.writeFileSync(outputFile, 'unchanged');
  run(['--in', inputFile, '--out', outputFile, '--dry-run']);
  assert.equal(fs.readFileSync(inputFile, 'utf8'), input);
  assert.equal(fs.readFileSync(outputFile, 'utf8'), 'unchanged');
});

test('URL・PR番号・パス・長いIDを削除対象でない限り保持する', () => {
  const lines = [
    '- URL https://example.com/a?b=1#part',
    '- PR #123',
    String.raw`- path C:\Users\uers\project\tools\run.mjs`,
    '- GAS ID 1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789',
  ];
  const output = compact(`${MARKER}\n## 残TODO\n${lines.join('\n')}\n`);
  for (const line of lines) assert.ok(output.includes(line), `欠損: ${line}`);
});
