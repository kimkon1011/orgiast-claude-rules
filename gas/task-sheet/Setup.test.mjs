import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// _taskSheetEnsureTab_ / repairTaskSheetLayout は SpreadsheetApp を直接叩くので、
// 最小限のインメモリ Sheet で実際の行操作(insertRowBefore/deleteRow/setValues)まで
// 通してテストする。Health.test.mjs のような「純粋関数だけ読み込む」方式に加え、
// こちらは行のシフト・削除という副作用そのものが壊れていないかを検証する。

const dir = new URL('./', import.meta.url);
const FILES = ['Setup.gs', 'TaskSheetLayoutLogic.gs', 'TaskLedgerLogic.gs', 'TaskLedger.gs'];

class FakeRange {
  constructor(sheet, row, col, numRows, numCols) {
    Object.assign(this, { sheet, row, col, numRows, numCols });
  }
  getDisplayValues() {
    const out = [];
    for (let r = 0; r < this.numRows; r++) {
      const rowArr = [];
      for (let c = 0; c < this.numCols; c++) {
        const v = this.sheet.grid[this.row - 1 + r] && this.sheet.grid[this.row - 1 + r][this.col - 1 + c];
        rowArr.push(v === undefined || v === null ? '' : String(v));
      }
      out.push(rowArr);
    }
    return out;
  }
  setValues(values) {
    for (let r = 0; r < this.numRows; r++) {
      if (!this.sheet.grid[this.row - 1 + r]) this.sheet.grid[this.row - 1 + r] = [];
      for (let c = 0; c < this.numCols; c++) this.sheet.grid[this.row - 1 + r][this.col - 1 + c] = values[r][c];
    }
    this.sheet._recomputeBounds();
  }
  setValue(v) {
    if (!this.sheet.grid[this.row - 1]) this.sheet.grid[this.row - 1] = [];
    this.sheet.grid[this.row - 1][this.col - 1] = v;
    this.sheet._recomputeBounds();
  }
  clearContent() {
    for (let r = 0; r < this.numRows; r++) {
      if (!this.sheet.grid[this.row - 1 + r]) continue;
      for (let c = 0; c < this.numCols; c++) this.sheet.grid[this.row - 1 + r][this.col - 1 + c] = '';
    }
    this.sheet._recomputeBounds();
  }
}

class FakeSheet {
  constructor(name) { this.name = name; this.grid = []; this.lastRow = 0; this.lastColumn = 0; }
  getName() { return this.name; }
  _recomputeBounds() {
    let lastRow = 0, lastColumn = 0;
    this.grid.forEach((row, ri) => (row || []).forEach((cell, ci) => {
      if (cell !== undefined && cell !== null && cell !== '') {
        if (ri + 1 > lastRow) lastRow = ri + 1;
        if (ci + 1 > lastColumn) lastColumn = ci + 1;
      }
    }));
    this.lastRow = lastRow; this.lastColumn = lastColumn;
  }
  getLastRow() { return this.lastRow; }
  getLastColumn() { return this.lastColumn; }
  getRange(row, col, numRows, numCols) { return new FakeRange(this, row, col, numRows, numCols); }
  insertRowBefore(pos) { this.grid.splice(pos - 1, 0, []); this._recomputeBounds(); }
  deleteRow(pos) { this.grid.splice(pos - 1, 1); this._recomputeBounds(); }
  appendRow(rowArray) { this.grid.push(rowArray.slice()); this._recomputeBounds(); }
}

function makeContext() {
  const sheets = {};
  const context = {
    console,
    SpreadsheetApp: {
      getActiveSpreadsheet() {
        return {
          getSheetByName(n) { return sheets[n] || null; },
          insertSheet(n) { const s = new FakeSheet(n); sheets[n] = s; return s; }
        };
      }
    },
    PropertiesService: { getScriptProperties() { return { getProperty() { return null; }, setProperty() {} }; } },
    LockService: { getScriptLock() { return { tryLock() { return true; }, releaseLock() {} }; } }
  };
  vm.createContext(context);
  let combined = '';
  FILES.forEach(f => { combined += fs.readFileSync(new URL(f, dir), 'utf8') + '\n'; });
  vm.runInContext(combined.replace(/\bconst\s+/g, 'var '), context);
  context.__sheets = sheets;
  return context;
}

const HEADERS = ['taskId', '起票元', '件名', '依頼元', '担当PC', '状態', '次アクション', '成果物リンク', '期限', '最終更新', '備考'];

test('_taskSheetEnsureTab_ run twice on an already-header-having sheet does not duplicate the header', () => {
  const ctx = makeContext();
  ctx._taskSheetEnsureTab_(); // 1回目: 新規シートにヘッダーを書く
  const sheet = ctx.__sheets['タスク'];
  assert.deepEqual(sheet.getRange(2, 1, 1, HEADERS.length).getDisplayValues()[0], HEADERS);
  ctx._taskSheetEnsureTab_(); // 2回目: 何も変わらないはず
  assert.equal(sheet.getLastRow(), 2, '2回目実行後もrow2までしか埋まっていない(row3に複製されていない)');
  assert.deepEqual(sheet.getRange(2, 1, 1, HEADERS.length).getDisplayValues()[0], HEADERS);
});

test('_taskSheetEnsureTab_ heals a sheet where row1 AND row2 both already hold the header (without shifting row2 into row3)', () => {
  const ctx = makeContext();
  const sheet = new FakeSheet('タスク');
  sheet.grid[0] = HEADERS.slice(); // row1にもヘッダーが紛れ込んでいる(壊れかけの前段階)
  sheet.grid[1] = HEADERS.slice(); // row2は既に正しい
  sheet.grid[2] = ['T-1', 'kim', '件名', '', '', '未着手', '', '', '', 'now', ''];
  sheet._recomputeBounds();
  ctx.__sheets['タスク'] = sheet;

  ctx._taskSheetEnsureTab_();

  assert.deepEqual(sheet.getRange(1, 1, 1, HEADERS.length).getDisplayValues()[0], HEADERS.map(() => ''), 'row1はクリアされているべき');
  assert.deepEqual(sheet.getRange(2, 1, 1, HEADERS.length).getDisplayValues()[0], HEADERS, 'row2のヘッダーは維持される');
  assert.deepEqual(sheet.getRange(3, 1, 1, HEADERS.length).getDisplayValues()[0], ['T-1', 'kim', '件名', '', '', '未着手', '', '', '', 'now', ''], 'row3のデータはそのまま(row4に押し出されていない)');
});

test('repairTaskSheetLayout fixes the exact broken shape observed in production (row1 blank / row2 header / row3 duplicated header / row4 data)', () => {
  const ctx = makeContext();
  const sheet = new FakeSheet('タスク');
  sheet.grid[0] = HEADERS.map(() => '');
  sheet.grid[1] = HEADERS.slice();
  sheet.grid[2] = HEADERS.slice(); // 重複ヘッダー
  sheet.grid[3] = ['T-VERIFY-0903', 'system', '疎通テスト（検証用・あとで消します）', 'Claude', 'DESKTOP-2D0R4LI', '完了', 'kim が表で見えることを確認', '', '', '2026-09-03T05:33:06.493Z', ''];
  sheet._recomputeBounds();
  ctx.__sheets['タスク'] = sheet;

  const result = ctx.repairTaskSheetLayout();

  assert.equal(result.ok, true);
  assert.equal(result.deletedRowCount, 1);
  assert.deepEqual(Array.from(result.deletedRows), [3]);
  assert.equal(sheet.getLastRow(), 3, '重複ヘッダーを消した分、最終行が1つ詰まる');
  assert.deepEqual(sheet.getRange(2, 1, 1, HEADERS.length).getDisplayValues()[0], HEADERS);
  assert.equal(sheet.getRange(3, 1, 1, 1).getDisplayValues()[0][0], 'T-VERIFY-0903', 'データ行が正しくrow3に戻っている');
});

test('repairTaskSheetLayout is a no-op on an already-healthy sheet', () => {
  const ctx = makeContext();
  ctx._taskSheetEnsureTab_();
  ctx.upsertTask({ taskId: 'T-1', 起票元: 'kim', 件名: '件名' });
  const before = JSON.stringify(ctx.__sheets['タスク'].grid);
  const result = ctx.repairTaskSheetLayout();
  assert.equal(result.deletedRowCount, 0);
  assert.equal(JSON.stringify(ctx.__sheets['タスク'].grid), before);
});
