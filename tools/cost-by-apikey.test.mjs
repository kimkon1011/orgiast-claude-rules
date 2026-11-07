import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateCostUsd, aggregate } from './cost-by-apikey.mjs';

test('estimateCostUsd: opus 1M uncached + 1M out = $30', () => {
  const cost = estimateCostUsd('claude-opus-5-5', {
    uncached_input_tokens: 1_000_000,
    cache_read_input_tokens: 0,
    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
    output_tokens: 1_000_000,
  });
  assert.equal(cost, 30); // 5 (input) + 25 (output) = 30
});

test('estimateCostUsd: cache 5m write 1M opus = $6.25', () => {
  const cost = estimateCostUsd('claude-opus-5-5', {
    uncached_input_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation: { ephemeral_5m_input_tokens: 1_000_000, ephemeral_1h_input_tokens: 0 },
    output_tokens: 0,
  });
  assert.equal(cost, 6.25); // 5 × 1.25 = 6.25
});

test('estimateCostUsd: cache read 1M opus = $0.50', () => {
  const cost = estimateCostUsd('claude-opus-5-5', {
    uncached_input_tokens: 0,
    cache_read_input_tokens: 1_000_000,
    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
    output_tokens: 0,
  });
  assert.equal(cost, 0.5); // 5 × 0.1 = 0.5
});

test('estimateCostUsd: cache 1h write 1M opus = $10', () => {
  const cost = estimateCostUsd('claude-opus-5-5', {
    uncached_input_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1_000_000 },
    output_tokens: 0,
  });
  assert.equal(cost, 10); // 5 × 2 = 10
});

test('estimateCostUsd: sonnet pricing', () => {
  const cost = estimateCostUsd('claude-sonnet-5-5', {
    uncached_input_tokens: 1_000_000,
    cache_read_input_tokens: 0,
    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
    output_tokens: 1_000_000,
  });
  assert.equal(cost, 18); // 3 (input) + 15 (output) = 18
});

test('estimateCostUsd: haiku pricing', () => {
  const cost = estimateCostUsd('claude-haiku-4-5', {
    uncached_input_tokens: 1_000_000,
    output_tokens: 1_000_000,
  });
  assert.equal(cost, 6); // 1 + 5 = 6
});

test('estimateCostUsd: fable pricing', () => {
  const cost = estimateCostUsd('claude-fable-5-1', {
    uncached_input_tokens: 1_000_000,
    output_tokens: 1_000_000,
  });
  assert.equal(cost, 60); // 10 + 50 = 60
});

test('estimateCostUsd: unknown model falls back to sonnet pricing', () => {
  const cost = estimateCostUsd('unknown-model-v1', {
    uncached_input_tokens: 1_000_000,
    output_tokens: 1_000_000,
  });
  assert.equal(cost, 18); // 3 + 15 = 18
});

test('estimateCostUsd: all zeros', () => {
  const cost = estimateCostUsd('claude-opus-5-5', {
    uncached_input_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
    output_tokens: 0,
  });
  assert.equal(cost, 0);
});

test('aggregate: 2日 × 2キーのダミーバケット', () => {
  const buckets = [
    {
      starting_at: '2026-11-01T00:00:00Z',
      ending_at: '2026-11-02T00:00:00Z',
      results: [
        { api_key_id: 'apikey_01ABC', model: 'claude-opus-5-5', uncached_input_tokens: 1_000_000, cache_read_input_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 }, output_tokens: 1_000_000 },
        { api_key_id: 'apikey_01XYZ', model: 'claude-sonnet-5-5', uncached_input_tokens: 1_000_000, cache_read_input_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 }, output_tokens: 1_000_000 },
      ],
    },
    {
      starting_at: '2026-11-02T00:00:00Z',
      ending_at: '2026-11-03T00:00:00Z',
      results: [
        { api_key_id: 'apikey_01ABC', model: 'claude-opus-5-5', uncached_input_tokens: 500_000, cache_read_input_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 }, output_tokens: 500_000 },
      ],
    },
  ];
  const keyNames = new Map([
    ['apikey_01ABC', 'Dev Key'],
    ['apikey_01XYZ', 'Prod Key'],
  ]);
  const result = aggregate(buckets, keyNames);

  // キー別合計の検証
  const devKey = result.get('apikey_01ABC');
  assert.ok(devKey, 'Dev Key should exist');
  assert.equal(devKey.name, 'Dev Key');
  // Day1: 1M in + 1M out = $30, Day2: 0.5M in + 0.5M out = $15 → total $45
  assert.ok(Math.abs(devKey.total - 45) < 0.001, `Dev Key total should be ~$45, got $${devKey.total}`);

  const prodKey = result.get('apikey_01XYZ');
  assert.ok(prodKey, 'Prod Key should exist');
  assert.equal(prodKey.name, 'Prod Key');
  // Day1: 1M in + 1M out = $18
  assert.ok(Math.abs(prodKey.total - 18) < 0.001, `Prod Key total should be ~$18, got $${prodKey.total}`);
});

test('aggregate: null api_key_id 表示', () => {
  const buckets = [
    {
      starting_at: '2026-11-01T00:00:00Z',
      ending_at: '2026-11-02T00:00:00Z',
      results: [
        { api_key_id: null, model: 'claude-sonnet-5-5', uncached_input_tokens: 100_000, cache_read_input_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 }, output_tokens: 50_000 },
      ],
    },
  ];
  const keyNames = new Map();
  const result = aggregate(buckets, keyNames);

  // null キーは __null__ で集計される
  const nullEntry = result.get('__null__');
  assert.ok(nullEntry, 'Null key entry should exist');
  assert.equal(nullEntry.name, '(キーなし: Console/Workbench等)');
  const expected = (100_000 / 1_000_000) * 3 + (50_000 / 1_000_000) * 15; // 0.3 + 0.75 = 1.05
  assert.ok(Math.abs(nullEntry.total - expected) < 0.001, `Null key total should be ~$${expected}, got $${nullEntry.total}`);
});