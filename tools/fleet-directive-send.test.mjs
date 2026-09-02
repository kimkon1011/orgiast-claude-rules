import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { directiveId, main, pruneDirectives } from './fleet-directive-send.mjs';

function tempRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-send-'));
  fs.writeFileSync(path.join(repo, 'fleet-directives.json'), JSON.stringify({ version: 1, directives: [] }));
  return repo;
}

test('--why 無しは失敗し、ファイルを書き換えない', () => {
  const repo = tempRepo();
  const before = fs.readFileSync(path.join(repo, 'fleet-directives.json'), 'utf8');
  assert.throws(() => main(['--kind', 'status'], { repo }), /--why は必須/);
  assert.equal(fs.readFileSync(path.join(repo, 'fleet-directives.json'), 'utf8'), before);
});

test('id は同時刻・同 kind でも乱数で毎回ユニーク', () => {
  const date = new Date('2026-09-02T12:34:56Z');
  assert.notEqual(directiveId('status', date, () => 1), directiveId('status', date, () => 2));
  assert.match(directiveId('prompt', date, () => 42), /^prompt-20260902-123456-0042$/);
});

test('prompt 本文は --body-file からそのまま読み期限を付ける', () => {
  const repo = tempRepo();
  const body = path.join(repo, 'prompt.md');
  fs.writeFileSync(body, 'run `literal`\n');
  const directive = main(['--kind', 'prompt', '--targets', 'PC', '--why', '点検', '--body-file', body, '--expires-hours', '24'], { repo, randomInt: () => 7 });
  const saved = JSON.parse(fs.readFileSync(path.join(repo, 'fleet-directives.json'), 'utf8')).directives[0];
  assert.equal(saved.body, 'run `literal`\n');
  assert.equal(saved.id, directive.id);
  assert.ok(saved.expiresAt);
});

test('--prune は期限切れと処理済みだけを除く', () => {
  const remaining = pruneDirectives([
    { id: 'expired', expiresAt: '2000-01-01T00:00:00Z' },
    { id: 'processed', processedAt: '2026-09-01T00:00:00Z' },
    { id: 'active', expiresAt: '2999-01-01T00:00:00Z' },
  ], Date.parse('2026-09-02T00:00:00Z'));
  assert.deepEqual(remaining.map((item) => item.id), ['active']);
});
