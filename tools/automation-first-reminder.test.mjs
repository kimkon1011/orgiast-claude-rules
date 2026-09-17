import test from 'node:test';
import assert from 'node:assert/strict';
import { additionalContext } from './automation-first-reminder.mjs';

test('認証の取得・設定は keyserve と専用ツールを案内する', () => {
  assert.match(additionalContext, /keyserve-status\.mjs/);
  assert.match(additionalContext, /env-kv\.mjs/);
  assert.doesNotMatch(additionalContext, /transcript|\.env\.local|gh secret set/);
});
