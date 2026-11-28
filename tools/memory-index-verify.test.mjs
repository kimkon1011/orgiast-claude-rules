import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { findOrphans, verify } from './memory-index-verify.mjs';

function makeMemoryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'memidx-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('索引に直接載っているファイルは孤立でない', (t) => {
  const directory = makeMemoryDirectory(t);
  fs.writeFileSync(path.join(directory, 'a.md'), '# A\n');

  assert.deepEqual(findOrphans({ directory, indexText: '- [A](a.md)' }), []);
});

test('rollup の wikilink から辿れるファイルは孤立でない', (t) => {
  const directory = makeMemoryDirectory(t);
  fs.writeFileSync(path.join(directory, 'roll.md'), '関連: [[a]]\n');
  fs.writeFileSync(path.join(directory, 'a.md'), '# A\n');

  assert.deepEqual(findOrphans({ directory, indexText: '- [Roll](roll.md)' }), []);
});

test('索引にも wikilink にも無いファイルは孤立として返る', (t) => {
  const directory = makeMemoryDirectory(t);
  fs.writeFileSync(path.join(directory, 'a.md'), '# A\n');
  fs.writeFileSync(path.join(directory, 'lost.md'), '# Lost\n');

  assert.deepEqual(findOrphans({ directory, indexText: '- [A](a.md)' }), ['lost.md']);
});

test('MEMORY.md 自身は孤立に数えない', (t) => {
  const directory = makeMemoryDirectory(t);
  fs.writeFileSync(path.join(directory, 'MEMORY.md'), '# Index\n');

  assert.deepEqual(findOrphans({ directory, indexText: '' }), []);
});

test('verify は孤立を notes に載せ problems には載せない', (t) => {
  const directory = makeMemoryDirectory(t);
  fs.writeFileSync(path.join(directory, 'a.md'), '# A\n');
  fs.writeFileSync(path.join(directory, 'lost.md'), '# Lost\n');
  const indexText = '- [A](a.md)';

  const result = verify({ before: indexText, after: indexText, directory });

  assert.deepEqual(result.problems, []);
  assert.ok(result.notes.includes('索引からもwikilinkからも辿れない: lost.md'));
  assert.equal(result.stats.orphans, 1);
});
