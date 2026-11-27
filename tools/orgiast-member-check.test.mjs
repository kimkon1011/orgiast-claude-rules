import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isOrgiastMember, ORGIAST_GUILD_ID } from './lib/orgiast-member-check.mjs';

const USER = '123456789012345678';
const NOW = Date.parse('2026-11-28T04:00:00Z');
const TTL = 6 * 60 * 60 * 1000;
function fixture() {
  // Keep test artifacts: this task explicitly prohibits deleting files.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'orgiast-member-'));
  return { home, now: NOW, token: 'test-only-token' };
}
const cacheFile = home => path.join(home, '.claude', 'orgiast-guild-member-cache.json');

for (const [status, expected] of [[200, true], [404, false], [401, null], [403, null], [429, null], [500, null], [503, null]]) {
  test(`member API ${status} => ${expected}`, async () => {
    const options = fixture();
    const fetchImpl = async (url, init) => {
      assert.equal(url, `https://discord.com/api/v10/guilds/${ORGIAST_GUILD_ID}/members/${USER}`);
      assert.equal(init.headers.Authorization, 'Bot test-only-token');
      return { status };
    };
    assert.equal(await isOrgiastMember(USER, { ...options, fetchImpl }), expected);
    assert.equal(fs.existsSync(cacheFile(options.home)), expected !== null);
  });
}

test('fetch exception returns null without logging the error or caching it', async t => {
  const options = fixture(), logs = [];
  t.mock.method(console, 'error', (...args) => logs.push(args));
  t.mock.method(console, 'log', (...args) => logs.push(args));
  assert.equal(await isOrgiastMember(USER, { ...options, fetchImpl: async () => { throw new Error(options.token); } }), null);
  assert.deepEqual(logs, []);
  assert.equal(fs.existsSync(cacheFile(options.home)), false);
});

for (const status of [200, 404]) {
  test(`TTL caches ${status} and refreshes at expiry`, async () => {
    const options = fixture();
    let calls = 0;
    const fetchImpl = async () => { calls++; return { status }; };
    const expected = status === 200;
    assert.equal(await isOrgiastMember(USER, { ...options, fetchImpl }), expected);
    assert.equal(await isOrgiastMember(USER, { ...options, now: NOW + TTL - 1, fetchImpl }), expected);
    assert.equal(calls, 1);
    assert.equal(await isOrgiastMember(USER, { ...options, now: NOW + TTL, fetchImpl }), expected);
    assert.equal(calls, 2);
  });
}

test('null is retried and cannot renew an expired positive cache', async () => {
  const options = fixture();
  await isOrgiastMember(USER, { ...options, fetchImpl: async () => ({ status: 200 }) });
  const before = fs.readFileSync(cacheFile(options.home), 'utf8');
  let calls = 0;
  const fetchImpl = async () => { calls++; return { status: 429 }; };
  for (let i = 0; i < 2; i++) {
    assert.equal(await isOrgiastMember(USER, { ...options, now: NOW + TTL, fetchImpl }), null);
  }
  assert.equal(calls, 2);
  assert.equal(fs.readFileSync(cacheFile(options.home), 'utf8'), before);
});

test('persistCache=false does not create a cache', async () => {
  const options = fixture();
  assert.equal(await isOrgiastMember(USER, { ...options, persistCache: false, fetchImpl: async () => ({ status: 200 }) }), true);
  assert.equal(fs.existsSync(cacheFile(options.home)), false);
});

test('token uses environment before the home file; missing token fails closed', async t => {
  const options = fixture();
  fs.mkdirSync(path.join(options.home, '.claude'));
  fs.writeFileSync(path.join(options.home, '.claude', 'orgiast-discord-bot-token.txt'), ' test-file-token\n');
  const original = process.env.DISCORD_BOT_TOKEN;
  t.after(() => { if (original === undefined) delete process.env.DISCORD_BOT_TOKEN; else process.env.DISCORD_BOT_TOKEN = original; });
  const headers = [];
  const fetchImpl = async (_url, init) => { headers.push(init.headers.Authorization); return { status: 200 }; };
  process.env.DISCORD_BOT_TOKEN = ' test-env-token ';
  await isOrgiastMember(USER, { ...options, token: undefined, persistCache: false, fetchImpl });
  process.env.DISCORD_BOT_TOKEN = '';
  await isOrgiastMember(USER, { ...options, token: undefined, persistCache: false, fetchImpl });
  assert.deepEqual(headers, ['Bot test-env-token', 'Bot test-file-token']);
  assert.equal(await isOrgiastMember(USER, { ...fixture(), token: undefined, fetchImpl: () => assert.fail('no token') }), null);
});

test('invalid user ID never reaches fetch', async () => {
  for (const id of [null, '', '828', '../members', '123456789012345678?x=1']) {
    assert.equal(await isOrgiastMember(id, { ...fixture(), fetchImpl: () => assert.fail('invalid ID') }), null);
  }
});
