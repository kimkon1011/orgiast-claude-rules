import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../src/Phase_AssignRequest.js', import.meta.url), 'utf8');
const context = {};
vm.createContext(context);
vm.runInContext(source, context);

test('車両判別は正規化した一致語と優先順位に従う', () => {
  const cases = [
    ['JITBOXで搬入します', 'JITBOX', ['JITBOX']],
    ['レンタカーを手配', 'レンタカー', ['レンタカー']],
    ['自社トラックのデュトロ', '自社トラック', ['自社トラック', 'デュトロ']],
    ['JITBOXかレンタカーのどちらか', 'JITBOX', ['JITBOX']],
    ['２トンロング', '自社トラック', ['2トン']],
    ['４トン', '自社トラック', ['4トン']],
    [' 自社便かレンタル ', 'レンタカー', ['レンタル']],
    [' ｊｉｔ　ｂｏｘ ', 'JITBOX', ['JIT BOX']],
    ['jit-box', 'JITBOX', ['JIT-BOX']],
    ['ジットボックス', 'JITBOX', ['ジットボックス']],
    ['', '不明', []], [null, '不明', []], [undefined, '不明', []],
    ['手配方法は未定', '不明', []]
  ];
  for (const [input, type, evidence] of cases) {
    const result = context.AssignRequest_detectVehicleOwnership(input);
    assert.equal(result.type, type);
    assert.deepEqual(Array.from(result.evidence), evidence);
  }
});

function makeRows() {
  return [
    { type: 'construction', values: ['施工スタッフ'] },
    { type: 'event', values: ['イベント関連'] }
  ];
}

test('除外指示は施工スタッフ行だけを取り除く', () => {
  const rows = makeRows();
  assert.deepEqual(context.AssignRequest_applyExclusions(rows, '除外:施工スタッフ'), [rows[1]]);
});

test('除外指示は複数の区切り文字と繰り返しに対応する', () => {
  for (const input of [
    '除外：イベント関連、施工スタッフ', '除外:施工スタッフ イベント関連',
    '除外:施工スタッフ　イベント関連', '除外:施工スタッフ,イベント関連',
    '除外:施工スタッフ\nイベント関連', '除外:施工スタッフ\n除外：イベント関連'
  ]) {
    assert.deepEqual(context.AssignRequest_applyExclusions(makeRows(), input), []);
  }
});

test('除外指定なしは全行を新しい配列で返し、元のデータを変更しない', () => {
  const rows = makeRows();
  const before = structuredClone(rows);
  for (const input of ['', undefined, null, '施工スタッフは確定', '除外:対象外']) {
    const result = context.AssignRequest_applyExclusions(rows, input);
    assert.deepEqual(result, before);
    assert.notEqual(result, rows);
  }
  context.AssignRequest_applyExclusions(rows, '除外:施工スタッフ');
  assert.deepEqual(rows, before);
});

test('別の文章で言及された職種を除外しない', () => {
  const rows = makeRows();
  assert.deepEqual(
    context.AssignRequest_applyExclusions(rows, '除外:施工スタッフ\n備考:イベント関連は必要'),
    [rows[1]]
  );
});

test('マニュアルに車両手配の判別ルールを含む', () => {
  assert.match(context._ASSIGN_MANUAL_NOTES, /JITBOX/);
  assert.match(context._ASSIGN_MANUAL_NOTES, /レンタカー/);
});
