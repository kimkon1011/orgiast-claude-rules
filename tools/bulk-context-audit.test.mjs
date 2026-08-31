import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectBulkPayloads, estimateTokens, getBulkKind, groupPayloads, normalizeSignature, stripLineNumbers } from './bulk-context-audit.mjs';

const pad = (text) => text + ' '.repeat(Math.max(0, 2100 - text.length));
const csv = pad(Array.from({ length: 6 }, (_, i) => `${i},name-${i},value-${i}`).join('\n'));

test('CSV 6行を検出する', () => assert.equal(getBulkKind(csv), 'csv'));

test('長いJavaScriptソースコードを除外する', () => {
  const source = `export function calculate(value) {\n  if (value > 10) return value * 2;\n  return value;\n}\n`.repeat(40);
  assert.ok(source.length > 2000);
  assert.equal(getBulkKind(source), null);
});

test('列構造のない長いログを除外する', () => {
  const logs = Array.from({ length: 80 }, (_, i) => `INFO request completed successfully for worker ${i}`).join('\n');
  assert.ok(logs.length > 2000);
  assert.equal(getBulkKind(logs), null);
});

test('オブジェクト6個のJSON配列を検出する', () => {
  const json = pad(JSON.stringify(Array.from({ length: 6 }, (_, id) => ({ id, name: `record-${id}` }))));
  assert.equal(getBulkKind(json), 'json-array');
});

test('閾値未満は除外する', () => assert.equal(getBulkKind('a,b,c\n'.repeat(6)), null));

test('ASCIIと日本語を別の密度で推定する', () => {
  assert.equal(estimateTokens('a'.repeat(16)), 4);
  assert.equal(estimateTokens('日'.repeat(16)), 10);
});

function fakeHome(rows) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bulk-context-audit-'));
  const dir = path.join(home, '.claude', 'projects', 'project-one');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '9c064232-full.jsonl'), rows.join('\n'));
  return home;
}

test('後続assistant 3行を増幅に反映し、壊れたJSON行を無視する', async (t) => {
  const timestamp = '2026-08-20T00:00:00.000Z';
  const rows = [
    JSON.stringify({ type: 'assistant', timestamp, message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'node tools/foo.mjs --date 2026-08-20 --limit 12345' } }] } }),
    '{broken json',
    JSON.stringify({ type: 'user', timestamp, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: csv }] } }),
    ...Array.from({ length: 3 }, () => JSON.stringify({ type: 'assistant', timestamp, message: { content: 'ok' } })),
  ];
  const home = fakeHome(rows); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const payloads = await collectBulkPayloads({ home, days: 30, now: Date.parse('2026-08-21T00:00:00Z') });
  assert.equal(payloads.length, 1);
  assert.equal(payloads[0].amplifiedTokens, payloads[0].tokens * 3);
});

test('日付と数値を伏せた同一コマンドが同じグループになる', () => {
  const a = normalizeSignature('node tools/foo.mjs --date 2026-08-20 --limit 12345');
  const b = normalizeSignature('node tools/foo.mjs --date 2026-08-21 --limit 67890');
  assert.equal(a, b);
  const groups = groupPayloads([
    { kind: 'csv', tool: 'Bash', signature: a, tokens: 10, amplifiedTokens: 20, timestamp: '2026-08-20T00:00:00Z', session: 'one' },
    { kind: 'csv', tool: 'Bash', signature: b, tokens: 10, amplifiedTokens: 30, timestamp: '2026-08-21T00:00:00Z', session: 'two' },
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].hits, 2);
});

test('Readの行番号プレフィックスを剥がしてからtsv判定する', () => {
  // Read の出力は「行番号<TAB>本文」。剥がさないと全 Read 結果が tsv 誤検出になる。
  const source = Array.from({ length: 80 }, (_, i) => `${i + 1}\tconst value${i} = compute(${i}); // 長めのソース行を並べて閾値を超えさせる`).join('\n');
  assert.ok(source.length > 2000);
  assert.equal(getBulkKind(source), null);
  assert.equal(stripLineNumbers(source).split('\n')[0], 'const value0 = compute(0); // 長めのソース行を並べて閾値を超えさせる');
  // 本物の TSV は行番号を剥がしても検出されること
  const tsv = Array.from({ length: 40 }, (_, i) => `${i + 1}\t案件${i}\t${i * 1000}\t進行中`).join('\n');
  assert.equal(getBulkKind(tsv, 200), 'tsv');
});
