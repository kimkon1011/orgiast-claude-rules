import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyzeThread, analyzeDraft, addressee, dedupe, scan, notifyText, isShortAck, loadStaff, KIM, HOUR } from './external-waiting.mjs';
import { externalFile, readJsonSafe, addSkip, readSkips, isSkipped } from './lib/external-waiting-state.mjs';

const NOW = Date.parse('2026-11-04T03:00:00Z');
const MB = 'seisaku-team@orgiast.jp';
const hdr = (name, value) => ({ name, value });
function message(id, { from = 'A 様 <tkawaguchi@starwillbe.com>', to = MB, cc, subject = '日程のご相談', ageH = 30, labels = [], extra = [], snippet = '11/6 14時でお願いします' } = {}) {
  return { id, threadId: 't1', internalDate: String(NOW - ageH * HOUR), labelIds: labels, snippet,
    payload: { headers: [hdr('From', from), hdr('To', to), ...(cc ? [hdr('Cc', cc)] : []), hdr('Subject', subject), hdr('Message-ID', `<${id}@x>`), ...extra] } };
}
const thread = (...messages) => ({ id: 't1', messages });

test('外部が最後ならスレッドが返信待ちになる', () => {
  const item = analyzeThread(thread(message('m1')), { mailbox: MB });
  assert.equal(item.kind, 'reply'); assert.equal(item.who, 'A 様'); assert.equal(item.group, 'window');
  assert.equal(item.lastMessageId, 'm1'); assert.match(item.id, /^ex:[0-9a-f]{12}$/);
});
test('最後が @orgiast.jp・社員の個人 Gmail・自分の送信なら除外', () => {
  const internal = message('m2', { from: 'kim <kim@orgiast.jp>', ageH: 1 });
  assert.equal(analyzeThread(thread(message('m1'), internal), { mailbox: MB }), null);
  const staff = new Set(['meropp.16@gmail.com']);
  assert.equal(analyzeThread(thread(message('m1'), message('m3', { from: 'M <meropp.16@gmail.com>', ageH: 1 })), { mailbox: MB, staff }), null);
  assert.ok(analyzeThread(thread(message('m3', { from: 'M <meropp.16@gmail.com>' })), { mailbox: MB }));
  assert.equal(analyzeThread(thread(message('m4', { labels: ['SENT'] })), { mailbox: MB }), null);
});
test('下書きメッセージは最後の送信者として数えない', () => {
  const draft = message('d1', { from: 'kim <kim@orgiast.jp>', labels: ['DRAFT'], ageH: 1 });
  assert.equal(analyzeThread(thread(message('m1'), draft), { mailbox: MB }).lastMessageId, 'm1');
});
test('noreply・List-Unsubscribe・Auto-Submitted・Precedence は除外', () => {
  const cases = [{ from: 'googleplay-noreply@google.com' }, { from: 'x@docs.google.com' }, { from: 'invoice+statements@mail.anthropic.com' }, { subject: '【自動返信】お問い合わせありがとうございます' }, { from: 'no-reply@shop.example' }, { from: 'Notifications <notification@x.example>' }, { from: 'mailer-daemon@x.example' },
    { extra: [hdr('List-Unsubscribe', '<mailto:u@x>')] }, { extra: [hdr('Auto-Submitted', 'auto-generated')] }, { extra: [hdr('Precedence', 'bulk')] }];
  for (const c of cases) assert.equal(analyzeThread(thread(message('m1', c)), { mailbox: MB }), null, JSON.stringify(c));
  assert.ok(analyzeThread(thread(message('m1', { extra: [hdr('Auto-Submitted', 'no')] })), { mailbox: MB }));
});
test('Cc だけのスレッドは除外', () => {
  assert.equal(analyzeThread(thread(message('m1', { to: 'someone@orgiast.jp', cc: MB })), { mailbox: MB }), null);
  assert.ok(analyzeThread(thread(message('m1', { to: `Team <${MB}>, x@y.jp` })), { mailbox: MB }));
});
test('24時間を超えた社外宛の下書きだけ拾う', () => {
  const draft = (ageH, to) => ({ id: 'dr1', message: message('dm1', { from: 'kim@orgiast.jp', to, ageH }) });
  const old = analyzeDraft(draft(48, 'cust@example.com'), { mailbox: KIM, now: NOW });
  assert.equal(old.kind, 'draft'); assert.equal(old.who, 'cust@example.com'); assert.equal(old.group, 'kim');
  assert.equal(analyzeDraft(draft(10, 'cust@example.com'), { mailbox: KIM, now: NOW }), null);
  assert.equal(analyzeDraft(draft(24 * 40, 'cust@example.com'), { mailbox: KIM, now: NOW }), null, '30日より古い下書きは対象外');
  assert.equal(analyzeDraft(draft(48, 'colleague@orgiast.jp'), { mailbox: KIM, now: NOW }), null);
});
test('窓口の担当（宛名）を本文冒頭から取る', () => {
  assert.equal(addressee('株式会社オージャスト 御中\n大平様\nお世話になっております。'), '大平様');
  assert.equal(addressee('お世話になっております。'), '');
});
test('同じメールが両メールボックスにあれば kim 宛を残して1件にする', () => {
  const a = analyzeThread(thread(message('m1', { to: `${KIM}, ${MB}` })), { mailbox: KIM });
  const b = analyzeThread(thread(message('m1', { to: `${KIM}, ${MB}` })), { mailbox: MB });
  const out = dedupe([b, a]);
  assert.equal(out.length, 1); assert.equal(out[0].group, 'kim');
});
test('お礼だけの短文は確認対象になる', () => {
  assert.ok(isShortAck('ありがとうございます。承知しました。')); assert.ok(!isShortAck('ありがとうございます。日程はいつがよいですか？'));
});

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'external-waiting-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}
// Gmail の応答をフィクスチャで返す fetch（ネットワークは使わない）。
function fakeGmail({ threads = [], drafts = [], fail = false } = {}) {
  const json = (status, body) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });
  return async url => {
    if (fail) return json(500, { error: 'boom' });
    if (url.includes('/threads?')) return json(200, { threads: threads.map(x => ({ id: x.id })) });
    const t = url.match(/\/threads\/([^?]+)/); if (t) return json(200, threads.find(x => x.id === t[1]));
    if (url.includes('/drafts?')) return json(200, { drafts: drafts.map(x => ({ id: x.id })) });
    const d = url.match(/\/drafts\/([^?]+)/); if (d) return json(200, drafts.find(x => x.id === d[1]));
    return json(200, { payload: { headers: [] } });
  };
}
const deps = (over = {}) => ({ fetchImpl: fakeGmail(over), getToken: async () => 'token' });
const run = (home, over = {}, options = {}) => scan({ home, now: NOW, deps: deps(over), staff: new Set(), mailboxes: [MB], push: false, ...options });

test('scan は状態ファイルを書き、取得失敗のメールボックスは ok:false で 0 件扱いにしない', async t => {
  const home = fixture(t);
  const first = await run(home, { threads: [thread(message('m1'))] });
  assert.equal(first.state.sources[MB].ok, true); assert.equal(first.state.items.length, 1);
  const second = await run(home, { fail: true });
  assert.equal(second.state.sources[MB].ok, false); assert.match(second.state.sources[MB].error, /500/);
  assert.equal(second.state.items.length, 1, '直前の項目を残す');
  assert.equal(readJsonSafe(externalFile(home)).sources[MB].ok, false);
});
test('skip は lastMessageId が変わると再表示される', async t => {
  const home = fixture(t);
  await run(home, { threads: [thread(message('m1'))] });
  const id = readJsonSafe(externalFile(home)).items[0].id;
  addSkip(home, id, '対応済み', NOW);
  assert.equal((await run(home, { threads: [thread(message('m1'))] })).state.items.length, 0);
  assert.equal((await run(home, { threads: [thread(message('m1'), message('m9', { ageH: 2 }))] })).state.items.length, 1);
  const skips = readSkips(home);
  assert.ok(isSkipped(skips, { id, lastMessageId: 'm1' })); assert.ok(!isSkipped(skips, { id, lastMessageId: 'm9' }));
});
test('24時間以上の項目だけ、直近24時間に未通知なら1通にまとめて通知する', async t => {
  const home = fixture(t); const sent = [];
  const notify = async text => { sent.push(text); return { delivered: 'dm' }; };
  const threads = [thread(message('m1', { ageH: 30 })), { id: 't2', messages: [{ ...message('m2', { ageH: 2, subject: '新しい件' }), threadId: 't2' }] }];
  await run(home, { threads }, { push: true, notify });
  assert.equal(sent.length, 1); assert.match(sent[0], /^【社外返信待ち】/); assert.match(sent[0], /1 件/);
  await run(home, { threads }, { push: true, notify, now: NOW + HOUR });
  assert.equal(sent.length, 1, '24時間以内は再通知しない');
  await run(home, { threads }, { push: true, notify, now: NOW + 25 * HOUR });
  assert.equal(sent.length, 2);
});
test('通知に失敗したら通知済みにしない・--no-push 相当では送らない', async t => {
  const home = fixture(t); let calls = 0;
  const threads = [thread(message('m1'))];
  await run(home, { threads }, { push: true, notify: async () => { calls++; return { delivered: 'none' }; } });
  await run(home, { threads }, { push: true, notify: async () => { calls++; return { delivered: 'none' }; } });
  assert.equal(calls, 2);
  await run(home, { threads }, { push: false, notify: async () => assert.fail('push=false で送ってはいけない') });
});
test('短い了承メールは LLM が no と答えたら除外し、失敗時は表示側に倒す', async t => {
  const home = fixture(t);
  const threads = [thread(message('m1', { snippet: 'ありがとうございます。承知しました。' }))];
  assert.equal((await run(home, { threads }, { classify: () => false })).state.items.length, 0);
  const other = fixture(t);
  assert.equal((await run(other, { threads }, { classify: () => true })).state.items.length, 1);
});
test('通知文は失敗系の語を伏せる', () => {
  const text = notifyText([{ kind: 'reply', who: 'A', subject: 'エラーの件', since: new Date(NOW - 30 * HOUR).toISOString(), group: 'kim' }], NOW);
  assert.doesNotMatch(text, /エラー/); assert.match(text, /30時間待ち/);
});
test('同梱の staff-addresses.json が読める', () => { assert.ok(loadStaff().has('meropp.16@gmail.com')); });
