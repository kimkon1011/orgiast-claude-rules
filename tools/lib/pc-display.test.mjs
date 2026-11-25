import test from 'node:test';
import assert from 'node:assert/strict';

import { displayPcNames } from './pc-display.mjs';

const pcMap = {
  '018': { hostname: '018', remoteName: '作業用018', aliases: ['18'] },
  '019': { hostname: '019', remoteName: '作業用019', aliases: ['19'] },
  'kim-PC': { hostname: 'DESKTOP-2D0R4LI', sheetName: '作業用001', aliases: [] },
};

test('本文中のバージョン番号を PC 名として置換しない', () => {
  const text = '学会AI秘書 PR #8（Next.js 15 / React 19 移行）';
  assert.equal(displayPcNames(text, { pcMap }), text);
});

test('PC 文脈のない数字を置換しない', () => {
  for (const text of ['PR #19', '1,019 円', '2026-11-19', 'v18.19.0']) {
    assert.equal(displayPcNames(text, { pcMap }), text);
  }
});

test('PC 文脈語に続く数字は塊全体を人間向け名称に置換する', () => {
  assert.equal(displayPcNames('PC018 で実行', { pcMap }), '作業用018 で実行');
  assert.equal(displayPcNames('PC 019 で実行', { pcMap }), '作業用019 で実行');
});

test('英字入り hostname は従来どおり置換する', () => {
  assert.equal(displayPcNames('DESKTOP-2D0R4LI が落ちた', { pcMap }), '作業用001 が落ちた');
});

test('既に人間向け名称になっている文字列を二重置換しない', () => {
  assert.equal(displayPcNames('作業用018 の席', { pcMap }), '作業用018 の席');
});

test('空の pcMap では入力をそのまま返す', () => {
  assert.equal(displayPcNames('React 19', { pcMap: {} }), 'React 19');
});

test('null と undefined は空文字列を返す', () => {
  assert.equal(displayPcNames(null, { pcMap }), '');
  assert.equal(displayPcNames(undefined, { pcMap }), '');
});
