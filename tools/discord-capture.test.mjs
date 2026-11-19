import test from 'node:test';
import assert from 'node:assert/strict';
import { capture, main, transformMessage } from './discord-capture.mjs';

const baseMessage = {
  id: '123456789',
  timestamp: '2026-11-20T01:02:03.000Z',
  content: ' hello ',
  author: { id: 'user-1', username: 'kim', global_name: 'Kim' },
};

test('transformMessage builds the external id and attachment metadata', () => {
  const result = transformMessage('channel-1', {
    ...baseMessage,
    attachments: [{ id: 'file-1', filename: 'brief.pdf', url: 'https://cdn.test/brief.pdf', content_type: 'application/pdf', size: 42 }],
  });
  assert.equal(result.external_message_id, 'discord:channel-1:123456789');
  assert.equal(result.sender_identifier, 'user-1');
  assert.equal(result.body, 'hello');
  assert.deepEqual(result.attachments, [{ name: 'brief.pdf', url: 'https://cdn.test/brief.pdf', mime: 'application/pdf', size: 42 }]);
});

test('transformMessage skips an empty body', () => {
  assert.equal(transformMessage('channel-1', { ...baseMessage, content: '  ', attachments: [{ url: 'https://cdn.test/a' }] }), null);
});

test('capture mocks Discord fetch and ingest POST', async () => {
  const posts = [];
  const fetchCalls = [];
  const writes = [];
  const result = await capture({
    env: {
      DISCORD_CAPTURE_CHANNEL_IDS: 'channel-1, channel-2',
      DISCORD_BOT_TOKEN: 'discord-token',
      APP_URL: 'https://app.test/',
      CRON_SECRET: 'cron-secret',
      DISCORD_CAPTURE_STATE_FILE: 'state.json',
    },
    now: Date.parse('2026-11-20T03:00:00Z'),
    readFile: () => JSON.stringify({ channels: { 'channel-1': '2026-11-20T01:30:00Z' } }),
    writeFile: (...args) => writes.push(args),
    fetchMessagesImpl: async (options) => {
      fetchCalls.push(options);
      return { messages: [{ ...baseMessage, id: options.channelId === 'channel-1' ? '1' : '2' }] };
    },
    fetchImpl: async (url, options) => {
      posts.push({ url, options });
      return new Response('{}', { status: 200 });
    },
  });

  assert.deepEqual(result, { dry_run: false, channels: 2, messages: 2 });
  assert.equal(fetchCalls[0].since, Date.parse('2026-11-20T01:30:00Z') + 1);
  assert.equal(fetchCalls[1].since, Date.parse('2026-11-20T01:00:00Z'));
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, 'https://app.test/api/external/discord-ingest');
  assert.equal(posts[0].options.headers.Authorization, 'Bearer cron-secret');
  assert.equal(JSON.parse(posts[0].options.body).messages.length, 2);
  assert.equal(writes.length, 1);
});

test('dry-run does not POST or write state', async () => {
  let outbound = 0;
  const result = await capture({
    dryRun: true,
    env: { DISCORD_CAPTURE_CHANNEL_IDS: 'channel-1', DISCORD_BOT_TOKEN: 'x', APP_URL: 'https://app.test', CRON_SECRET: 'y' },
    fetchMessagesImpl: async () => ({ messages: [baseMessage] }),
    fetchImpl: async () => { outbound++; throw new Error('must not POST'); },
    writeFile: () => { outbound++; },
  });
  assert.equal(result.messages, 1);
  assert.equal(outbound, 0);
});

test('missing configuration is a successful skip', async () => {
  const logs = [];
  const original = console.log;
  console.log = (value) => logs.push(value);
  try {
    assert.equal(await main(['--dry-run'], { env: {} }), 0);
  } finally {
    console.log = original;
  }
  assert.match(logs[0], /^skip: /);
});
