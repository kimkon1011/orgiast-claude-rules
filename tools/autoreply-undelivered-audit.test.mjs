import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { audit } from './autoreply-undelivered-audit.mjs';

test('ログ本文によらずページを越えてlinkedMessageIDの通話通知を特定', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'reply-audit-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, '.claude/discord-autoreply');
  fs.mkdirSync(dir, { recursive: true });
  const entry = { ts: new Date().toISOString(), where: 'dm', channelId: 'c', channelName: '相談', replyId: 'sent', question: '本物の質問'.repeat(20) };
  fs.writeFileSync(path.join(dir, 'sent-log.jsonl'), JSON.stringify(entry) + '\n' + JSON.stringify({ ...entry, where: 'server' }));
  const cursors = [];
  const api = { listMessages: async (_id, { cursor }) => {
    cursors.push(cursor);
    return cursor ? { items: [{ id: 'call', type: 'TEXT', isSender: false, text: 'started a call' }], hasMore: false }
      : { items: [{ id: 'sent', linkedMessageID: 'call' }], hasMore: true, oldestCursor: 'next' };
  } };
  const r = await audit({ home, api });
  assert.equal(r.ok, true);
  assert.equal(r.totalDmEntries, 1);
  assert.equal(r.suspiciousCount, 1);
  assert.equal(r.entries[0].linkedMessageID, 'call');
  assert.equal(r.entries[0].questionPreview.length, 60);
  assert.deepEqual(cursors, [undefined, 'next']);
  const unavailable = await audit({ home, api: { listMessages: async () => { throw new Error('offline'); } } });
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.checked, 0);
  assert.equal(unavailable.unresolved.length, 1);
});
