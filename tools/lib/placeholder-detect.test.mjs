import test from 'node:test';
import assert from 'node:assert/strict';
import { detectPlaceholders } from './placeholder-detect.mjs';

test('正常な本文はplaceholders無し', () => {
  const result = detectPlaceholders('こんにちは、お世話になっております。');
  assert.equal(result.hasPlaceholder, false);
  assert.deepEqual(result.matches, []);
});

test('URLを含む正常な本文も問題なし', () => {
  const result = detectPlaceholders('URLは https://example.com です');
  assert.equal(result.hasPlaceholder, false);
});

test('[REDACTED] を検出', () => {
  const result = detectPlaceholders('トークン: [REDACTED]');
  assert.equal(result.hasPlaceholder, true);
  assert.ok(result.matches.some(m => m.includes('[REDACTED]')));
});

test('Webhook URLの[REDACTED]を検出', () => {
  const result = detectPlaceholders('https://discord.com/api/webhooks/123456789012345678/[REDACTED]');
  assert.equal(result.hasPlaceholder, true);
  assert.ok(result.matches.some(m => m.includes('[REDACTED]')));
});

test('*** を含むURLを検出', () => {
  const result = detectPlaceholders('https://discord.com/api/webhooks/123/***');
  assert.equal(result.hasPlaceholder, true);
  assert.ok(result.matches.some(m => m.includes('***')));
});

test('未置換の波かっこ変数を検出', () => {
  const result = detectPlaceholders('Webhook: {WEBHOOK_URL}');
  assert.equal(result.hasPlaceholder, true);
  assert.ok(result.matches.some(m => m.includes('{WEBHOOK_URL}')));
});

test('「別途お伝えします」を検出', () => {
  const result = detectPlaceholders('URLは(別途お伝えします)');
  assert.equal(result.hasPlaceholder, true);
  assert.ok(result.matches.some(m => m.includes('別途')));
});

test('「別途」の鍵括弧版を検出', () => {
  const result = detectPlaceholders('URLは「別途お伝えします」');
  assert.equal(result.hasPlaceholder, true);
  assert.ok(result.matches.some(m => m.includes('別途')));
});

test('空の波かっこを検出', () => {
  const result = detectPlaceholders('値: {}');
  assert.equal(result.hasPlaceholder, true);
});

test('TODO を検出', () => {
  const result = detectPlaceholders('TODO: 本文を書く');
  assert.equal(result.hasPlaceholder, true);
});

test('FIXME を検出', () => {
  const result = detectPlaceholders('FIXME: 差し替えが必要');
  assert.equal(result.hasPlaceholder, true);
});

test('placeholders は最大5件まで', () => {
  const result = detectPlaceholders('[REDACTED] aaa {X} bbb TODO ccc FIXME ddd {Y} eee');
  assert.ok(result.matches.length <= 5);
  assert.equal(result.hasPlaceholder, true);
});

test('<redacted> を検出（大文字小文字不問）', () => {
  const result = detectPlaceholders('token is <redacted>');
  assert.equal(result.hasPlaceholder, true);
  assert.ok(result.matches.some(m => m.includes('redacted')));
});