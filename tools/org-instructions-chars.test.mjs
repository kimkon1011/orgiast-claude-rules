import test from 'node:test';
import assert from 'node:assert/strict';
import { countChars, formatCharCount } from './org-instructions-chars.mjs';

test('countChars は Unicode コードポイントで数える', () => {
  assert.equal(countChars(''), 0);
  assert.equal(countChars('abc'), 3);
  assert.equal(countChars('日本語'), 3);
  // サロゲートペア（絵文字）も正しく1文字として数える
  assert.equal(countChars('a😀b'), 3);
});

test('formatCharCount は [ORG-CHARS: n/3000] を返す', () => {
  assert.equal(formatCharCount('abc'), '[ORG-CHARS: 3/3000]');
  assert.equal(formatCharCount(''), '[ORG-CHARS: 0/3000]');
  assert.equal(formatCharCount('日本語テスト'), '[ORG-CHARS: 6/3000]');
});
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('--file CLI は全文を読み改行と絵文字をコードポイントで数える', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'org-chars-cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'full text.txt');
  fs.writeFileSync(file, '日本😀\n追記', 'utf8');
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./org-instructions-chars.mjs', import.meta.url)), '--file', file], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), '[ORG-CHARS: 6/3000]');
});
