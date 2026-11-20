import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireSendDedupe, bodyDigest, SendDedupeError } from './lib/send-dedupe.mjs';

test('成功後だけ正規化した宛先・本文 hash を記録し24時間は拒否する', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'send-dedupe-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const first = await acquireSendDedupe({ recipients: ['Name <USER@Example.COM>'], body: '本文  \r\n', home, now: () => new Date('2026-11-19T00:00:00Z') });
  first.recordSuccess({ transport: 'test' });
  const row = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'send-ledger.jsonl'), 'utf8'));
  assert.deepEqual(row.to, ['user@example.com']);
  assert.equal(row.bodyHash, bodyDigest('本文\n'));
  await assert.rejects(() => acquireSendDedupe({ recipients: 'user@example.com', body: '別本文', home, now: () => new Date('2026-11-19T23:59:00Z') }), error => error instanceof SendDedupeError && error.exitCode === 4 && /同じ宛先へ/u.test(error.message));
});

test('--allow-repeat の理由を記録し、失敗時は記録しない', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'send-repeat-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const failed = await acquireSendDedupe({ recipients: 'a@example.com', body: 'x', home });
  failed.release();
  assert.equal(fs.existsSync(path.join(home, '.claude', 'send-ledger.jsonl')), false);
  const allowed = await acquireSendDedupe({ recipients: 'a@example.com', body: 'x', allowRepeat: '訂正版を送るため', home });
  allowed.recordSuccess();
  const row = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'send-ledger.jsonl'), 'utf8'));
  assert.equal(row.allowRepeatReason, '訂正版を送るため');
});
