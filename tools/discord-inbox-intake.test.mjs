import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanupOldAttachments, intake } from './discord-inbox-intake.mjs';
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

function response(body = 'image') {
  const bytes = Buffer.from(body);
  return { ok: true, status: 200, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
}
function messagesFixture(messages) { return async () => ({ messages }); }

test('downloads an attachment and persists its metadata and path', async () => {
  const dir = home();
  const result = await intake({ home: dir, now: new Date('2026-08-31T12:00:00Z'), channelId: '123',
    fetchMessagesImpl: messagesFixture([{ id: 'a', timestamp: '2026-08-31T11:00:00Z', content: '画面です', author: { username: 'kim' }, attachments: [{ filename: 'screen.png', content_type: 'image/png', size: 5, url: 'https://cdn.test/a' }] }]),
    fetchImpl: async () => response() });
  assert.equal(result.count, 1);
  assert.equal(result.decisions[0].attachments[0].filename, 'screen.png');
  assert.ok(fs.existsSync(result.decisions[0].attachments[0].path));
  assert.equal(listDecisions({ home: dir })[0].attachments[0].path, result.decisions[0].attachments[0].path);
});

test('accepts attachment-only messages, but excludes empty and bot messages', async () => {
  const dir = home();
  const attachment = { filename: 'only.png', size: 1, url: 'https://cdn.test/only' };
  const result = await intake({ home: dir, now: new Date('2026-08-31T12:00:00Z'), channelId: '123', fetchImpl: async () => response('x'), fetchMessagesImpl: messagesFixture([
    { id: 'only', timestamp: '2026-08-31T11:00:00Z', content: '', author: { username: 'kim' }, attachments: [attachment] },
    { id: 'empty', timestamp: '2026-08-31T11:01:00Z', content: '', author: { username: 'kim' }, attachments: [] },
    { id: 'bot', timestamp: '2026-08-31T11:02:00Z', content: 'bot', author: { bot: true }, attachments: [attachment] },
  ]) });
  assert.equal(result.count, 1);
  assert.equal(result.decisions[0].text, '(画像のみ)');
});

test('omits attachments when absent and retains failures and oversized metadata', async () => {
  const dir = home();
  const result = await intake({ home: dir, now: new Date('2026-08-31T12:00:00Z'), channelId: '123', fetchImpl: async () => { throw new Error('offline'); }, fetchMessagesImpl: messagesFixture([
    { id: 'plain', timestamp: '2026-08-31T10:00:00Z', content: 'plain', author: { username: 'kim' } },
    { id: 'failed', timestamp: '2026-08-31T10:01:00Z', content: 'failed', author: { username: 'kim' }, attachments: [{ filename: 'bad.png', size: 10, url: 'https://cdn.test/bad' }] },
    { id: 'large', timestamp: '2026-08-31T10:02:00Z', content: 'large', author: { username: 'kim' }, attachments: [{ filename: 'large.png', size: 25 * 1024 * 1024 + 1, url: 'https://cdn.test/large' }] },
  ]) });
  assert.equal('attachments' in result.decisions[0], false);
  assert.equal(result.decisions[1].attachments[0].skipped, 'download-failed');
  assert.equal(result.decisions[2].attachments[0].skipped, 'too-large');
});

test('sanitizes filenames, limits attachments to ten, and dry-run never downloads', async () => {
  const dir = home(); let fetches = 0;
  const attachments = Array.from({ length: 11 }, (_, index) => ({ filename: index ? `${index}.png` : '../evil', size: 1, url: `https://cdn.test/${index}` }));
  const fixture = [{ id: 'many', timestamp: '2026-08-31T11:00:00Z', content: 'many', author: { username: 'kim' }, attachments }];
  const result = await intake({ home: dir, now: new Date('2026-08-31T12:00:00Z'), channelId: '123', fetchMessagesImpl: messagesFixture(fixture), fetchImpl: async () => { fetches++; return response('x'); } });
  assert.equal(fetches, 10); assert.equal(result.decisions[0].attachments.length, 10);
  const first = result.decisions[0].attachments[0].path;
  assert.ok(path.resolve(first).startsWith(path.resolve(dir, '.claude', 'inbox-attachments') + path.sep));
  assert.equal(path.basename(first).includes('..'), false);
  const dry = await intake({ home: home(), now: new Date('2026-08-31T12:00:00Z'), channelId: '123', dryRun: true, fetchMessagesImpl: messagesFixture(fixture), fetchImpl: async () => { throw new Error('must not run'); } });
  assert.equal(dry.decisions[0].attachments.length, 10);
});

test('cleanup removes attachment directories older than 30 days only', () => {
  const dir = home(); const root = path.join(dir, '.claude', 'inbox-attachments');
  const oldDir = path.join(root, 'old'); const freshDir = path.join(root, 'fresh');
  fs.mkdirSync(oldDir, { recursive: true }); fs.mkdirSync(freshDir, { recursive: true });
  fs.utimesSync(oldDir, new Date('2026-07-01T00:00:00Z'), new Date('2026-07-01T00:00:00Z'));
  fs.utimesSync(freshDir, new Date('2026-08-15T00:00:00Z'), new Date('2026-08-15T00:00:00Z'));
  assert.equal(cleanupOldAttachments({ home: dir, now: new Date('2026-08-31T00:00:00Z') }), 1);
  assert.equal(fs.existsSync(oldDir), false); assert.equal(fs.existsSync(freshDir), true);
});
