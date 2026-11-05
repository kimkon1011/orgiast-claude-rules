import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from '../build-test.mjs';
import { gradeWorkbook } from '../grade.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const key = JSON.parse(await fs.readFile(path.join(root, 'answer-key.json'), 'utf8'));

async function fixture(kind = 'correct', mutation) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cafe-pc-test-'));
  const file = path.join(dir, `${kind}.xlsx`); await build(file);
  if (kind !== 'blank') {
    const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(file); const ws = wb.getWorksheet(key.sheet);
    key.rows.forEach((row, r) => row.forEach((value, c) => {
      ws.getCell(key.firstDataRow + r, c + 1).value = value?.type === 'nonempty' ? '応募 花子' : value;
    }));
    if (mutation) mutation(ws); await wb.xlsx.writeFile(file);
  }
  return file;
}

test('正解を全部入れたxlsxは満点で合格', async () => {
  const result = await gradeWorkbook(await fixture());
  assert.equal(result.score, result.maximum); assert.equal(result.passed, true); assert.deepEqual(result.errors, []);
});

test('空欄は不合格', async () => {
  const result = await gradeWorkbook(await fixture('blank'));
  assert.equal(result.passed, false); assert.ok(result.errors.length > 100);
});

const mistakes = [
  ['ゼロ埋め', 'D4', '2027/08/01'],
  ['曜日誤り', 'E4', '2027年8月1日(月)～2日(火)'],
  ['会期の書き換え', 'B14', '第14回'],
  ['重複見落とし', 'J7', '']
];

for (const [name, cell, value] of mistakes) test(`${name}は該当項目だけ減点`, async () => {
  const result = await gradeWorkbook(await fixture(name, ws => { ws.getCell(cell).value = value; }));
  assert.equal(result.errors.length, 1); assert.equal(result.errors[0].cell, cell);
  assert.equal(result.score, result.maximum - result.errors[0].pointsLost);
});

test('全角数字・前後空白・波ダッシュは正規化して減点しない', async () => {
  const result = await gradeWorkbook(await fixture('normalize', ws => {
    ws.getCell('D4').value = ' ２０２７/８/１ '; ws.getCell('E4').value = '2027年8月1日(日)〜2日(月)';
  }));
  assert.equal(result.score, result.maximum);
});
