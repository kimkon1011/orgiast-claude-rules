import { withTema } from './test-fixtures/tema-record.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from './line-channel.mjs';

test('LINE送信は秘書の空き日程URLを送らない', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'line-url-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'body.txt');
  fs.writeFileSync(file, 'https://claude-pc.tailc5d751.ts.net/secretary/book\n');
  await assert.rejects(
    () => run(['--to', 'C1', '--body-file', file, '--send'], async () => { throw new Error('request'); }),
    /空き日程URL/,
  );
  fs.writeFileSync(file, '11月20日 10:00');
  const calls = [];
  await run(['--to', 'C1', '--body-file', file, '--dry-run'], async (channel, opts) => {
    calls.push(opts);
    if (opts.query?.mode === 'contacts') return { contacts: [{ id: 'C1', name: 'C1', active: true }] };
    return { ok: true };
  });
  assert.equal(calls.at(-1).body.dryRun, true);
  assert.equal(calls.at(-1).body.text, '11月20日 10:00');
});

test('送信前ガード: 差し戻し文面は送らず、HUMAN-ONLY はタグを外す', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'line-handback-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'body.txt');
  fs.writeFileSync(file, withTema('仮押さえ先の確認をお願いします。\n'));
  await assert.rejects(
    () => run(['--to', 'C1', '--body-file', file, '--send'], async () => { throw new Error('request'); }),
    (error) => error.code === 'HANDBACK_BLOCKED',
  );
  fs.writeFileSync(file, withTema('[HUMAN-ONLY: 現地作業] 11/29 9:00に現場で鍵の受け取りをお願いします。'));
  const calls = [];
  await run(['--to', 'C1', '--body-file', file, '--dry-run'], async (channel, opts) => {
    calls.push(opts);
    if (opts.query?.mode === 'contacts') return { contacts: [{ id: 'C1', name: 'C1', active: true }] };
    return { ok: true };
  });
  assert.equal(calls.at(-1).body.text.trimEnd(), '11/29 9:00に現場で鍵の受け取りをお願いします。');
  assert.doesNotMatch(calls.at(-1).body.text, /HUMAN-ONLY/);
});
