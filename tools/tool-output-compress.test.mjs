import test from 'node:test';
import assert from 'node:assert/strict';
import { compressOutput, compressionRatio, isCompressed } from './tool-output-compress.mjs';

test('short text is not compressed', () => {
  assert.equal(compressOutput('短い'), '短い');
});

test('repeated lines are collapsed', () => {
  const input = Array.from({ length: 20 }, () => '同じ行').join('\n');
  const result = compressOutput(input);
  assert.ok(result.includes('[['));
  assert.ok(result.includes('identical'));
  assert.ok(compressionRatio(input, result) < 0.5);
});

test('large JSON array is collapsed', () => {
  const items = Array.from({ length: 100 }, (_, i) => ({ id: i, name: `item-${i}` }));
  const input = JSON.stringify(items, null, 2);
  const result = compressOutput(input);
  assert.ok(result.includes('array elements collapsed'));
  assert.ok(compressionRatio(input, result) < 0.5);
});

test('large object with many keys is collapsed', () => {
  const obj = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`key-${i}`, `value-${i}`]));
  const input = JSON.stringify(obj, null, 2);
  const result = compressOutput(input);
  assert.ok(result.includes('keys collapsed'));
  assert.ok(compressionRatio(input, result) < 0.5);
});

test('CSV-like table with many rows is collapsed', () => {
  const header = 'id,name,value';
  const rows = Array.from({ length: 30 }, (_, i) => `${i},item-${i},${i * 10}`);
  const input = [header, ...rows].join('\n');
  const result = compressOutput(input);
  assert.ok(result.includes('rows collapsed'));
  assert.ok(compressionRatio(input, result) < 0.6);
});

test('error output is preserved when preserveErrors=true', () => {
  const input = Array.from({ length: 50 }, () => 'error line').join('\n');
  const result = compressOutput(input, { preserveErrors: true, hasError: true });
  assert.equal(result, input);
});

test('error output is compressed when preserveErrors=false even with hasError', () => {
  const input = Array.from({ length: 50 }, () => 'error line').join('\n');
  const result = compressOutput(input, { preserveErrors: false, hasError: true });
  assert.notEqual(result, input);
  assert.ok(isCompressed(result));
});

test('already compressed text is not re-compressed', () => {
  const already = 'head\n[[trimmed 500 chars]]\ntail';
  assert.equal(compressOutput(already), already);
});

test('compressionRatio returns 1 for empty/equal', () => {
  assert.equal(compressionRatio('', ''), 1);
  assert.equal(compressionRatio('hello', 'hello'), 1);
});

test('compressionRatio returns < 1 for compressed content', () => {
  const input = Array.from({ length: 100 }, () => 'same').join('\n');
  const result = compressOutput(input);
  assert.ok(compressionRatio(input, result) < 0.5);
});

test('isCompressed detects both trim markers and collapse markers', () => {
  assert.ok(isCompressed('foo\n[[trimmed 100 chars]]\nbar'));
  assert.ok(isCompressed('foo\n[[+ 5 similar lines]]'));
  assert.ok(isCompressed('foo\n[[+ 10 identical lines]]\nbar'));
  assert.ok(!isCompressed('normal text without markers'));
  assert.ok(!isCompressed(''));
});

test('maxTokens limit forces head+tail compression', () => {
  const input = Array.from({ length: 50 }, (_, i) => `行${i}: ` + '内容'.repeat(20)).join('\n');
  const result = compressOutput(input, { maxTokens: 20 });
  assert.ok(isCompressed(result));
  assert.ok(compressionRatio(input, result) < 0.5);
});

test('progressive pattern lines pass through if no exact repeats', () => {
  const lines = [];
  for (let i = 0; i < 15; i++) {
    lines.push(`[${i}] Processing item ${i}: status=${i % 2 === 0 ? 'ok' : 'pending'} timestamp=2026-11-16T12:${String(i).padStart(2, '0')}:00`);
  }
  const input = lines.join('\n');
  const result = compressOutput(input);
  // All lines are different, so they pass through without compression
  assert.equal(result.length, input.length);
  assert.equal(result, input);
});

test('identical consecutive lines are collapsed', () => {
  const input = Array.from({ length: 10 }, () => 'まったく同じ行').join('\n');
  const result = compressOutput(input);
  // The repeated line detection should find this
  assert.ok(result.includes('[['));
});