import test from 'node:test';
import assert from 'node:assert/strict';
import { checkSchema } from './json-schema-check.mjs';

const schema = { type: 'object', required: ['rows'], additionalProperties: false, properties: {
  rows: { type: 'array', items: { type: 'object', required: ['n', 'status', 'date'], additionalProperties: false,
    properties: { n: { type: ['integer', 'null'], minimum: 0 }, status: { type: 'string', enum: ['ok'] }, date: { type: 'string', pattern: '^2026-' } } } },
} };
test('サブセットの正常例とnullableを検証する', () => {
  assert.deepEqual(checkSchema(schema, { rows: [{ n: null, status: 'ok', date: '2026-11-27' }, { n: 0, status: 'ok', date: '2026-12-01' }] }), []);
});
test('type・required・items・enum・追加キー・minimum・patternの違反を検出する', () => {
  for (const value of [null, {}, { rows: 'bad' }, { rows: [], extra: true },
    { rows: [null] }, { rows: [{}] }, { rows: [{ n: -1, status: 'bad', date: '2025-' }] },
    { rows: [{ n: 0.5, status: 'ok', date: '2026-', extra: true }] }]) assert.ok(checkSchema(schema, value).length);
  assert.ok(checkSchema({ type: 'number' }, NaN).length);
  assert.ok(checkSchema({ type: 'number' }, Infinity).length);
  assert.ok(checkSchema({ type: 'boolean' }, 1).length);
});
test('未対応キーワードを黙って通さない', () => {
  assert.throws(() => checkSchema({ type: 'string', minLength: 1 }, ''), /Unsupported/);
});
