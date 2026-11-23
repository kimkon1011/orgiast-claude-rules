import test from 'node:test';
import assert from 'node:assert/strict';
import { isCollapsedWindowsPath } from '../tools/lib/collapsed-win-path.mjs';
import { filterCollapsedWindowsPaths, statusPaths } from '../tools/dirty-worktree-guard.mjs';

test('porcelain -z の通常変更と rename を正しくパースする', () => {
  const modified = statusPaths(' M a.txt\0 M b.txt\0');
  assert.deepEqual(modified, ['a.txt', 'b.txt']);
  assert.deepEqual(statusPaths('R  new.txt\0old.txt\0'), ['new.txt', 'old.txt']);
  assert.deepEqual(statusPaths('?? C:UserskimkoAppDataLocalTempscan-before.json\0'), [
    'C:UserskimkoAppDataLocalTempscan-before.json',
  ]);
  assert.deepEqual(filterCollapsedWindowsPaths(modified), ['a.txt', 'b.txt']);
});

test('潰れた Windows 絶対パス名だけを判定する', () => {
  assert.equal(isCollapsedWindowsPath('C:UserskimkoAppDataLocalTempscan-before.json'), true);
  assert.equal(isCollapsedWindowsPath('D:Claudework\ttmp.json'), true);
  assert.equal(isCollapsedWindowsPath('tools/lib/foo.mjs'), false);
  assert.equal(isCollapsedWindowsPath('README.md'), false);
  assert.equal(isCollapsedWindowsPath('docs/C-something.md'), false);
});

test('rescue 対象から潰れた Windows パス名だけを落とす', () => {
  const logs = [];
  const names = [
    'tracked.txt',
    'C:UserskimkoAppDataLocalTempscan-before.json',
    'docs/C-something.md',
  ];
  assert.deepEqual(filterCollapsedWindowsPaths(names, { log: line => logs.push(line) }), [
    'tracked.txt',
    'docs/C-something.md',
  ]);
  assert.deepEqual(logs, [
    'skip collapsed path: C:UserskimkoAppDataLocalTempscan-before.json',
  ]);
});
