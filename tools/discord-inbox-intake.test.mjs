import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { intake } from './discord-inbox-intake.mjs';
import { listDecisions } from './pending-decisions.mjs';

function home() { return fs.mkdtempSync(path.join(os.tmpdir(), 'discord-intake-')); }
test('starts 24h ago, excludes bots and empty content, then resumes from state', async () => {
  const dir = home(); const now = new Date('2026-08-31T12:00:00Z'); const calls = [];
  const pages = [[
    { id: '1', timestamp: '2026-08-31T10:00:00Z', content: 'one', author: { username: 'kim' } },
    { id: '2', timestamp: '2026-08-31T10:01:00Z', content: 'bot', author: { username: 'x', bot: true } },
    { id: '3', timestamp: '2026-08-31T10:02:00Z', content: '', author: { username: 'kim' } },
  ], [{ id: '4', timestamp: '2026-08-31T11:00:00Z', content: 'two', author: { global_name: 'Kim' } }]];
  const fetchMessagesImpl = async (args) => { calls.push(args); return { messages: pages.shift() }; };
  assert.equal((await intake({ home: dir, now, channelId: '123', token: 'secret', fetchMessagesImpl })).count, 1);
  assert.equal(calls[0].since, now.getTime() - 864e5);
  await intake({ home: dir, now, channelId: '123', token: 'secret', fetchMessagesImpl });
  assert.equal(calls[1].since, Date.parse('2026-08-31T10:00:00.001Z'));
  assert.deepEqual(listDecisions({ home: dir }).map((x) => x.text), ['one', 'two']);
});
