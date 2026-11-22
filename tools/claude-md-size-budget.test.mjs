import assert from 'node:assert/strict';
import test from 'node:test';
import { renderTemplate } from './render-claude-template.mjs';

test('CLAUDE.md 全体は UTF-8 で 14,000 バイト以内', () => {
  const bytes = Buffer.byteLength(renderTemplate(), 'utf8');
  assert.ok(bytes <= 14_000, `CLAUDE.md is ${bytes} bytes (limit: 14,000)`);
});
