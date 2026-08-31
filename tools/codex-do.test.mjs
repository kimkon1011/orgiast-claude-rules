import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const tool = fileURLToPath(new URL('./codex-do.mjs', import.meta.url));
const { needsWorktreeRepair } = await import('./codex-do.mjs');

function run(args, options = {}) {
  return spawnSync(process.execPath, [tool, ...args], {
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env, ORGIAST_HOME: options.home ?? fs.mkdtempSync(path.join(os.tmpdir(), 'codexdo-home-')) },
  });
}

function writePrompt(body) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'codexdo-')), 'prompt.md');
  fs.writeFileSync(file, body, 'utf8');
  return file;
}

test('--prompt-file の中身をそのまま指示として使う', () => {
  const file = writePrompt('# 見出し\n新規ファイルを作る\n');
  const result = run(['--dry-run', '--prompt-file', file]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /新規ファイルを作る/);
});

test('バッククォート・$()・改行を含む指示が欠落せず原文のまま届く', () => {
  // argv で渡すとシェルがコマンド置換として実行し、仕様の一部が消えたプロンプトが
  // Codex に届く(2026-08-26 実害)。ファイル経路ではそれが起きないことを固定する。
  const body = 'ファイル `scripts/import-x.mjs` を作る\nテーブルは `booth_customer_aliases`\n$(rm -rf /) は文字列のまま\n';
  const result = run(['--dry-run', '--prompt-file', writePrompt(body)]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /`scripts\/import-x\.mjs`/);
  assert.match(result.stdout, /`booth_customer_aliases`/);
  assert.match(result.stdout, /\$\(rm -rf \/\)/);
});

test('--prompt-file が読めなければ実行せず終了する', () => {
  const result = run(['--dry-run', '--prompt-file', path.join(os.tmpdir(), 'codexdo-missing-prompt.md')]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--prompt-file を読めません/);
});

test('--prompt-file にパスが無ければ使い方を出す', () => {
  const result = run(['--dry-run', '--prompt-file']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--prompt-file/);
});

test('--timeout が数値でなければ実行しない', () => {
  const result = run(['--dry-run', '--timeout', 'abc', 'なにか実装する']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--timeout は正の秒数/);
});

test('--timeout と --cwd を付けても指示文が引数として食われない', () => {
  const result = run(['--dry-run', '--timeout', '60', '--cwd', os.tmpdir(), 'これは指示文です']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /これは指示文です/);
  assert.doesNotMatch(result.stdout, /--timeout|--cwd|60/);
});

test('指示が空なら使い方を出して終了する', () => {
  const result = run(['--dry-run']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /使い方/);
});

test('Windows 絶対パスの gitdir だけ worktree repair 対象にする', () => {
  assert.equal(needsWorktreeRepair('gitdir: C:/Users/example/repo/.git/worktrees/linked\n'), true);
  assert.equal(needsWorktreeRepair('gitdir: ../../../.git/worktrees/linked\n'), false);
});
