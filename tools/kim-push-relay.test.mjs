import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runRelay, urgentBody, digestBody, isUrgent } from './kim-push-relay.mjs';
import { KIM_DISCORD_USER_ID } from './notify-kim.mjs';
const time = '2026-11-01T00:00:00Z'; // JST 09:00
const msg = (id, content, author = 'bot') => ({ id: String(id), content, author: { id: author }, timestamp: time });
function setup(t, state = { channelId: 'dm', lastMessageId: '1' }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kim-relay-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, '.claude/state'); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'kim-push-relay.json');
  if (state) fs.writeFileSync(file, JSON.stringify(state));
  const sent = [], alerts = [], requests = [];
  const deps = { home, now: Date.parse(time), resolveDiscordBotToken: () => 'test-token',
    fetch: async (url, options) => { requests.push({ url, options }); return { ok: true, json: async () => url.includes('/users/') ? { id: 'dm' } : [] }; },
    pushKim: async body => { sent.push(body); return { ok: true }; },
    deliverKim: async (body, options) => { alerts.push({ body, options }); return { delivered: 'dm' }; }, log: () => {},
  };
  const messages = list => { deps.fetch = async url => { requests.push({ url }); return { ok: true, json: async () => list }; }; };
  return { deps, sent, alerts, requests, messages, file, dir, read: () => JSON.parse(fs.readFileSync(file, 'utf8')) };
}
test('初回は最新IDを記録するだけで通知しない', async t => {
  const s = setup(t, null);
  s.deps.fetch = async url => ({ ok: true, json: async () => url.includes('/users/') ? { id: 'dm' } : [msg(12, '緊急')] });
  assert.equal((await runRelay(s.deps)).initialized, true);
  assert.equal(s.read().lastMessageId, '12'); assert.equal(s.sent.length, 0);
});
test('本人を除外し、別のパソコン通知は警告でもdigestへ振り分ける', async t => {
  const s = setup(t); s.deps.now = Date.parse('2026-10-31T22:30:00Z');
  s.messages([msg(4, '別のパソコンで緊急'), msg(3, '期限です'), msg(2, '至急', KIM_DISCORD_USER_ID)]);
  await runRelay(s.deps);
  assert.equal(s.sent.length, 1); assert.match(s.sent[0], /期限です/);
  assert.equal(s.read().pending[0].firstLine, '別のパソコンで緊急');
  assert.equal(s.read().lastMessageId, '4');
  assert.equal(isUrgent('通常報告'), false);
});
test('静音時間は保留し緊急語だけ通し、07時に保留分を再送する', async t => {
  const s = setup(t); s.deps.now = Date.parse('2026-11-01T14:00:00Z');
  s.messages([msg(2, '警告'), msg(3, '🚨 至急')]);
  await runRelay(s.deps);
  assert.equal(s.sent.length, 1); assert.match(s.sent[0], /🚨 至急/);
  assert.equal(s.read().urgentQueue.length, 1);
  s.messages([]); s.deps.now = Date.parse('2026-11-01T22:00:00Z');
  await runRelay(s.deps);
  assert.equal(s.read().urgentQueue.length, 0); assert.match(s.sent[1], /警告/);
});
test('1件・複数件の見出しは120字以内、本文に全文とリンクを残す', () => {
  const m = { id: '2', ts: time, content: '警告\n詳細' };
  assert.equal(urgentBody([m], 'dm').split('\n')[0], '【要対応】警告');
  assert.equal(urgentBody([m, m], 'dm').split('\n')[0], '【要対応 2件】警告 ほか');
  assert.match(urgentBody([m], 'dm'), /11\/1 09:00（JST）\n警告\n詳細/);
  assert.match(urgentBody([m], 'dm'), /https:\/\/discord.com\/channels\/@me\/dm\/2/);
  assert.equal(urgentBody([{ ...m, content: '警'.repeat(200) }], 'dm').split('\n')[0].length, 120);
});
test('失敗しても取得位置を保存、urgentQueueは成功時だけ消し3回目だけDiscord通知', async t => {
  const s = setup(t); s.messages([msg(2, '警告')]);
  const logs = []; s.deps.log = text => logs.push(text);
  s.deps.pushKim = async () => ({ ok: false, reason: 'テスト失敗' });
  await runRelay(s.deps); assert.equal(s.read().lastMessageId, '2');
  s.messages([]);
  for (let i = 0; i < 3; i++) await runRelay(s.deps);
  assert.equal(s.read().urgentQueue.length, 1); assert.equal(s.read().failures, 4);
  assert.equal(s.alerts.length, 1); assert.equal(s.alerts[0].options.silent, false);
  assert.deepEqual(logs, Array(4).fill('kim-push 失敗: テスト失敗'));
  assert.match(s.alerts[0].body, /3回連続で失敗: テスト失敗/);
  s.deps.pushKim = async () => ({ ok: true }); await runRelay(s.deps);
  assert.equal(s.read().urgentQueue.length, 0); assert.equal(s.read().failures, 0);
  assert.equal(s.read().pushLog.length, 1);
});
test('取得例外の理由にはメッセージを残しBotトークンは伏せ字にする', async t => {
  const s = setup(t);
  const token = 'test-bot-token';
  s.deps.fetch = async () => { throw new Error(`取得できません token=${token}`); };
  const result = await runRelay(s.deps);
  assert.equal(result.ok, false);
  assert.equal(result.reason, '通知中継に失敗: 取得できません token=[REDACTED]');
  assert.ok(!result.reason.includes(token));
});
test('push失敗ログは秘密値を伏せ字にして1行で出す', async t => {
  const s = setup(t); s.messages([msg(2, '警告')]);
  const logs = []; s.deps.log = text => logs.push(text);
  s.deps.pushKim = async () => ({ ok: false, reason: '接続失敗\r\ntoken=test-bot-token' });
  await runRelay(s.deps);
  assert.deepEqual(logs, ['kim-push 失敗: 接続失敗 token=[REDACTED]']);
});
test('08時・18時のdigestは各1回、失敗時はpendingとslotを維持', async t => {
  const s = setup(t); s.messages([msg(2, '報告')]);
  s.deps.now = Date.parse('2026-10-31T23:00:00Z');
  s.deps.pushKim = async () => ({ ok: false }); await runRelay(s.deps);
  assert.equal(s.read().pending.length, 1); assert.equal(s.read().lastDigestSlot, undefined);
  s.messages([]); s.deps.pushKim = async body => { s.sent.push(body); return { ok: true }; };
  await runRelay(s.deps); assert.equal(s.read().lastDigestSlot, '2026-11-01-08');
  s.messages([msg(3, '報告')]); await runRelay(s.deps); assert.equal(s.sent.length, 1);
  s.messages([]); s.deps.now = Date.parse('2026-11-01T09:00:00Z');
  await runRelay(s.deps); assert.equal(s.sent.length, 2); assert.equal(s.read().lastDigestSlot, '2026-11-01-18');
  await runRelay(s.deps); assert.equal(s.sent.length, 2);
  s.messages([msg(4, '翌日報告')]); s.deps.now = Date.parse('2026-11-01T23:00:00Z');
  await runRelay(s.deps); assert.equal(s.sent.length, 3);
});
test('直近60分12件で保留、期限を過ぎれば再送し24時間前のログを捨てる', async t => {
  const s = setup(t, { channelId: 'dm', lastMessageId: '1', pushLog: [...Array(12).fill(time), '2026-10-30T00:00:00Z'] });
  s.messages([msg(2, '警告')]); await runRelay(s.deps);
  assert.equal(s.sent.length, 0); assert.equal(s.read().urgentQueue.length, 1); assert.equal(s.read().pushLog.length, 12);
  s.messages([]); s.deps.now += 3_600_000; await runRelay(s.deps); assert.equal(s.sent.length, 1);
});
test('ロック中は何もせず古いロックだけ奪う', async t => {
  const s = setup(t); const lock = path.join(s.dir, 'kim-push-relay.lock');
  fs.writeFileSync(lock, ''); fs.utimesSync(lock, new Date(s.deps.now), new Date(s.deps.now));
  assert.equal((await runRelay(s.deps)).locked, true); assert.equal(s.requests.length, 0);
  for (const minutes of [16, 25]) {
    fs.utimesSync(lock, new Date(s.deps.now - minutes * 60_000), new Date(s.deps.now - minutes * 60_000));
    assert.equal((await runRelay(s.deps)).locked, true); assert.equal(s.requests.length, 0);
    assert.equal(fs.existsSync(lock), true);
  }
  fs.utimesSync(lock, new Date(s.deps.now - 25 * 60_000 - 1), new Date(s.deps.now - 25 * 60_000 - 1));
  await runRelay(s.deps); assert.equal(s.requests.length, 1); assert.equal(fs.existsSync(lock), false);
});
test('dry-runは本文を生成してもpushも状態変更もしない', async t => {
  const s = setup(t); const before = fs.readFileSync(s.file, 'utf8');
  s.messages([msg(2, '警告'), msg(3, '通常報告')]);
  const result = await runRelay({ ...s.deps, dryRun: true });
  assert.equal(result.bodies.length, 2); assert.equal(s.sent.length, 0);
  assert.equal(fs.readFileSync(s.file, 'utf8'), before);
  assert.deepEqual(fs.readdirSync(s.dir), ['kim-push-relay.json']);
});
test('digestは同じ先頭行を集計し件数降順で最大40行', () => {
  const pending = Array.from({ length: 45 }, (_, i) => ({ firstLine: `報告${i}`, ts: time }));
  pending.push({ firstLine: '報告20', ts: time });
  const lines = digestBody(pending).split('\n');
  assert.equal(lines.length, 41); assert.match(lines[0], /46件/); assert.match(lines[1], /報告20（×2、最新 11\/1 09:00）/);
});
test('100件を超える未読を取得しpendingは最新500件に制限する', async t => {
  const s = setup(t); s.deps.now = Date.parse('2026-10-31T22:00:00Z');
  let pages = 0;
  s.deps.fetch = async url => {
    const after = Number(new URL(url).searchParams.get('after')); pages++;
    return { ok: true, json: async () => after < 601 ? Array.from({ length: 100 }, (_, i) => msg(after + i + 1, '報告')).reverse() : [] };
  };
  await runRelay(s.deps);
  assert.equal(pages, 7); assert.equal(s.read().lastMessageId, '601');
  assert.equal(s.read().pending.length, 500); assert.equal(s.read().pending[0].id, '102');
});
