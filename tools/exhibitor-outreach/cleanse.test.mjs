import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { cleanseList } from './cleanse.mjs';

async function loadFixture(name) {
  return JSON.parse(await readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
}

test('C3: three categories are excluded with reasons and matched keywords', async () => {
  const companies = await loadFixture('cleanse-companies.json');
  const result = cleanseList(companies);

  assert.deepEqual(result.kept, [companies[0]]);
  assert.deepEqual(result.excluded, [
    { company: companies[1], reason: 'distributor', keyword: 'distribution' },
    { company: companies[2], reason: 'association', keyword: '協会' },
    { company: companies[3], reason: 'media', keyword: 'magazine' },
  ]);
});

test('C3: null fields do not fail and unmatched companies are kept in input order', () => {
  const companies = [
    { name: null, description: null },
    { name: 'Quartz Finch', description: null },
    { name: null, description: 'Makes fictional actuators' },
  ];
  assert.deepEqual(cleanseList(companies), { kept: companies, excluded: [] });
});

test('C3: the first declared category wins when multiple categories match', () => {
  const company = { name: 'Fictional Media Association', description: 'wholesale publisher' };
  assert.deepEqual(cleanseList([company]), {
    kept: [],
    excluded: [{ company, reason: 'distributor', keyword: 'wholesale' }],
  });
});

test('C3: holdout fixture follows the keyword rules', async () => {
  const companies = await loadFixture('cleanse-holdout.json');
  assert.deepEqual(cleanseList(companies), {
    kept: [companies[0], companies[3]],
    excluded: [
      { company: companies[1], reason: 'distributor', keyword: '卸' },
      { company: companies[2], reason: 'association', keyword: 'chamber of commerce' },
      { company: companies[4], reason: 'media', keyword: '新聞' },
    ],
  });
});
