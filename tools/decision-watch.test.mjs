import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main, CHANNEL, notificationBody } from './decision-watch.mjs';
import { acquireLock, readInbox, resolveFleetLabel } from './fleet-mail.mjs';
import { main as register } from './register-decision-watch.mjs';
const now = Date.parse('2026-10-09T12:00:00Z');
const message = (id, content = '[判断依頼] テスト', timestamp = new Date(now).toISOString()) => ({ id, content, timestamp, author: { username: 'cr-PC' } });
function fixture(t, messages = [message('100'), message('101', '本文【判断依頼】')]) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'decision-watch-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, '.claude'));
  const stateFile = path.join(home, '.claude', 'decision-watch-state.json');
  const calls = [], output = [], errors = [], sent = [];
  const deps = { home, label: 'kim-PC', token: 'test-token', now: () => now, stdout: x => output.push(x), stderr: x => errors.push(x), fetchImpl: async (url, options) => {
    calls.push(url);
    if (options.method === 'POST') {
      if (url.endsWith('/users/@me/channels')) return { ok: true, json: async () => ({ id: '999' }) };
      sent.push(JSON.parse(options.body).content);
      return { ok: true };
    }
    return { ok: true, json: async () => url.includes('/messages?') ? messages : { guild_id: '888' } };
  } };
  // notifyKimも実処理を通し、ネットワークだけモックする。
  fs.writeFileSync(path.join(home, '.claude', 'orgiast-discord-user-id.txt'), '777');
  return { home, stateFile, deps, calls, output, errors, sent, state: () => JSON.parse(fs.readFileSync(stateFile)) };
}
test('新着2件でDM2回・state更新・hookから読めるinbox', async t => {
  const f = fixture(t);
  assert.equal(await main([], f.deps), 0);
  assert.equal(f.sent.length, 2);
  assert.equal(f.state().lastMessageId, '101');
  assert.deepEqual(Object.keys(f.state().seen), ['100', '101']);
  assert.equal(readInbox(f.home).length, 2);
  assert.equal(readInbox(f.home)[0].id, 'mail-discord-100');
  assert.match(f.sent[0], new RegExp(`/888/${CHANNEL}/100`));
});
test('seen済みは再送しない', async t => {
  const f = fixture(t);
  await main([], f.deps); await main([], f.deps);
  assert.equal(f.sent.length, 2);
  assert.ok(f.calls.some(url => url.includes('after=101&limit=50')));
});
test('初回の48hより古い投稿は無視してcursorのみ進める', async t => {
  const f = fixture(t, [message('100', '[要返信]', new Date(now - 49 * 3600000).toISOString())]);
  await main([], f.deps);
  assert.equal(f.sent.length, 0); assert.equal(f.state().lastMessageId, '100');
});
test('[kim-PC]マーカーは除外', async t => {
  const f = fixture(t, [message('100', '[判断依頼] [kim-PC] 返信')]);
  await main([], f.deps); assert.equal(f.sent.length, 0);
});
test('トークン無しはexit 0 + stderr 1行', async t => {
  const f = fixture(t); f.deps.token = '';
  assert.equal(await main([], f.deps), 0);
  assert.equal(f.errors.length, 1); assert.match(f.errors[0], /トークン未設定/); assert.equal(f.calls.length, 0);
});
test('dry-runはDM・state・inboxを書かない', async t => {
  const f = fixture(t);
  await main(['--dry-run'], f.deps);
  assert.equal(f.output.length, 2); assert.equal(f.sent.length, 0);
  assert.equal(fs.existsSync(f.stateFile), false); assert.deepEqual(readInbox(f.home), []);
});
test('失敗はcursorを越えて再試行、3回で諦めseenに入れない', async t => {
  const f = fixture(t, [message('100')]); let attempts = 0;
  f.deps.notify = async () => { attempts++; return { delivered: 'none' }; };
  await main([], f.deps);
  f.deps.fetchImpl = async url => ({ ok: true, json: async () => url.includes('/messages?') ? [] : { guild_id: '888' } });
  for (let i = 0; i < 4; i++) await main([], f.deps);
  assert.equal(attempts, 3); assert.deepEqual(f.state().seen, {});
  assert.equal(f.state().failures['100'].attempts, 3); assert.equal(f.errors.length, 1);
});
test('DM失敗後の成功は既読inboxを保持', async t => {
  const f = fixture(t, [message('100')]);
  f.deps.notify = async () => ({ delivered: 'none' }); await main([], f.deps);
  const file = path.join(f.home, '.claude/fleet-inbox/mail-discord-100.json');
  const mail = JSON.parse(fs.readFileSync(file)); mail.readAt = new Date(now).toISOString(); fs.writeFileSync(file, JSON.stringify(mail));
  delete f.deps.notify; await main([], f.deps);
  assert.equal(f.sent.length, 1); assert.deepEqual(f.state().failures, {}); assert.equal(readInbox(f.home).length, 0);
});
test('kim-PC以外は通信しない・ラベルはfleet-mailと共用', async t => {
  const f = fixture(t); delete f.deps.label;
  fs.writeFileSync(path.join(f.home, '.claude/cost-reporter.env'), 'REPORTER_LABEL=cr-PC\n');
  assert.equal(resolveFleetLabel(f.home, { hostname: 'x' }), 'cr-PC');
  await main([], f.deps); assert.equal(f.calls.length, 0);
});
test('API失敗や不正引数もexit 0、秘密をログしない', async t => {
  const f = fixture(t); f.deps.fetchImpl = async () => { throw new Error('secret-value'); };
  assert.equal(await main([], f.deps), 0); assert.equal(await main(['--bad'], f.deps), 0);
  assert.equal(f.errors.length, 2); assert.ok(f.errors.every(x => !x.includes('secret-value')));
});
test('1800文字でもリンク・件名・投稿者・時刻を保持', () => {
  const text = notificationBody(message('100', '[判断依頼] 件名\n選択肢 A: 進める\n推奨: A\n期限: 今日\n' + '選択肢:長文'.repeat(1000)), '888');
  assert.equal(text.length, 1800); assert.match(text, /推奨: A/); assert.match(text, /期限: 今日/); assert.match(text, /kim の Discord アカウントで開く/);
});
test('50件を超える新着はページを進める', async t => {
  const f = fixture(t, []); fs.writeFileSync(f.stateFile, JSON.stringify({ lastMessageId: '1', seen: {} }));
  const original = f.deps.fetchImpl;
  f.deps.fetchImpl = async (url, opts) => url.includes('after=1&') ? { ok: true, json: async () => Array.from({ length: 50 }, (_, i) => message(String(i + 2), '通常投稿')) }
    : url.includes('after=51&') ? { ok: true, json: async () => [message('52')] } : original(url, opts);
  await main([], f.deps); assert.equal(f.sent.length, 1); assert.equal(f.state().lastMessageId, '52');
});
test('setup修復はWindows登録を呼ぶ・他OSは何もしない', () => {
  let calls = 0;
  const spawnImpl = (program, args) => { calls++; assert.equal(program, 'powershell.exe'); assert.ok(args.at(-1).endsWith('register-decision-watch.ps1')); return { status: 0, stdout: '' }; };
  assert.equal(register({ platform: 'linux', spawnImpl }), 0); assert.equal(calls, 0);
  assert.equal(register({ platform: 'win32', spawnImpl }), 0); assert.equal(calls, 1);
  const manifest = JSON.parse(fs.readFileSync(new URL('./setup-manifest.json', import.meta.url)));
  assert.deepEqual(manifest.items.find(i => i.id === 'task:decision-watch').repair, ['register-decision-watch.mjs']);
});

test('同時起動ではロック取得済みの実行だけが送信する', async t => {
  const f = fixture(t);
  const release = acquireLock(path.join(f.home, '.claude/decision-watch.lock'));
  try { assert.equal(await main([], f.deps), 0); assert.equal(f.calls.length, 0); }
  finally { release(); }
  await main([], f.deps); assert.equal(f.sent.length, 2);
});
test('登録定義は10分間隔・同期repo・重複起動抑止を指定する', () => {
  const source = fs.readFileSync(new URL('./register-decision-watch.ps1', import.meta.url), 'utf8');
  assert.match(source, /-RepetitionInterval \(New-TimeSpan -Minutes 10\)/);
  assert.match(source, /-MultipleInstances IgnoreNew/);
  assert.match(source, /nightly-bootstrap\.ps1/);
  assert.match(source, /'-Target', \$target, '--once'/);
});
