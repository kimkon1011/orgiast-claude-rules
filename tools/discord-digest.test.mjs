import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fetchMessages, formatDigest, parseSince, summarizeMessages, truncateToBudget, clipMessageBody } from './discord-digest.mjs';

const NOW = Date.parse('2026-08-27T12:00:00Z');
const message = (id, timestamp, author = '田中', content = '本文', extra = {}) => ({ id: String(id), timestamp, author: { username: author }, content, attachments: [], mentions: [], ...extra });

test('parseSince は相対期間とISOをepochへ変換し、不正値をnullにする', () => {
  assert.equal(parseSince('7d', NOW), NOW - 7 * 864e5);
  assert.equal(parseSince('2026-08-20T12:00:00Z', NOW), Date.parse('2026-08-20T12:00:00Z'));
  assert.equal(parseSince('not-a-date', NOW), null);
});

test('summarizeMessages は投稿者・添付・リンク・メンション・範囲を数える', () => {
  const rows = [
    message(1, '2026-08-26T01:00:00Z', '田中', 'https://a.example <@123>', { attachments: [{ id: 'a' }], mentions: [{ id: '123' }] }),
    message(2, '2026-08-27T02:00:00Z', '佐藤', 'https://b.example と https://c.example', { attachments: [{}, {}] }),
    message(3, '2026-08-27T03:00:00Z', '田中'),
  ];
  const got = summarizeMessages(rows, { channelId: '42' });
  assert.deepEqual(got.authors, [{ name: '田中', count: 2 }, { name: '佐藤', count: 1 }]);
  assert.equal(got.attachments, 3); assert.equal(got.links, 3); assert.equal(got.mentions, 1);
  assert.deepEqual(got.range, { from: rows[0].timestamp, to: rows[2].timestamp });
});

test('--since より古いメッセージを除外する', () => {
  const got = summarizeMessages([
    message(1, '2026-08-19T00:00:00Z'), message(2, '2026-08-21T00:00:00Z'),
  ], { since: Date.parse('2026-08-20T00:00:00Z') });
  assert.equal(got.fetched, 1); assert.equal(got.tail[0].id, '2');
});

test('--grep は一致だけを最大20件返し、省略数を表示する', () => {
  const rows = Array.from({ length: 25 }, (_, i) => message(i, new Date(NOW + i).toISOString(), '佐藤', `見積 ${i}`));
  const got = summarizeMessages(rows, { grep: '見積', tail: 0 });
  assert.equal(got.matches.length, 20); assert.equal(got.matchOmitted, 5);
  assert.match(formatDigest(got, { budgetChars: 10000 }), /…他 5 件省略/);
});

test('truncateToBudget は予算内に切り、省略件数を必ず示す', () => {
  const got = truncateToBudget(['一行目', '二行目', '三行目'].join('\n'), 10);
  assert.ok(got.length <= 10); assert.match(got, /…他 \d+ 件省略/);
});

test('fetchMessages は末尾idをbeforeにしてページングする', async () => {
  const calls = [];
  const pages = [
    Array.from({ length: 100 }, (_, i) => message(200 - i, new Date(NOW - i).toISOString())),
    Array.from({ length: 20 }, (_, i) => message(100 - i, new Date(NOW - 100 - i).toISOString())),
  ];
  const fetchImpl = async (url) => { calls.push(String(url)); return { ok: true, json: async () => pages[calls.length - 1] }; };
  const got = await fetchMessages({ channelId: '42', limit: 120, token: 'secret', fetchImpl });
  assert.equal(got.messages.length, 120); assert.equal(new URL(calls[1]).searchParams.get('before'), '101');
});

test('fetchMessages は必須ヘッダを付ける', async () => {
  let headers;
  const fetchImpl = async (_url, init) => { headers = init.headers; return { ok: true, json: async () => [] }; };
  await fetchMessages({ channelId: '42', token: 'runtime-value', fetchImpl });
  assert.equal(headers['User-Agent'], 'DiscordBot (https://orgiast.jp, 1.0)');
  assert.ok(headers.Authorization.startsWith('Bot '));
});

test('fetchMessages は1000件上限への到達を明示する', async () => {
  let cursor = 2000;
  const fetchImpl = async () => ({ ok: true, json: async () => Array.from({ length: 100 }, () => message(cursor--, new Date(NOW - cursor).toISOString())) });
  const got = await fetchMessages({ channelId: '42', limit: 1000, token: 'runtime-value', fetchImpl });
  assert.equal(got.messages.length, 1000); assert.equal(got.truncated, true);
});

test('digest は約60件の生JSONの25%未満になる', (t) => {
  const rows = Array.from({ length: 60 }, (_, i) => message(i, new Date(NOW - i * 60000).toISOString(), i % 2 ? '田中' : '佐藤', `${i}: ${'展示会の見積と進行確認です。'.repeat(16)}`));
  const raw = JSON.stringify(rows);
  const digest = formatDigest(summarizeMessages(rows, { channelId: '42', tail: 10 }), { budgetChars: 6000 });
  t.diagnostic(`JSON raw ${raw.length} chars -> digest ${digest.length} chars`);
  assert.ok(digest.length < raw.length * 0.25, `${digest.length} is not below 25% of ${raw.length}`);
});

test('--fixture はネットワークやトークンなしでCLI実行できる', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-digest-'));
  const fixture = path.join(dir, 'fixture.json');
  fs.writeFileSync(fixture, JSON.stringify([message(1, '2026-08-27T01:00:00Z')]));
  const script = fileURLToPath(new URL('./discord-digest.mjs', import.meta.url));
  const run = spawnSync(process.execPath, [script, '--fixture', fixture, '--channel', '42'], { encoding: 'utf8', env: { ...process.env, DISCORD_BOT_TOKEN: '' } });
  assert.equal(run.status, 0, run.stderr); assert.match(run.stdout, /直近 1 件/);
});

test('1通が巨大でも本文は上限で切り、全長を明示する', () => {
  // bot の長文レポート1通で予算を食い潰し「直近10件」が実質1件になるのを防ぐ。
  const huge = 'あ'.repeat(3000);
  const clipped = clipMessageBody(huge);
  assert.ok(clipped.length < 260, `切れていない: ${clipped.length}`);
  assert.ok(clipped.includes('全3000字'), '全長が明示されていない');
  assert.equal(clipMessageBody('短い本文'), '短い本文');
  assert.equal(clipMessageBody(''), '(本文なし)');

  // digest 全体でも、巨大な1通が他の9件を追い出さないこと
  const messages = Array.from({ length: 10 }, (_, i) => ({
    id: String(i + 1),
    author: { username: 'bot' },
    timestamp: new Date(Date.UTC(2026, 7, 27, i)).toISOString(),
    content: i === 5 ? huge : `通常のメッセージ ${i}`,
  }));
  const digest = formatDigest(summarizeMessages(messages, { tail: 10 }), { budgetChars: 6000 });
  const shown = digest.split('\n').filter((line) => line.startsWith('[')).length;
  assert.equal(shown, 10, `10件出るはずが ${shown} 件`);
});
