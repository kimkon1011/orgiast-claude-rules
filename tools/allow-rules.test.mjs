import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mergeAllowRules, convergeAllowRules } from './allow-rules.mjs';

test('別PCのホームからパスを生成し、既存ルールを保持して冪等にマージ', () => {
  for (const home of ['C:\\Users\\別の担当者', '/home/member']) {
    const original = { model: 'custom', permissions: { allow: ['Bash(custom:*)'], deny: ['Bash(git push --force*)', 'PowerShell(*git push --force*)', 'Bash(git push -f*)', 'Read(secret)'], ask: ['Write(*)'] } };
    const result = mergeAllowRules(original, home);
    assert.deepEqual(mergeAllowRules(result, home), result);
    assert.equal(result.model, 'custom');
    assert(result.permissions.allow.includes('Bash(custom:*)'));
    assert(result.permissions.allow.includes('Bash(git push --force-with-lease:*)'));
    assert(result.permissions.allow.includes(`Bash(node "${home.replaceAll('\\', '/')}/orgiast-main/tools/*)`));
    if (home.startsWith('C:')) assert(result.permissions.allow.includes(`Bash(node "${home}\\orgiast-main\\tools\\*)`));
    assert.deepEqual(result.permissions.deny, ['Bash(git push --force origin*)', 'Bash(git push --force)', 'PowerShell(*git push --force origin*)', 'Bash(git push -f*)', 'Read(secret)']);
    assert.deepEqual(result.permissions.ask, ['Write(*)']);
    assert.equal(original.permissions.allow.length, 1);
    assert.doesNotMatch(JSON.stringify(result), /Users.uers/);
  }
});
test('空設定を同期し再実行で書き換えず、壊れたJSONは保存しない', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'allow-rules-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  assert.equal(convergeAllowRules(home), true);
  const file = path.join(home, '.claude', 'settings.json');
  const before = fs.readFileSync(file, 'utf8'), mtime = fs.statSync(file).mtimeMs;
  assert.equal(convergeAllowRules(home), false);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(fs.statSync(file).mtimeMs, mtime);
  fs.writeFileSync(file, '{broken');
  assert.throws(() => convergeAllowRules(home));
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
});
