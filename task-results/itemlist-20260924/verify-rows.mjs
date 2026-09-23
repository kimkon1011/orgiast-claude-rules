import fs from 'node:fs';
import assert from 'node:assert/strict';
const base = new URL('./', import.meta.url);
const live = fs.readFileSync(new URL('live-Phase_ProcurementRequest.js', base), 'utf8');
const candidate = fs.readFileSync('/mnt/c/Users/uers/Downloads/booth-wt-itemlist-live/src/Phase_ProcurementRequest.js', 'utf8');
function pick(source) {
  const extract = name => source.match(new RegExp('function ' + name + '\\([^]*?^\\}', 'm'))?.[0] || '';
  return eval('(() => {' + extract('_Procure_appendMarkerRow') + '\n' + extract('_Procure_pickWritableRow') + '; return _Procure_pickWritableRow; })()');
}
function sheet(failMarkerRead = false) {
  const rows = Array.from({ length: 7 }, () => Array(7).fill(''));
  rows[3][1] = '以下に追加ｱｲﾃﾑ情報を入力';
  return {
    getLastRow: () => rows.length,
    getLastColumn: () => 7,
    getRange(row, column, count, width) {
      if (row === 1 && failMarkerRead) throw new Error('marker read failed');
      return {
        getDisplayValues: () => Array.from({ length: count }, (_, r) => Array.from({ length: width }, (_, c) => rows[row - 1 + r]?.[column - 1 + c] ?? '')),
        getMergedRanges: () => [],
      };
    },
  };
}
const observations = {
  fixture: '4行目のB列に追加マーカー、3行目と5行目に空行',
  liveSelectedRow: pick(live)(sheet(), { '品名': 7 }, new Set()),
  candidateSelectedRow: pick(candidate)(sheet(), { '品名': 7 }, new Set()),
  candidateMarkerReadFailureRow: pick(candidate)(sheet(true), { '品名': 7 }, new Set()),
  remoteWrites: 0,
  actualSpreadsheetTested: false,
};
assert.equal(observations.liveSelectedRow, 3);
assert.equal(observations.candidateSelectedRow, 5);
assert.equal(observations.candidateMarkerReadFailureRow, 3);
fs.writeFileSync(new URL('runtime-observations.json', base), JSON.stringify(observations, null, 2));
console.log(JSON.stringify(observations));
