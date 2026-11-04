import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from './auto-progress-digest.mjs';
import { notifyKim, KIM_DISCORD_USER_ID } from './notify-kim.mjs';

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'digest-recipient-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const owner = 'seisaku-team@orgiast.jp';
  const now = Date.parse('2026-11-04T03:00:00Z');
  const rows = Array.from({ length: 4 }, (_, i) => ({ sessionId: 'session-' + i, promise: '秘密の本文' + i,
    owner, status: 'open', ts: '2026-10-28T00:00:00Z', nextKim: '承認' + 'あ'.repeat(100), resumeOutcome: 'needs_user' }));
  rows.push({ sessionId: 'progress', promise: '非公開の進捗本文', owner, status: 'open', ts: '2026-10-28T00:00:00Z', nextKim: 'なし' });
  const calls = [];
  const io = { label: 'DESKTOP-BDOAK99', localOwner: owner, readLedger: () => rows,
    resolveOwnerDiscordId: () => '', notify: async () => ({ delivered: 'inbox' }),
    notifyKim: async (text, options) => { calls.push({ text, options }); return { delivered: 'dm', messageId: 'warning' }; } };
  return { home, now, io, calls };
}

test('未解決警告は永続状態で1日1回、通常配信のスキップ後も翌日に出る', async t => {
  const f = fixture(t);
  await run(f);
  await run({ ...f, now: f.now + 3600000 });
  assert.equal(f.calls.length, 1);
  const { text, options } = f.calls[0];
  assert.match(text, /DESKTOP-BDOAK99（seisaku-team@orgiast.jp）.*承認待ち 4 件・進捗 1 件/);
  assert.equal(text.split('\n').length, 4);
  for (const line of text.split('\n').slice(1)) assert.equal(Array.from(line.slice(1)).length, 80);
  assert.doesNotMatch(text, /秘密の本文|非公開の進捗本文/);
  assert.equal(options.userId, KIM_DISCORD_USER_ID);
  assert.equal(options.webhookFallback, false);
  assert.equal(options.silent, false);
  const state = JSON.parse(fs.readFileSync(path.join(f.home, '.claude/state/auto-progress-digest.json')));
  assert.equal(Object.values(state.recipientWarnings)[0].day, '2026-11-04');
  await run({ ...f, now: f.now + 86400000 });
  assert.equal(f.calls.length, 2);
});

test('解決済み・dry-run・対象行なしでは警告しない', async t => {
  for (const mode of ['resolved', 'dry', 'empty']) {
    const f = fixture(t);
    if (mode === 'resolved') f.io.resolveOwnerDiscordId = () => '123';
    if (mode === 'empty') f.io.readLedger = () => [];
    await run({ ...f, dryRun: mode === 'dry' });
    assert.equal(f.calls.length, 0, mode);
  }
});

test('警告失敗も日次抑制し、通常のフォールバックを妨げない', async t => {
  const f = fixture(t);
  let count = 0;
  f.io.notifyKim = async () => { count++; throw new Error('timeout'); };
  assert.equal((await run(f)).sent, true);
  await run(f);
  assert.equal(count, 1);
});

test('同時実行でも警告1回', async t => {
  const f = fixture(t);
  await Promise.all([run(f), run(f)]);
  assert.equal(f.calls.length, 1);
});

test('専用警告は notify-kim の実経路で DM を送る（HTTP はスタブ）', async t => {
  const f = fixture(t);
  await run(f);
  const requests = [];
  const { options } = f.calls[0];
  const text = f.calls[0].text.split('\n')[0] + '\n・PR のマージをお願いします';
  const result = await notifyKim(text, { ...options, token: 'test-token', fetchImpl: async (url, init) => {
    requests.push({ url, body: JSON.parse(init.body) });
    return { ok: true, status: 200, json: async () => ({ id: requests.length === 1 ? 'channel' : 'message' }) };
  } });
  assert.equal(result.delivered, 'dm');
  assert.equal(requests[0].body.recipient_id, KIM_DISCORD_USER_ID);
  assert.equal(requests[1].body.content, text);
  assert.equal(fs.existsSync(path.join(f.home, '.claude/next-session.md')), false);
});

test('正本の PENDING を解決し、旧警告と重複せずローカルへ保存する', async t => {
  const f = fixture(t);
  delete f.io.notify;
  const { notifyOwner, resolveOwnerDiscordId } = await import('./notify-owner.mjs');
  // 正本の宛先が埋まっても検証できるよう、PENDING の PC 行を固定で渡す。
  const pcMap = { 'DESKTOP-BDOAK99': { hostname: 'DESKTOP-BDOAK99', account: 'seisaku-team@orgiast.jp', notifyDiscordId: 'PENDING' } };
  f.io.resolveOwnerDiscordId = (owner, options) => resolveOwnerDiscordId(owner, { ...options, pcMap, directory: [] });
  f.io.notifyOwner = (owner, text, options) => notifyOwner(owner, text, { ...options, pcMap, directory: [],
    toast: () => false, notifyKim: () => assert.fail('旧警告を重複送信しない'),
    notify: () => assert.fail('PENDING 宛へ本文を送らない') });
  await run(f);
  assert.equal(f.calls.length, 1);
  assert.match(fs.readFileSync(path.join(f.home, '.claude/owner-inbox.md'), 'utf8'), /秘密の本文/);
});

test('日付境界は JST、復旧後は翌日の警告を送らない', async t => {
  const f = fixture(t);
  await run({ ...f, now: Date.parse('2026-11-04T14:59:00Z') });
  await run({ ...f, now: Date.parse('2026-11-04T15:00:00Z') });
  assert.equal(f.calls.length, 2);
  f.io.resolveOwnerDiscordId = () => '123';
  await run({ ...f, now: Date.parse('2026-11-05T15:00:00Z') });
  assert.equal(f.calls.length, 2);
});
