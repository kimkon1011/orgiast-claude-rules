import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { repoDir } from './gate-contracts.mjs';

const required = [
  '金さんに設定・ボタン操作・確認を依頼する前に、その状態がすでに済んでいないかを必ず確認する',
  '金さんに通知が出ない方法を優先する',
  '未確認',
  'すでにオンなら何もしなくてよい',
];

function read(rel) {
  return fs.readFileSync(path.join(repoDir, rel), 'utf8');
}

test('ONBOARDING.md has the pre-ask state check rule', () => {
  const text = read('ONBOARDING.md');
  for (const phrase of required) assert.ok(text.includes(phrase), phrase);
});

test('CLAUDE.md.template distributes the pre-ask state check rule', () => {
  const text = read('CLAUDE.md.template');
  for (const phrase of required) assert.ok(text.includes(phrase), phrase);
});

test('automation-first-checklist has the pre-ask checklist', () => {
  const text = read('rules-extracted/automation-first-checklist.md');
  assert.ok(text.includes('依頼する前に、すでに済んでいないかを確認する'));
  assert.ok(text.includes('金さんへの依頼文を出す前のチェックリスト'));
  assert.ok(text.includes('developers.cliSharedLockState.enabled'));
});

test('1Password doc has a no-prompt settings check', () => {
  const text = read('docs/1password-ai-integration.md');
  assert.ok(text.includes('1Password\\settings\\settings.json') || text.includes('1Password/settings/settings.json') || text.includes('%LOCALAPPDATA%\\1Password\\settings\\settings.json'));
  assert.ok(text.includes('developers.cliSharedLockState.enabled'));
  assert.ok(text.includes('security.authenticatedUnlock.enabled'));
  assert.ok(text.includes('op account list'));
  assert.ok(text.includes('未確認'));
  assert.ok(text.includes('すでにオンなら何もしなくてよい'));
});
