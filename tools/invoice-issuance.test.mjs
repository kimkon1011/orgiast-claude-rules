#!/usr/bin/env node
import test from 'node:test';
import assert from 'node:assert/strict';
import { invoiceKeywords, printProcedure } from './invoice-issuance.mjs';

test('invoiceKeywords returns expected list', () => {
  const kw = invoiceKeywords();
  assert.ok(kw.length >= 5, 'has enough keywords');
  assert.ok(kw.some(k => k === '請求書'), 'contains 請求書');
  assert.ok(kw.some(k => k === 'invoice'), 'contains invoice');
});

test('printProcedure returns markdown', () => {
  const md = printProcedure();
  assert.ok(md.startsWith('#'), 'starts with heading');
  assert.ok(md.includes('請求書'), 'contains invoice-related content');
  assert.ok(md.length > 500, 'has substantial content');
  assert.ok(md.includes('Phase_Invoice'), 'references invoice generation function');
  assert.ok(md.includes('tools/invoice-issuance.mjs'), 'self-references');
});

test('printProcedure contains key sections', () => {
  const md = printProcedure();
  const sections = ['提供機能', '夜間バッチ', '請求書テンプレート', '送付ルール', '関連ファイル', '参考 memory'];
  for (const section of sections) {
    assert.ok(md.includes(section), `contains section: ${section}`);
  }
});