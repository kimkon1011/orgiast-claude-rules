import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDiscordMembers, matchMember, normalizeName } from './discord-member-directory.mjs';

const members = [
  { id: '1', username: 'taro.dev', global_name: '山田 太郎', nick: '太郎' },
  { id: '2', username: 'taroko', global_name: '山田 花子', nick: null },
];

test('normalizeName は空白・大小・全角・記号を畳む', () => assert.equal(normalizeName(' ＠Ｔaro　.Dev '), 'tarodev'));
test('matchMember は一意な完全一致を返す', () => assert.deepEqual(matchMember('山田 太郎', members), { id: '1', label: '山田 太郎' }));
test('matchMember は候補なしなら null', () => assert.equal(matchMember('鈴木', members), null));
test('matchMember は複数候補なら推測しない', () => assert.equal(matchMember('山田', members), null));
test('matchMember はメールの @ より前を照合する', () => assert.deepEqual(matchMember('taro.dev@example.com', members), { id: '1', label: 'taro.dev' }));
test('matchMember は先頭 @ をメールと誤認しない', () => assert.deepEqual(matchMember('@taro.dev', members), { id: '1', label: 'taro.dev' }));

function response(status, body) { return { status, ok: status >= 200 && status < 300, json: async () => body }; }
function tempHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-directory-'));
  fs.mkdirSync(path.join(home, '.claude'));
  fs.writeFileSync(path.join(home, '.claude', 'orgiast-discord-bot-token.txt'), 'test-token\n');
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

test('検索語を段階的に短くし、2回目の候補を返す', async (t) => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url.searchParams.get('query'));
    return response(200, calls.length === 1 ? [] : [{ user: { id: '1', username: 'taro' }, nick: '山田' }]);
  };
  const result = await getDiscordMembers({ query: '山田千絵美@example.com', home: tempHome(t), fetchImpl });
  assert.deepEqual(calls, ['山田千絵美examplecom', '山田千絵美']);
  assert.equal(result[0].id, '1');
});

test('候補0件なら最大3回で打ち切る', async (t) => {
  const calls = [];
  await getDiscordMembers({ query: 'abcdef@example.com', home: tempHome(t), fetchImpl: async (url) => { calls.push(url.searchParams.get('query')); return response(200, []); } });
  assert.deepEqual(calls, ['abcdefexamplecom', 'abcdef', 'ab']);
});

test('同じ検索語の24時間以内のキャッシュを使い、期限後は再取得する', async (t) => {
  const home = tempHome(t);
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return response(200, [{ user: { id: String(calls), username: 'taro' } }]); };
  const now = new Date('2026-09-06T00:00:00Z');
  assert.equal((await getDiscordMembers({ query: 'taro', home, now, fetchImpl }))[0].id, '1');
  assert.equal((await getDiscordMembers({ query: 'taro', home, now: new Date(now.getTime() + 23 * 60 * 60 * 1000), fetchImpl }))[0].id, '1');
  assert.equal(calls, 1);
  assert.equal((await getDiscordMembers({ query: 'taro', home, now: new Date(now.getTime() + 25 * 60 * 60 * 1000), fetchImpl }))[0].id, '2');
  assert.equal(calls, 2);
});

test('403 は例外にせず null を返す', async (t) => {
  const original = console.error;
  const errors = [];
  console.error = (message) => errors.push(message);
  t.after(() => { console.error = original; });
  const result = await getDiscordMembers({ query: '山田', home: tempHome(t), fetchImpl: async () => response(403, { message: 'Missing Access' }) });
  assert.equal(result, null);
  assert.deepEqual(errors, ['discord-member-directory: メンバー検索が 403 で失敗（Bot の権限を確認）']);
});
