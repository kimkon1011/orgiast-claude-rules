import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { watchFleetMail, run } from './auto-progress-watch.mjs';

function makeSent(rows) {
  return Object.fromEntries(rows.map(([id, status, resultBody, kind = 'prompt', from = 'nishi-PC', to = 'kim-PC', extra = {}]) =>
    [id, { id, kind, status, resultBody, from, to, why: '調査', ...extra }]));
}

test('kim-PC: expired/failed/blocked prompts を通知せず、fleet-chase に任せる', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-kim-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, '.claude'); fs.mkdirSync(dir);
  const now = Date.parse('2026-11-02T00:00:00Z');
  const recent = new Date(now - 3600000).toISOString();
  const sent = makeSent([
    ['m1', 'expired', '', 'prompt', 'kim-PC', 'nishi-PC', { expiresAt: recent }],
    ['m2', 'failed', '', 'prompt', 'kim-PC', 'nishi-PC', { expiresAt: recent }],
    ['m3', 'done', 'BLOCKED', 'prompt', 'kim-PC', 'nishi-PC', { expiresAt: recent }],
  ]);
  fs.writeFileSync(path.join(dir, 'fleet-mail-sent-status.json'), JSON.stringify(sent));
  let notifyCalls = 0;
  const opts = { home, now, io: { label: 'kim-PC', notifyOwner: async () => { notifyCalls++; return { delivered: 'dm' }; } } };
  const s1 = await watchFleetMail({ ...opts, dryRun: true });
  assert.equal(s1.fleetExpired + s1.fleetBlocked, 3);
  assert.equal(notifyCalls, 0);
  const s2 = await watchFleetMail(opts);
  assert.equal(s2.fleetExpired + s2.fleetBlocked, 3);
  assert.equal(notifyCalls, 0); // kim-PC は通知しない
  const notified = JSON.parse(fs.readFileSync(path.join(dir, 'auto-progress-fleet-notified.json'), 'utf8'));
  assert.equal(notified.m1.handledAt !== undefined, true);
});

test('non-kim-PC: 止まったpromptを1回だけ自動再送する', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-retry-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, '.claude'); fs.mkdirSync(dir);
  fs.mkdirSync(path.join(dir, 'logs'));
  const now = Date.parse('2026-11-02T00:00:00Z');
  const recent = new Date(now - 3600000).toISOString();
  const sent = makeSent([
    ['m1', 'expired', '', 'prompt', 'nishi-PC', 'cr-PC', { expiresAt: recent, body: '依頼本文' }],
  ]);
  fs.writeFileSync(path.join(dir, 'fleet-mail-sent-status.json'), JSON.stringify(sent));
  const sentMails = [];
  const opts = { home, now, io: { label: 'nishi-PC',
    sendMail: async p => { sentMails.push(p); },
    notifyOwner: async () => { assert.fail('通知してはいけない'); },
  } };
  const s1 = await watchFleetMail(opts);
  assert.equal(s1.fleetExpired, 1);
  assert.equal(sentMails.length, 1);
  assert.match(sentMails[0].why, /^\[自動再送\]/);
  assert.equal(sentMails[0].to, 'cr-PC');
  // 2回目の巡回では再送しない
  const s2 = await watchFleetMail(opts);
  assert.equal(s2.fleetExpired, 1);
  assert.equal(sentMails.length, 1);
  // 再送失敗しても2回目以降は再送しない（exhausted ログが出る）
  sentMails.length = 0;
  const s3 = await watchFleetMail(opts);
  assert.equal(s3.fleetExpired, 1);
  assert.equal(sentMails.length, 0);
  // exhausted ログが書かれている
  assert.match(fs.readFileSync(path.join(dir, 'logs', 'auto-progress-watch.log'), 'utf8'), /fleet-retry-exhausted/);
});

test('自分宛てのメールは無視する', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-self-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, '.claude'); fs.mkdirSync(dir);
  const now = Date.parse('2026-11-02T00:00:00Z');
  const recent = new Date(now - 3600000).toISOString();
  const sent = makeSent([
    ['self', 'expired', '', 'prompt', 'nishi-PC', 'nishi-PC', { expiresAt: recent }],
    ['self2', 'expired', '', 'prompt', 'nishi-PC', 'nishi-PC', { expiresAt: recent }],
  ]);
  fs.writeFileSync(path.join(dir, 'fleet-mail-sent-status.json'), JSON.stringify(sent));
  let calls = 0;
  const s = await watchFleetMail({ home, now, io: { label: 'nishi-PC',
    sendMail: async () => { calls++; },
  } });
  assert.equal(calls, 0);
  assert.equal(s.fleetExpired + s.fleetBlocked, 0);
});

test('kind=note は対象外', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-note-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, '.claude'); fs.mkdirSync(dir);
  const now = Date.parse('2026-11-02T00:00:00Z');
  const recent = new Date(now - 3600000).toISOString();
  const sent = makeSent([
    ['note-expired', 'expired', '', 'note', 'nishi-PC', 'cr-PC', { expiresAt: recent }],
    ['note-done', 'done', 'BLOCKED', 'note', 'nishi-PC', 'cr-PC', { expiresAt: recent }],
  ]);
  fs.writeFileSync(path.join(dir, 'fleet-mail-sent-status.json'), JSON.stringify(sent));
  let calls = 0;
  const s = await watchFleetMail({ home, now, io: { label: 'nishi-PC',
    sendMail: async () => { calls++; },
  } });
  assert.equal(calls, 0);
  assert.equal(s.fleetExpired + s.fleetBlocked, 0);
});

test('mail-chase- ID は対象外', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-chaseid-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, '.claude'); fs.mkdirSync(dir);
  const now = Date.parse('2026-11-02T00:00:00Z');
  const recent = new Date(now - 3600000).toISOString();
  const sent = makeSent([
    ['mail-chase-abc', 'expired', '', 'prompt', 'nishi-PC', 'cr-PC', { expiresAt: recent }],
  ]);
  fs.writeFileSync(path.join(dir, 'fleet-mail-sent-status.json'), JSON.stringify(sent));
  let calls = 0;
  const s = await watchFleetMail({ home, now, io: { label: 'nishi-PC',
    sendMail: async () => { calls++; },
  } });
  assert.equal(calls, 0);
  assert.equal(s.fleetExpired + s.fleetBlocked, 0);
});

test('fleet-chase 台帳にあるIDは対象外', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-chasedid-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, '.claude'); fs.mkdirSync(dir);
  const now = Date.parse('2026-11-02T00:00:00Z');
  const recent = new Date(now - 3600000).toISOString();
  const sent = makeSent([
    ['chased-mail', 'expired', '', 'prompt', 'nishi-PC', 'cr-PC', { expiresAt: recent }],
  ]);
  fs.writeFileSync(path.join(dir, 'fleet-mail-sent-status.json'), JSON.stringify(sent));
  let calls = 0;
  const s = await watchFleetMail({ home, now, io: { label: 'nishi-PC',
    fleetChaseMailIds: ['chased-mail'],
    sendMail: async () => { calls++; },
  } });
  assert.equal(calls, 0);
  assert.equal(s.fleetExpired + s.fleetBlocked, 0);
});

test('既存テスト互換: 従来のフィルタ条件を維持し、通知ではなく再送になる', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'progress-fleet-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, '.claude'); fs.mkdirSync(dir);
  const now = Date.parse('2026-10-26T00:00:00Z');
  const recent = new Date(now - 3600000).toISOString();
  const rows = Object.fromEntries([
    ['expired', 'expired', ''], ['failed', 'failed', ''], ['blocker', 'done', 'BLOCKED'],
    ['unperformed', 'done', '判定不能（未実施）'], ['empty', 'done', ' '], ['ok', 'done', '完了しました'],
  ].map(([id, status, resultBody]) => [id, { id, kind: 'prompt', status, resultBody,
    from: 'nishi-PC', to: 'kim-PC', why: '調査', expiresAt: recent, body: '依頼本文' }]));
  rows.foreign = { id: 'foreign', from: 'other-PC', status: 'expired', expiresAt: recent };
  rows.old = { id: 'old', from: 'nishi-PC', kind: 'prompt', status: 'expired',
    expiresAt: new Date(now - 8 * 86400000).toISOString() };
  rows.note = { id: 'note', from: 'nishi-PC', kind: 'note', status: 'done', resultBody: '', expiresAt: recent };
  rows['mail-reply-x'] = { id: 'mail-reply-x', from: 'nishi-PC', kind: 'prompt', status: 'expired', expiresAt: recent };
  fs.writeFileSync(path.join(dir, 'fleet-mail-sent-status.json'), JSON.stringify(rows));
  let notifyCalls = 0;
  const sentMails = [];
  const opts = { home, now, io: { label: 'nishi-PC',
    notifyOwner: async () => { notifyCalls++; return { delivered: 'dm' }; },
    sendMail: async p => { sentMails.push(p); },
  } };
  // dryRun: カウントだけ確認（従来と同じ expired=1, blocked=4）
  assert.deepEqual(await watchFleetMail({ ...opts, dryRun: true }), { fleetExpired: 1, fleetBlocked: 4 });
  // 実実行: 自動再送される（5件 = expired + failed + blocker + unperformed + empty）
  const s = await watchFleetMail(opts);
  assert.equal(s.fleetExpired, 1);
  assert.equal(s.fleetBlocked, 4);
  assert.equal(notifyCalls, 0); // nishi-PC は通知ではなく再送
  assert.equal(sentMails.length, 5);
  assert.equal(sentMails.every(m => m.why.startsWith('[自動再送]')), true);
  assert.equal(sentMails.every(m => m.to === 'kim-PC'), true);
  // 古い(7日超)・note・foreign・mail-reply-x・ok は対象外
  const ids = new Set(sentMails.map(m => m.id));
  assert.equal(ids.has('old-retry-1'), false);
  assert.equal(ids.has('note-retry-1'), false);
  assert.equal(ids.has('foreign-retry-1'), false);
  assert.equal(ids.has('mail-reply-x-retry-1'), false);
  assert.equal(ids.has('ok-retry-1'), false);
});