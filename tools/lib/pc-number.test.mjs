import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolvePcNumber } from './pc-number.mjs';

const mapPath = new URL('../../fleet-pc-map.json', import.meta.url);
for (const [hostname, expected] of Object.entries({ 'DESKTOP-N429M3V': '018', 'DESKTOP-04U31RG': '019', 'DESKTOP-PPD5V8I': '004', '作業用011': '011', 'DESKTOP-2D0R4LI': '' })) {
  test(`実マップ: ${hostname} → ${expected || '番号なし'}`, () => {
    assert.equal(resolvePcNumber({ env: {}, hostname, mapPath }), expected);
    assert.equal(resolvePcNumber({ env: {}, hostname: hostname.toLowerCase(), mapPath }), expected);
  });
}
test('env優先・数字以外除去・空ならマップへ', () => {
  assert.equal(resolvePcNumber({ env: { ORGIAST_PC_NUMBER: 'PC-007' }, hostname: 'DESKTOP-N429M3V', mapPath }), '007');
  assert.equal(resolvePcNumber({ env: { ORGIAST_PC_NUMBER: 'PC' }, hostname: 'DESKTOP-N429M3V', mapPath }), '018');
});
test('aliases・名前の優先順・未検証項目を無視・hostname fallback', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-number-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'map.json');
  fs.writeFileSync(file, JSON.stringify({
    _ignored: { hostname: 'hidden', remoteName: '作業用999' },
    _unverified: { candidate: { hostname: 'unknown', remoteName: '作業用999' } },
    '作業用003': { aliases: ['ALIAS'], remoteName: '作業用001', sheetName: '作業用002' },
    sheet: { hostname: 'sheet', remoteName: 'invalid', sheetName: '作業用002' },
    '作業用004': { hostname: 'key' },
  }));
  const resolve = hostname => resolvePcNumber({ env: {}, hostname, mapPath: file });
  for (const [host, expected] of Object.entries({ alias: '001', sheet: '002', key: '004', hidden: '', unknown: '', '作業用005': '005' })) assert.equal(resolve(host), expected);
  fs.writeFileSync(file, '{broken');
  assert.equal(resolve('作業用006'), '006');
  fs.unlinkSync(file);
  assert.equal(resolve('作業用007'), '007');
  assert.equal(resolve('unknown'), '');
});
