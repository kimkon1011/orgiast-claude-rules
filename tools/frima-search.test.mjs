// node --test tools/frima-search.test.mjs （ネットワーク不要）
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, collectItems } from './frima-search.mjs';

test('parseArgs: 数値・除外語・qty・言い換え語を解釈する', () => {
  const o = parseArgs(['32GB RDIMM|PC4 32GB', '--min', '1000', '--max', '9000', '--exclude', 'ジャンク,部品', '--qty', '4', '--include-sold']);
  assert.equal(o.keyword, '32GB RDIMM|PC4 32GB');
  assert.equal(o.min, 1000);
  assert.equal(o.max, 9000);
  assert.deepEqual(o.exclude, ['ジャンク', '部品']);
  assert.equal(o.qty, 4);
  assert.equal(o.includeSold, true);
  assert.equal(o.shops.length, 8);
});

test('parseArgs: 「|」で言い換え語に分割できる', () => {
  const o = parseArgs(['a|b | c']);
  assert.deepEqual(o.keyword.split('|').map(s => s.trim()).filter(Boolean), ['a', 'b', 'c']);
});

test('collectItems: 重複URL除去・売切除外・exclude・価格昇順', () => {
  const o = parseArgs(['x', '--exclude', 'ジャンク']);
  const results = [
    { shop: 'a', items: [{ url: 'u1', price: 3000, title: 'ok' }, { url: 'u2', price: 1000, title: 'ジャンク品' }, { url: 'u3', price: 500, title: 's', status: 'sold' }] },
    { shop: 'b', items: [{ url: 'u1', price: 3000, title: 'ok dup' }, { url: 'u4', price: 2000, title: 'ok2', status: 'on_sale' }] },
  ];
  const items = collectItems(results, o);
  assert.deepEqual(items.map(i => i.url), ['u4', 'u1']);
  const sold = collectItems(results, parseArgs(['x', '--include-sold']));
  assert.equal(sold.length, 4);
});

test('--qty: 最安 qty 件の合計', () => {
  const o = parseArgs(['x', '--qty', '2']);
  const items = collectItems([{ shop: 'a', items: [{ url: 'a', price: 300 }, { url: 'b', price: 100 }, { url: 'c', price: 200 }] }], o);
  assert.equal(items.slice(0, o.qty).reduce((s, it) => s + it.price, 0), 300);
});
