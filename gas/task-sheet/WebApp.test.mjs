import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// 不具合2の再現テスト: 「doneTask に日本語キー(成果物リンク/備考)を添えると unknown_kind になる」
// という報告に対し、まず現行コード(HEAD)で再現するかどうかを機械的に確認する。
// dispatch (doPost) は payload.kind の文字列比較だけで分岐しており、余分なフィールドの
// 有無には左右されないはずなので、ここでは「壊れていないこと」をロックする回帰テストとして書く。

const dir = new URL('./', import.meta.url);
const FILES = ['Setup.gs', 'TaskSheetLayoutLogic.gs', 'TaskLedgerLogic.gs', 'TaskLedger.gs', 'WebApp.gs'];

class FakeRange {
  constructor(sheet, row, col, numRows, numCols) { Object.assign(this, { sheet, row, col, numRows, numCols }); }
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
      if (cell !== undefined && cell !== null && cell !== '') { if (ri + 1 > lastRow) lastRow = ri + 1; if (ci + 1 > lastColumn) lastColumn = ci + 1; }
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
  const props = { TASK_SHEET_TOKEN: 'x'.repeat(32) };
  const context = {
    console,
    ContentService: {
      createTextOutput(s) { return { _s: s, setMimeType() { return this; }, getContent() { return this._s; } }; },
      MimeType: { JSON: 'json' }
    },
    SpreadsheetApp: {
      getActiveSpreadsheet() {
        return { getSheetByName(n) { return sheets[n] || null; }, insertSheet(n) { const s = new FakeSheet(n); sheets[n] = s; return s; } };
      }
    },
    PropertiesService: { getScriptProperties() { return { getProperty(k) { return props[k] !== undefined ? props[k] : null; }, setProperty(k, v) { props[k] = v; } }; } },
    LockService: { getScriptLock() { return { tryLock() { return true; }, releaseLock() {} }; } }
  };
  vm.createContext(context);
  let combined = '';
  FILES.forEach(f => { combined += fs.readFileSync(new URL(f, dir), 'utf8') + '\n'; });
  vm.runInContext(combined.replace(/\bconst\s+/g, 'var '), context);
  context.__sheets = sheets;
  return context;
}

const TOKEN = 'x'.repeat(32);

function doPostJson(ctx, bodyObj) {
  const out = ctx.doPost({ postData: { contents: JSON.stringify(bodyObj) } });
  return JSON.parse(out.getContent());
}

test('doneTask succeeds with only taskId (baseline)', () => {
  const ctx = makeContext();
  ctx._taskSheetEnsureTab_();
  ctx.upsertTask({ taskId: 'T-VERIFY-0903', 起票元: 'system', 件名: 'test' });
  const res = doPostJson(ctx, { token: TOKEN, kind: 'doneTask', taskId: 'T-VERIFY-0903' });
  assert.equal(res.ok, true);
});

// 実測で失敗したのと同一のペイロード(日本語キー付き)。これが unknown_kind になってはいけない。
test('doneTask with 成果物リンク/備考 (Japanese keys) must not be rejected as unknown_kind, and must write those columns', () => {
  const ctx = makeContext();
  ctx._taskSheetEnsureTab_();
  ctx.upsertTask({ taskId: 'T-VERIFY-0903', 起票元: 'system', 件名: 'test' });

  const res = doPostJson(ctx, {
    token: TOKEN,
    kind: 'doneTask',
    taskId: 'T-VERIFY-0903',
    '成果物リンク': '（疎通確認のみ）',
    '備考': '検証用・実務データではない'
  });

  assert.notEqual(res.error, 'unknown_kind', 'doneTask + 日本語キーが unknown_kind になってはいけない');
  assert.equal(res.ok, true);

  const list = ctx.listTasks({ taskId: 'T-VERIFY-0903' });
  assert.equal(list.rows[0].状態, '完了');
  assert.equal(list.rows[0]['成果物リンク'], '（疎通確認のみ）');
  assert.equal(list.rows[0]['備考'], '検証用・実務データではない');
});
