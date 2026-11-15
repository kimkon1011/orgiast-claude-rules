import assert from 'node:assert/strict';
import test from 'node:test';

import { analyzeSite, buildDraft } from './analyze.mjs';

const company = { name: 'Fiction Forge', website: 'https://fiction-forge.invalid' };
const extraction = { sells: '架空の分析装置', buyer: '研究所', reason: '検査時間を短縮できる' };

test('C5: サイト文面から抽出した3項目を返しスタブを各1回呼ぶ', async () => {
  const calls = { fetch: 0, extract: 0 };
  const result = await analyzeSite(company, {
    fetchSite: async (url) => { calls.fetch += 1; assert.equal(url, company.website); return 'site text'; },
    extract: async (text) => { calls.extract += 1; assert.equal(text, 'site text'); return extraction; },
  });
  assert.deepEqual(result, { name: company.name, ...extraction, error: null });
  assert.deepEqual(calls, { fetch: 1, extract: 1 });
});

test('C5: website null は外部スタブを呼ばずnull値とerrorを返す', async () => {
  let calls = 0;
  const result = await analyzeSite({ name: 'No Web', website: null }, {
    fetchSite: async () => { calls += 1; }, extract: async () => { calls += 1; },
  });
  assert.deepEqual(result, { name: 'No Web', sells: null, buyer: null, reason: null, error: 'website is missing' });
  assert.equal(calls, 0);
});

test('C5: fetch reject は落ちず抽出を呼ばない', async () => {
  let extracts = 0;
  const result = await analyzeSite(company, {
    fetchSite: async () => { throw new Error('offline'); },
    extract: async () => { extracts += 1; },
  });
  assert.equal(result.error, 'fetchSite failed: offline');
  assert.deepEqual([result.sells, result.buyer, result.reason], [null, null, null]);
  assert.equal(extracts, 0);
});

test('C5: extract 欠損項目だけをnullにする', async () => {
  const result = await analyzeSite(company, {
    fetchSite: async () => 'text', extract: async () => ({ sells: '製品', reason: '' }),
  });
  assert.deepEqual(result, { name: company.name, sells: '製品', buyer: null, reason: null, error: 'extract missing: buyer, reason' });
});

test('C5: 必須depsの欠落はTypeError', async () => {
  await assert.rejects(analyzeSite(company, { extract: async () => extraction }), TypeError);
  await assert.rejects(analyzeSite(company, { fetchSite: async () => 'text' }), TypeError);
});

test('C5: 5役職の文面は相互に異なり全分析項目と担当者名を含む', () => {
  const roles = ['VP Sales', 'BD責任者', 'CRO', '営業ディレクター', '創業者'];
  const drafts = roles.map((role) => buildDraft(role, extraction, '架空 太郎'));
  assert.equal(new Set(drafts).size, 5);
  for (const draft of drafts) for (const value of ['架空 太郎', ...Object.values(extraction)]) assert.match(draft, new RegExp(value));
});

test('C5: 役職の大文字小文字と空白を無視し未知役職には汎用文面を使う', () => {
  assert.equal(buildDraft('  vp SALES ', extraction, 'A'), buildDraft('VP Sales', extraction, 'A'));
  assert.match(buildDraft('Engineer', extraction, 'A'), /ご担当のお立場/);
});

test('C5: nullを省略し文字列nullまたはundefinedを出さない', () => {
  const draft = buildDraft('CRO', { sells: null, buyer: undefined, reason: null }, null);
  assert.doesNotMatch(draft, /null|undefined/);
});
