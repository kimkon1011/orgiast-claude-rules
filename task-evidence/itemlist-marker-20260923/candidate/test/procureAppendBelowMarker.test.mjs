// マーカーより上のテンプレート空行を再利用せず、直下から追記することを守る。
// マーカー無しの既存シート、使用済み行、結合セルの扱いも実コードで検証する。
import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const source = fs.readFileSync(new URL('../src/Phase_ProcurementRequest.js', import.meta.url), 'utf8');
function extract(name) {
  const match = source.match(new RegExp('function ' + name + '\\([^]*?^\\}', 'm'));
  assert.ok(match, name + ' must exist');
  return match[0];
}
const { marker, pick } = eval('(() => {\n' +
  extract('_Procure_appendMarkerRow') + '\n' + extract('_Procure_pickWritableRow') +
  '\nreturn { marker: _Procure_appendMarkerRow, pick: _Procure_pickWritableRow }; })()');
const cols = { '品名': 7 };

function fakeSheet(data, merged = []) {
  const reads = [];
  return {
    reads,
    getLastRow: () => data.length,
    getLastColumn: () => Math.max(7, ...data.map(row => row.length)),
    getRange(row, col, numRows, numCols) {
      assert.ok(row >= 1 && col >= 1 && numRows > 0 && numCols > 0);
      return {
        getDisplayValues() {
          reads.push([row, col, numRows, numCols]);
          return Array.from({ length: numRows }, (_, r) =>
            Array.from({ length: numCols }, (_, c) => data[row - 1 + r]?.[col - 1 + c] ?? ''));
        },
        getMergedRanges() {
          return merged.filter(m => m.row <= row + numRows - 1 && m.endRow >= row &&
            m.col <= col + numCols - 1 && m.endCol >= col).map(m => ({
              getRow: () => m.row,
              getLastRow: () => m.endRow,
            }));
        },
      };
    },
  };
}

function markedData(text = '以下に追加ｱｲﾃﾑ情報を入力', col = 2) {
  const data = Array.from({ length: 7 }, () => Array(7).fill(''));
  data[3][col - 1] = text;
  return data;
}

test('テンプレートの3行目の空行を避け、マーカー直下の5行目を返す', () => {
  const used = new Set();
  assert.equal(pick(fakeSheet(markedData()), cols, used), 5);
  assert.ok(used.has(5));
});

test('マーカー無しは3行目から従来どおり探索する', () => {
  assert.equal(pick(fakeSheet([[], [], [], []]), cols, new Set()), 3);
  assert.equal(pick(fakeSheet([[], [], ['', '固定'], [], []]), cols, {}), 4);
});

test('マーカー下が埋まっていれば最終行の次に追記する', () => {
  const data = markedData();
  data[4][1] = '固定情報';
  data[5][5] = '固定品目';
  data[6][6] = '既存品名';
  assert.equal(pick(fakeSheet(data), cols, new Set()), 8);
});

test('Setに予約した行を避け、マーカーを再読込しない', () => {
  const sheet = fakeSheet(markedData());
  const used = new Set();
  assert.equal(pick(sheet, cols, used), 5);
  assert.equal(pick(sheet, cols, used), 6);
  assert.ok(used.has(6));
  assert.equal(used._procureAppendMarkerRow, 4);
  assert.equal(sheet.reads.filter(([row]) => row === 1).length, 1);
});

test('全角カナ・空白入りのマーカーも検出する', () => {
  for (const text of ['以下に追加アイテム情報を入力', '以 下\tに　追 加ｱｲﾃﾑ情報を入力']) {
    const sheet = fakeSheet(markedData(text));
    assert.equal(marker(sheet), 4);
    assert.equal(pick(sheet, cols, new Set()), 5);
  }
});

test('F列のマーカーを全列検索で検出する（最大2回読み取り）', () => {
  const sheet = fakeSheet(markedData('以下に追加ｱｲﾃﾑ情報を入力', 6));
  assert.equal(marker(sheet), 4);
  assert.equal(sheet.reads.length, 2);
  assert.equal(pick(sheet, cols, new Set()), 5);
});

test('マーカー行だけの結合は直下を妨げず、跨ぐ結合と直下の結合は除外する', () => {
  for (const [merged, expected] of [
    [[{ row: 4, endRow: 4, col: 2, endCol: 7 }], 5],
    [[{ row: 4, endRow: 5, col: 2, endCol: 7 }], 6],
    [[{ row: 5, endRow: 5, col: 6, endCol: 7 }], 6],
    [[{ row: 5, endRow: 6, col: 7, endCol: 7 }], 7],
  ]) {
    assert.equal(pick(fakeSheet(markedData(), merged), cols, new Set()), expected);
  }
});

test('マーカー無しは0、3行未満では読み取り不要', () => {
  const missing = fakeSheet([[], [], []]);
  assert.equal(marker(missing), 0);
  assert.equal(missing.reads.length, 2);
  for (const data of [[], [['', '以下に追加']], [[], []]]) {
    const sheet = fakeSheet(data);
    assert.equal(marker(sheet), 0);
    assert.equal(sheet.reads.length, 0);
  }
});

test('素のobjectでも予約行とマーカー無しの0キャッシュが有効', () => {
  const sheet = fakeSheet([[], [], [], []]);
  const used = {};
  assert.equal(pick(sheet, cols, used), 3);
  assert.equal(pick(sheet, cols, used), 4);
  assert.equal(used[3], true);
  assert.equal(used[4], true);
  assert.equal(used._procureAppendMarkerRow, 0);
  assert.equal(sheet.reads.filter(([row]) => row === 1).length, 2);
  const marked = {};
  assert.equal(pick(fakeSheet(markedData()), cols, marked), 5);
  assert.equal(pick(fakeSheet(markedData()), cols, marked), 6);
});

test('最終行がマーカーならその次へ追記し、予約済み追記行も避ける', () => {
  const sheet = fakeSheet(markedData().slice(0, 4));
  assert.equal(pick(sheet, cols, new Set()), 5);
  assert.equal(pick(sheet, cols, new Set([5, 6])), 7);
  assert.equal(pick(fakeSheet([]), cols, {}), 3);
});

test('B列の最初の一致を優先し、全列検索でも最初の一致を返す', () => {
  const data = markedData();
  data[2][5] = '以下に追加';
  data[5][1] = '以下に追加';
  const sheet = fakeSheet(data);
  assert.equal(marker(sheet), 4);
  assert.equal(sheet.reads.length, 1);
  data[3][1] = '';
  data[5][1] = '';
  assert.equal(marker(fakeSheet(data)), 3);
});

test('読み取り例外を握り、追記処理は従来の探索へ進める', () => {
  assert.equal(marker({ getLastRow() { throw new Error('unavailable'); } }), 0);
  const sheet = fakeSheet(markedData());
  const getRange = sheet.getRange;
  sheet.getRange = (row, ...args) => {
    if (row === 1) throw new Error('marker read failed');
    return getRange(row, ...args);
  };
  assert.equal(marker(sheet), 0);
  assert.equal(pick(sheet, cols, new Set()), 3);
});
