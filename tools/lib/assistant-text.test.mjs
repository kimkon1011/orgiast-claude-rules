import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { latestAssistantText, readAssistantText, readLastHumanText } from './assistant-text.mjs';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'assistant-text-'));
let sequence = 0;
const assistant = content => ({ type: 'assistant', message: { content } });
const textBlock = text => [{ type: 'text', text }];
const toolBlock = () => [{ type: 'tool_use', name: 'Bash', input: { command: 'true' } }];
function fixture(entries) {
  const file = path.join(tempRoot, `${sequence++}.jsonl`);
  fs.writeFileSync(file, entries.map(entry => typeof entry === 'string' ? entry : JSON.stringify(entry)).join('\n'));
  return file;
}

test('末尾が tool_use だけでも手前の assistant 本文を返す', () => {
  assert.equal(latestAssistantText(fixture([assistant(textBlock('本文')), assistant(toolBlock())])), '本文');
});

test('tool_use だけの assistant が5個連続しても手前の本文を返す', () => {
  assert.equal(latestAssistantText(fixture([assistant(textBlock('本文')), ...Array.from({ length: 5 }, () => assistant(toolBlock()))])), '本文');
});

test('末尾から100行以上前の本文を既定窓で返す', () => {
  const fillers = Array.from({ length: 120 }, (_, index) => ({ type: 'progress', index }));
  assert.equal(latestAssistantText(fixture([assistant(textBlock('遠い本文')), ...fillers])), '遠い本文');
});

test('sidechain の本文を無視してメイン本文を返す', () => {
  const sidechain = { ...assistant(textBlock('サブ本文')), isSidechain: true };
  assert.equal(latestAssistantText(fixture([assistant(textBlock('メイン本文')), sidechain])), 'メイン本文');
});

test('assistant が無ければ no-assistant-text', () => {
  assert.equal(readAssistantText(fixture([{ type: 'user', message: { content: '質問' } }])).reason, 'no-assistant-text');
});

test('存在しないパスは unreadable', () => {
  assert.equal(readAssistantText(path.join(tempRoot, 'missing.jsonl')).reason, 'unreadable');
});

test('空または undefined のパスは no-path', () => {
  assert.equal(readAssistantText('').reason, 'no-path');
  assert.equal(readAssistantText(undefined).reason, 'no-path');
});

test('壊れた JSON 行を無視して正しい本文を返す', () => {
  assert.equal(latestAssistantText(fixture([assistant(textBlock('本文')), '{broken json}'])), '本文');
});

test('content が文字列の assistant 本文を返す', () => {
  assert.equal(latestAssistantText(fixture([assistant('文字列本文')])), '文字列本文');
});

test('maxBytes 境界の先頭不完全行を捨てて本文を返す', () => {
  const wanted = JSON.stringify(assistant(textBlock('境界本文')));
  const file = path.join(tempRoot, `${sequence++}.jsonl`);
  fs.writeFileSync(file, `${'x'.repeat(500)}\n${wanted}\n`);
  const result = readAssistantText(file, { maxBytes: Buffer.byteLength(wanted) + 30 });
  assert.deepEqual({ text: result.text, reason: result.reason }, { text: '境界本文', reason: 'ok' });
});

test('tool_result を含む user エントリを飛ばす', () => {
  const file = fixture([
    { type: 'user', message: { content: '人間の依頼' } },
    { type: 'user', message: { content: [{ type: 'tool_result', content: '結果' }] } },
  ]);
  assert.equal(readLastHumanText(file).text, '人間の依頼');
});

test('機械生成プレフィックスの user エントリを飛ばす', () => {
  const file = fixture([
    { type: 'user', message: { content: [{ type: 'text', text: '人間の依頼' }] } },
    { type: 'user', message: { content: '  <system-reminder>自動注入</system-reminder>' } },
    { type: 'user', message: { content: 'Stop hook feedback: 自動注入' } },
  ]);
  assert.equal(readLastHumanText(file).text, '人間の依頼');
});

test('sidechain の user エントリを飛ばす', () => {
  const file = fixture([
    { type: 'user', message: { content: 'メイン依頼' } },
    { type: 'user', isSidechain: true, message: { content: 'sidechain依頼' } },
  ]);
  assert.equal(readLastHumanText(file).text, 'メイン依頼');
});

test('人間の user 発言が無ければ reason を返す', () => {
  const result = readLastHumanText(fixture([{ type: 'user', message: { content: '<local-command-caveat>自動</local-command-caveat>' } }]));
  assert.deepEqual({ text: result.text, reason: result.reason }, { text: '', reason: 'no-human-text' });
});
