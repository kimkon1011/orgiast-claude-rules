import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dedupeContext } from './context-dedupe.mjs';

test('last hash persists per session and source; changed content is emitted again', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'context-dedupe-'));
  const options = { home, sessionId: '../../日本語/session', source: 'push' };
  assert.equal(dedupeContext('通知1件', options), '通知1件');
  assert.equal(dedupeContext('通知1件', options), '');
  assert.equal(dedupeContext('', options), '');
  assert.equal(dedupeContext('別件', { ...options, source: 'other' }), '別件');
  assert.equal(dedupeContext('通知1件', options), '');
  assert.equal(dedupeContext('通知2件', options), '通知2件');
  assert.equal(dedupeContext('通知1件', options), '通知1件');
  assert.equal(dedupeContext('通知1件', { ...options, sessionId: 'other' }), '通知1件');
  assert.equal(dedupeContext('通知1件', { home, source: 'push' }), '通知1件');
});

test('unwritable state fails open', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'context-dedupe-fail-'));
  fs.writeFileSync(path.join(home, '.claude'), 'not a directory');
  assert.equal(dedupeContext('通知', { home, sessionId: 's', source: 'push' }), '通知');
});
