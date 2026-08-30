import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { isEntry } from './is-entry.mjs';

const DISTRIBUTED_DIRECTORIES = ['tools', 'rules-extracted', 'skills'];
const toolsDir = path.dirname(fileURLToPath(import.meta.url));
const importPattern = /(?:\bimport\s+(?:[^'";]*?\s+from\s+)?|\bimport\s*\(\s*)(['"])([^'"]+)\1/g;

function mjsFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) return mjsFiles(target);
    return entry.isFile() && entry.name.endsWith('.mjs') ? [target] : [];
  });
}

export function findUndistributedImports(dir) {
  const root = path.resolve(dir);
  const violations = [];
  for (const file of mjsFiles(root)) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(importPattern)) {
      const specifier = match[2];
      if (!specifier.startsWith('./') && !specifier.startsWith('../')) continue;
      const resolved = path.resolve(path.dirname(file), specifier);
      const relative = path.relative(root, resolved);
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        violations.push({ file, specifier });
      }
    }
  }
  return violations;
}

test('tools 内の相対 import は tools 外へ出ない', () => {
  const violations = findUndistributedImports(toolsDir);
  assert.deepEqual(
    violations,
    [],
    `${violations.map(({ file, specifier }) => `${path.relative(toolsDir, file)}: ${specifier}`).join('\n')}\n` +
      `onboarding-sync が配るのは ${DISTRIBUTED_DIRECTORIES.join('/')} だけ。tools/ の外へ相対 import しない`,
  );
});

test('修正前の growi-manual 型の違反を検出する', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'undistributed-imports-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const outsideImport = ['..', 'scripts', 'lib', 'drive-auth.mjs'].join('/');
  fs.writeFileSync(path.join(root, 'growi-manual.mjs'), `import { driveApi } from '${outsideImport}';\n`);
  assert.deepEqual(findUndistributedImports(root), [
    { file: path.join(root, 'growi-manual.mjs'), specifier: '../scripts/lib/drive-auth.mjs' },
  ]);
});

if (isEntry(import.meta.url)) {
  process.exitCode = 0;
}
