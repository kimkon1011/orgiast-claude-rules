import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeExhibitors } from './normalize.mjs';

test('C1: 全項目がある出展者を抽出する', () => {
  const raw = [{
    name: '  Aurora Anvil Labs  ',
    booth: ' A-12 ',
    description: ' 架空の企業 ',
    website: ' https://aurora-anvil.invalid ',
    ignored: '対象外',
  }];
  assert.deepEqual(normalizeExhibitors(raw), [{
    name: 'Aurora Anvil Labs',
    booth: 'A-12',
    description: '架空の企業',
    website: 'https://aurora-anvil.invalid',
  }]);
});

test('C1: 欠損と空文字を null にする', () => {
  assert.deepEqual(normalizeExhibitors([{ name: 'Paper Comet', booth: '  ', website: '' }]), [{
    name: 'Paper Comet', booth: null, description: null, website: null,
  }]);
});

test('C1: 大文字小文字と前後空白だけが違う社名を入力順の1件に統合し欠損を補完する', () => {
  const raw = [
    { name: '  Paper Comet Works ', booth: '', description: 'first description', website: 'https://first.invalid' },
    { name: 'paper comet works', booth: 'C-07', description: 'second description', website: 'https://second.invalid' },
    { name: 'Another Forge', booth: 'D-01' },
  ];
  assert.deepEqual(normalizeExhibitors(raw), [
    { name: 'Paper Comet Works', booth: 'C-07', description: 'first description', website: 'https://first.invalid' },
    { name: 'Another Forge', booth: 'D-01', description: null, website: null },
  ]);
});

test('C1: 空配列は空配列を返す', () => {
  assert.deepEqual(normalizeExhibitors([]), []);
});
