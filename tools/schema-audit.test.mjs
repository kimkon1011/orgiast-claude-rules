// Schema audit tool tests
import assert from 'node:assert/strict';
import test from 'node:test';
import { extractJsonLd, normalizeSchema, validateSchema, SCHEMA_RULES } from './schema-audit.mjs';

test('extractJsonLd - finds single script', () => {
  const html = '<html><head><script type="application/ld+json">{"@type":"Organization","name":"Test"}</script></head></html>';
  const result = extractJsonLd(html);
  assert.equal(result.length, 1);
  assert.equal(result[0]['@type'], 'Organization');
});

test('extractJsonLd - finds multiple scripts', () => {
  const html = '<html><head>' +
    '<script type="application/ld+json">{"@type":"Organization","name":"A"}</script>' +
    '<script type="application/ld+json">{"@type":"WebSite","name":"B"}</script>' +
    '</head></html>';
  const result = extractJsonLd(html);
  assert.equal(result.length, 2);
});

test('extractJsonLd - no script tags', () => {
  const html = '<html><head></head><body>Hello</body></html>';
  const result = extractJsonLd(html);
  assert.equal(result.length, 0);
});

test('extractJsonLd - malformed JSON', () => {
  const html = '<html><head><script type="application/ld+json">{invalid}</script></head></html>';
  const result = extractJsonLd(html);
  assert.equal(result.length, 1);
  assert.equal(result[0]._parseError, true);
});

test('normalizeSchema - @graph expands to array', () => {
  const input = { '@graph': [{ '@type': 'A' }, { '@type': 'B' }] };
  const result = normalizeSchema(input);
  assert.equal(result.length, 2);
  assert.equal(result[0]['@type'], 'A');
});

test('normalizeSchema - single item wraps in array', () => {
  const input = { '@type': 'Organization' };
  const result = normalizeSchema(input);
  assert.equal(result.length, 1);
  assert.equal(result[0]['@type'], 'Organization');
});

test('validateSchema - Organization passes with required fields', () => {
  const items = [{ '@type': 'Organization', name: 'Test', url: 'https://test.com' }];
  const result = validateSchema(items);
  assert.equal(result[0].status, 'pass');
  assert.equal(result[0].missing.length, 0);
});

test('validateSchema - Organization fails without name', () => {
  const items = [{ '@type': 'Organization', url: 'https://test.com' }];
  const result = validateSchema(items);
  assert.equal(result[0].status, 'fail');
  assert.deepEqual(result[0].missing, ['name']);
});

test('validateSchema - unknown type', () => {
  const items = [{ '@type': 'UnknownType' }];
  const result = validateSchema(items);
  assert.equal(result[0].status, 'unknown');
});

test('validateSchema - multiple items', () => {
  const items = [
    { '@type': 'Organization', name: 'A', url: 'https://a.com' },
    { '@type': 'FAQPage', mainEntity: [] },
    { '@type': 'WebSite', name: 'B', url: 'https://b.com' },
  ];
  const result = validateSchema(items);
  assert.equal(result.length, 3);
  assert.equal(result.filter(r => r.status === 'pass').length, 3);
});

test('SCHEMA_RULES - all known types have rules', () => {
  const known = ['Organization', 'LocalBusiness', 'WebSite', 'FAQPage', 'Article', 'HowTo', 'Project', 'BreadcrumbList', 'Product', 'Offer', 'AggregateRating', 'Review', 'Brand', 'ItemList'];
  for (const t of known) {
    assert.ok(SCHEMA_RULES[t], `Missing rules for ${t}`);
    assert.ok(Array.isArray(SCHEMA_RULES[t].required), `required not array for ${t}`);
    assert.ok(Array.isArray(SCHEMA_RULES[t].recommended), `recommended not array for ${t}`);
  }
});

test('validateSchema - Product passes with required fields', () => {
  const items = [{ '@type': 'Product', name: 'Test Booth', description: 'A test booth' }];
  const result = validateSchema(items);
  assert.equal(result[0].status, 'pass');
  assert.equal(result[0].missing.length, 0);
});

test('validateSchema - Product fails without name', () => {
  const items = [{ '@type': 'Product', description: 'No name here' }];
  const result = validateSchema(items);
  assert.equal(result[0].status, 'fail');
  assert.deepEqual(result[0].missing, ['name']);
});

test('validateSchema - Offer passes with required fields', () => {
  const items = [{ '@type': 'Offer', price: '500000', priceCurrency: 'JPY' }];
  const result = validateSchema(items);
  assert.equal(result[0].status, 'pass');
});

test('validateSchema - Offer fails without price', () => {
  const items = [{ '@type': 'Offer', priceCurrency: 'JPY' }];
  const result = validateSchema(items);
  assert.equal(result[0].status, 'fail');
  assert.deepEqual(result[0].missing, ['price']);
});

test('validateSchema - AggregateRating passes with required fields', () => {
  const items = [{ '@type': 'AggregateRating', ratingValue: '4.5', ratingCount: '10', itemReviewed: { '@id': '#product' } }];
  const result = validateSchema(items);
  assert.equal(result[0].status, 'pass');
});

test('validateSchema - Review passes with required fields', () => {
  const items = [{ '@type': 'Review', reviewBody: 'Great product', author: { '@type': 'Person', name: 'Tester' }, itemReviewed: { '@id': '#product' } }];
  const result = validateSchema(items);
  assert.equal(result[0].status, 'pass');
});

test('validateSchema - Brand passes with required fields', () => {
  const items = [{ '@type': 'Brand', name: 'Test Brand' }];
  const result = validateSchema(items);
  assert.equal(result[0].status, 'pass');
});

test('validateSchema - ItemList passes with required fields', () => {
  const items = [{ '@type': 'ItemList', name: 'Services', itemListElement: [{ '@type': 'ListItem', position: 1, item: { '@type': 'Product', name: 'S1' } }] }];
  const result = validateSchema(items);
  assert.equal(result[0].status, 'pass');
});

test('validateSchema - LocalBusiness with missing address', () => {
  const items = [{ '@type': 'LocalBusiness', name: 'Test' }];
  const result = validateSchema(items);
  assert.equal(result[0].status, 'fail');
  assert.deepEqual(result[0].missing, ['address']);
});

test('validateSchema - recommends missing fields but not required', () => {
  const items = [{ '@type': 'Organization', name: 'Test', url: 'https://t.com' }];
  const result = validateSchema(items);
  assert.equal(result[0].status, 'pass');
  assert.ok(result[0].missingRecommended.length > 0);
  assert.ok(result[0].missingRecommended.includes('logo'));
});
