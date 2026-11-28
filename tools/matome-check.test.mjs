import test from 'node:test'; import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { checkDirectory, scanRecent } from './matome-check.mjs';
import { fileURLToPath } from 'node:url';
const fixtures = fileURLToPath(new URL('../tests/matome-check/', import.meta.url));

test('直送が除外のみなら警告', () => {
  const r = checkDirectory(path.join(fixtures, 'direct-missing'));
  assert.ok(r.warnings.some(x => x.kind === 'direct' && /外されている/.test(x.message)));
});
test('直送が計画にあれば警告なし', () => {
  const r = checkDirectory(path.join(fixtures, 'direct-ok'));
  assert.ok(!r.warnings.some(x => x.kind === 'direct'));
});
test('分割理由と残りがあれば情報表示', () => {
  const r = checkDirectory(path.join(fixtures, 'direct-split'));
  assert.equal(r.results.find(x => x.kind === 'direct').status, 'split');
});
test('証明書の取得漏れを警告', () => {
  const r = checkDirectory(path.join(fixtures, 'certificate'));
  assert.ok(r.warnings.some(x => x.kind === 'certificate'));
});
test('scan-recent は新しい案件だけ対象', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'matome-'));
  for (const name of ['old', 'new']) { fs.mkdirSync(path.join(root, name)); fs.writeFileSync(path.join(root, name, 'PRINT-PLAN.md'), '控えを印刷'); }
  const old = new Date(Date.now() - 5 * 86400_000); fs.utimesSync(path.join(root, 'old', 'PRINT-PLAN.md'), old, old); fs.utimesSync(path.join(root, 'old'), old, old);
  assert.deepEqual(scanRecent(root, 48).map(x => path.basename(x.caseDir)), ['new']);
});
