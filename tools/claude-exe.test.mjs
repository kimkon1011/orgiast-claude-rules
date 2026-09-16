import { test } from 'node:test';
import assert from 'node:assert/strict';
import { versionTuple, compareVersionTuples, pickHighestVersion, isUnspawnable, candidateClaudeExecutables, resolveClaudeExecutable, defaultResolveArgs } from './claude-exe.mjs';
import path from 'node:path';

test('versionTuple basic', () => {
  assert.deepEqual(versionTuple('2.1.9'), [2, 1, 9]);
  assert.deepEqual(versionTuple('prefix 10.20.30 suffix'), [10, 20, 30]);
  assert.equal(versionTuple('no version'), null);
});

test('compareVersionTuples', () => {
  assert.ok(compareVersionTuples([2, 1, 9], [2, 1, 10]) < 0);
  assert.ok(compareVersionTuples([2, 1, 10], [2, 1, 9]) > 0);
  assert.equal(compareVersionTuples([1, 2], [1, 2, 0]), 0);
  assert.ok(compareVersionTuples([1, 2, 1], [1, 2]) > 0);
});

test('pickHighestVersion picks max and handles no matches', () => {
  const dirs = ['/a/prefix-1.0.0/x', '/a/prefix-2.1.0/y', '/a/prefix-2.1.10/z'];
  assert.equal(pickHighestVersion(dirs), '/a/prefix-2.1.10/z');
  assert.equal(pickHighestVersion(['/a/no-version']), null);
  assert.equal(pickHighestVersion([]), null);
});

test('isUnspawnable detects win32 bat/cmd/ps1 only', () => {
  assert.equal(isUnspawnable('C:\\foo\\claude.bat', 'win32'), true);
  assert.equal(isUnspawnable('C:\\foo\\claude.cmd', 'win32'), true);
  assert.equal(isUnspawnable('C:\\foo\\claude.ps1', 'win32'), true);
  assert.equal(isUnspawnable('C:\\foo\\claude.BAT', 'win32'), true);
  assert.equal(isUnspawnable('C:\\foo\\claude.exe', 'win32'), false);
  assert.equal(isUnspawnable('/home/user/claude.bat', 'linux'), false);
});

test('candidateClaudeExecutables picks highest VSCode extension version', () => {
  const home = '/home/test';
  const extDir = path.join(home, '.vscode', 'extensions');
  const candidates = candidateClaudeExecutables({
    platform: 'linux',
    home,
    localAppData: null,
    pathEntries: [],
    listDir: (dir) => dir === extDir ? ['anthropic.claude-code-1.0.0', 'anthropic.claude-code-2.5.0'] : [],
    exists: (p) => p.includes('2.5.0') && p.endsWith('claude'),
  });
  assert.deepEqual(candidates, [path.join(extDir, 'anthropic.claude-code-2.5.0', 'resources', 'native-binary', 'claude')]);
});

test('candidateClaudeExecutables picks highest Windows app version', () => {
  const localAppData = 'C:\\Users\\test\\AppData\\Local';
  const packagesDir = path.join(localAppData, 'Packages');
  const pkgDir = path.join(packagesDir, 'Claude_xyz');
  const codeDir = path.join(pkgDir, 'LocalCache', 'Roaming', 'Claude', 'claude-code');
  const candidates = candidateClaudeExecutables({
    platform: 'win32',
    home: 'C:\\Users\\test',
    localAppData,
    pathEntries: [],
    listDir: (dir) => {
      if (dir === packagesDir) return ['Claude_xyz'];
      if (dir === codeDir) return ['0.1.0', '1.2.0'];
      return [];
    },
    exists: (p) => p.endsWith('claude.exe') && p.includes('1.2.0'),
  });
  assert.deepEqual(candidates, [path.join(codeDir, '1.2.0', 'claude.exe')]);
});

test('candidateClaudeExecutables excludes .bat from PATH on win32', () => {
  const home = 'C:\\Users\\test';
  const entries = ['C:\\tools\\bin', 'C:\\Users\\test\\AppData\\Roaming\\npm'];
  const candidates = candidateClaudeExecutables({
    platform: 'win32',
    home,
    localAppData: 'C:\\Users\\test\\AppData\\Local',
    pathEntries: entries,
    listDir: () => [],
    exists: (p) => true,
  });
  assert.ok(!candidates.some((c) => c.endsWith('.bat') || c.endsWith('.cmd') || c.endsWith('.ps1')));
});

test('resolveClaudeExecutable env priority and fallback', () => {
  const opts = { platform: 'linux', home: '/home', localAppData: null, pathEntries: [], listDir: () => [], exists: () => false };
  assert.equal(resolveClaudeExecutable({ ...opts, env: { CLAUDE_CLI: 'custom-claude' } }), 'custom-claude');
  assert.equal(resolveClaudeExecutable({ ...opts, env: { CLAUDE_CLI_PATH: 'custom-path' } }), 'custom-path');
  assert.equal(resolveClaudeExecutable({ ...opts, env: {} }), 'claude');
});

test('defaultResolveArgs splits PATH with semicolon on win32', () => {
  const fakeProcess = {
    platform: 'win32',
    env: {
      USERPROFILE: 'C:\\Users\\test',
      LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local',
      PATH: 'C:\\a;D:\\b;',
    },
  };
  const args = defaultResolveArgs(fakeProcess);
  assert.deepEqual(args.pathEntries, ['C:\\a', 'D:\\b']);
  assert.equal(args.home, 'C:\\Users\\test');
  assert.equal(args.localAppData, 'C:\\Users\\test\\AppData\\Local');
});

// 実機で踏んだ形: パッケージ名に数字(Claude_pzs8sxrjxfjjc の 8)が入り、版ディレクトリが複数あるとき、
// フルパスの先頭数字を版番号と誤認すると 2.1.9 を最大と誤る。
test('Windowsアプリ版は版ディレクトリ名で比較する(パッケージ名の数字に釣られない)', () => {
  const localAppData = 'C:\Users\kimko\AppData\Local';
  const packagesDir = path.join(localAppData, 'Packages');
  const codeDir = path.join(packagesDir, 'Claude_pzs8sxrjxfjjc', 'LocalCache', 'Roaming', 'Claude', 'claude-code');
  const candidates = candidateClaudeExecutables({
    platform: 'win32',
    home: 'C:\Users\kimko',
    localAppData,
    pathEntries: [],
    listDir: (dir) => {
      if (dir === packagesDir) return ['Claude_pzs8sxrjxfjjc'];
      if (dir === codeDir) return ['2.1.9', '2.1.10'];
      return [];
    },
    exists: () => true,
  });
  assert.equal(candidates[0], path.join(codeDir, '2.1.10', 'claude.exe'));
});

test('home が未設定でも Windowsアプリ版を見つける', () => {
  const localAppData = 'C:\Users\kimko\AppData\Local';
  const packagesDir = path.join(localAppData, 'Packages');
  const codeDir = path.join(packagesDir, 'Claude_x', 'LocalCache', 'Roaming', 'Claude', 'claude-code');
  const candidates = candidateClaudeExecutables({
    platform: 'win32',
    home: undefined,
    localAppData,
    pathEntries: [],
    listDir: (dir) => (dir === packagesDir ? ['Claude_x'] : dir === codeDir ? ['1.0.0'] : []),
    exists: () => true,
  });
  assert.equal(candidates[0], path.join(codeDir, '1.0.0', 'claude.exe'));
});
