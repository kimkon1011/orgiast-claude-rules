import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const toolsDir = path.dirname(fileURLToPath(import.meta.url));
const excluded = new Set(['is-entry.mjs', 'is-entry.test.mjs']);

test('tools の main ガードは isEntry を使う', () => {
  const rawGuardPatterns = [
    /import\.meta\.url\s*===|===\s*import\.meta\.url/,
    /fileURLToPath\(import\.meta\.url\)\s*===|===\s*fileURLToPath\(import\.meta\.url\)/,
  ];
  // *.test.mjs は「この書き方を禁止する」assert の中で文字列としてパターンを持つため対象外にする
  // （cloud-ledger-logic.test.mjs が実際にそう書いている）。テストに main ガードは要らない。
  const offenders = fs.readdirSync(toolsDir)
    .filter((name) => name.endsWith('.mjs') && !name.endsWith('.test.mjs') && !excluded.has(name))
    .filter((name) => rawGuardPatterns.some((pattern) => pattern.test(fs.readFileSync(path.join(toolsDir, name), 'utf8'))));

  assert.deepEqual(offenders, [], `素の main ガードを使っているファイル: ${offenders.join(', ')}`);
});
