import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { filterContacts } from './contacts.mjs';

const contact = (name, title = 'Founder') => ({ name, title });

test('C2: 従業員数の境界24/25/250/251を判定する', () => {
  const companies = [24, 25, 250, 251].map((employees) => ({
    name: `Company ${employees}`, employees, contacts: [contact(`Person ${employees}`)],
  }));
  assert.deepEqual(filterContacts(companies), [
    { name: 'Company 25', contacts: [contact('Person 25')] },
    { name: 'Company 250', contacts: [contact('Person 250')] },
  ]);
});

test('C2: 1社の該当者は入力順の先頭3人までにする', () => {
  const contacts = ['One', 'Two', 'Three', 'Four'].map((name) => contact(name, 'CRO'));
  assert.deepEqual(filterContacts([{ name: 'Lunar Loom', employees: 80, contacts }]), [{
    name: 'Lunar Loom', contacts: contacts.slice(0, 3),
  }]);
});

test('C2: 各対象役職を大文字小文字を無視して採用する', () => {
  const titles = [
    'vp sales', 'VP OF SALES', 'BD責任者', 'head of bd', 'cro',
    'CHIEF REVENUE OFFICER', '営業ディレクター', 'sales director',
    '創業者', 'founder', 'CO-FOUNDER',
  ];
  const companies = titles.map((title, index) => ({
    name: `Fictional ${index}`, employees: 100, contacts: [contact(`Person ${index}`, title)],
  }));
  assert.deepEqual(filterContacts(companies), companies.map(({ name, contacts }) => ({ name, contacts })));
});

test('C2: 非該当役職だけの会社を含めない', () => {
  assert.deepEqual(filterContacts([{
    name: 'Silent Quartz', employees: 50,
    contacts: [contact('Not Target', 'Account Executive')],
  }]), []);
});

test('C2: employees が文字列または undefined の会社を除外する', () => {
  assert.deepEqual(filterContacts([
    { name: 'String Staff', employees: '100', contacts: [contact('One')] },
    { name: 'Missing Staff', contacts: [contact('Two')] },
  ]), []);
});

test('C2: ホールドアウト fixture を仕様から導いた期待値で判定する', async () => {
  const fixtureUrl = new URL('./fixtures/holdout-contacts.json', import.meta.url);
  const companies = JSON.parse(await readFile(fixtureUrl, 'utf8'));
  assert.deepEqual(filterContacts(companies), [{
    name: 'Velvet Meteor Studio',
    contacts: [
      { name: '水野 架空', title: 'Head of BD' },
      { name: '森野 架空', title: 'CO-FOUNDER' },
    ],
  }]);
});
