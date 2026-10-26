import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveOwner, resolveOwnerDiscordId, notifyOwner } from './notify-owner.mjs';
import { KIM_DISCORD_USER_ID } from './notify-kim.mjs';

test('owner 解決は fleet account を使う', () => {
  assert.equal(resolveOwner({ label: 'cr-PC', pcMap: { 'cr-PC': { account: 'cr@orgiast.jp' } }, gitEmail: 'other@example.com' }), 'cr@orgiast.jp');
});
test('owner Discord ID をメールで解決する', () => {
  assert.equal(resolveOwnerDiscordId('cr@orgiast.jp', { directory: { x: { members: [{ id: '42', emails: ['cr@orgiast.jp'] }] } } }), '42');
});
test('DM 解決不能時は未達にして他人へ送らない', async () => {
  const result = await notifyOwner('cr@orgiast.jp', '結果', { home: 'Z:/missing', directory: {}, notify: async () => { assert.fail('must not send'); } });
  assert.equal(result.delivered, 'none');
});

test('owner directory reads queries cache and refuses ambiguous email matches', () => {
  const directory = { queries: { cr: { members: [{ id: '42', emails: ['cr@orgiast.jp'] }] } } };
  assert.equal(resolveOwnerDiscordId('cr@orgiast.jp', { directory }), '42');
  directory.queries.other = { members: [{ id: '43', emails: ['cr@orgiast.jp'] }] };
  assert.equal(resolveOwnerDiscordId('cr@orgiast.jp', { directory }), '');
});

test('owner空の旧行はローカル持ち主を解決して通知する', async () => {
  let call;
  await notifyOwner('', '自動進行', { label: 'kim-PC', pcMap: { 'kim-PC': { account: 'kim@orgiast.jp' } }, directory: [{ id: KIM_DISCORD_USER_ID, emails: ['kim@orgiast.jp'] }], notify: async (text, options) => { call = { text, options }; return { delivered: 'dm' }; } });
  assert.equal(call.text, '自動進行');
  assert.equal(call.options.userId, KIM_DISCORD_USER_ID);
});

test('持ち主未設定・別ownerへのkim ID流用はいずれも未達', async () => {
  for (const owner of ['', 'nishi@orgiast.jp']) {
    const result = await notifyOwner(owner, '自動進行', { home: 'Z:/missing', label: 'DESKTOP-X', pcMap: {}, gitEmail: '', userId: KIM_DISCORD_USER_ID, notify: async () => { assert.fail('must not send'); } });
    assert.equal(result.delivered, 'none');
  }
});

test('nishi のローカルkim IDを拒否しtoastとログへ送る', async t => {
 const home = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-fallback-'));
 t.after(() => fs.rmSync(home, { recursive: true, force: true }));
 fs.mkdirSync(path.join(home, '.claude'));
 fs.writeFileSync(path.join(home, '.claude', 'orgiast-discord-user-id.txt'), KIM_DISCORD_USER_ID);
 const options = { home, label: 'nishi-PC', pcMap: { 'nishi-PC': { account: 'nishi@orgiast.jp' } }, directory: [], notify: () => assert.fail('must not DM kim'), toast: async text => { assert.equal(text, '進捗'); return true; } };
 assert.equal(resolveOwnerDiscordId('nishi@orgiast.jp', options), '');
 assert.equal((await notifyOwner('nishi@orgiast.jp', '進捗', options)).channel, 'toast');
 assert.equal(JSON.parse(fs.readFileSync(path.join(home, '.claude', 'logs', 'owner-notify-fallback.jsonl'), 'utf8')).channel, 'toast');
 options.pcMap['nishi-PC'].discordId = '123';
 assert.equal(resolveOwnerDiscordId('nishi@orgiast.jp', options), '123');
 options.notify = async () => { throw new Error('DM failed'); };
 assert.equal((await notifyOwner('nishi@orgiast.jp', '進捗', options)).channel, 'toast');
 options.toast = () => false;
 assert.equal((await notifyOwner('nishi@orgiast.jp', '進捗', options)).channel, 'none');
});

test('ローカルmapのdiscordIdは正本のowner設定を継承する', t => {
 const home = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-map-'));
 t.after(() => fs.rmSync(home, { recursive: true, force: true }));
 fs.mkdirSync(path.join(home, '.claude'));
 fs.writeFileSync(path.join(home, '.claude', 'fleet-pc-map.json'), JSON.stringify({ 'nishi-PC': { discordId: '987' } }));
 assert.equal(resolveOwner({ home, label: 'nishi-PC' }), 'nishi@orgiast.jp');
 assert.equal(resolveOwnerDiscordId('nishi@orgiast.jp', { home, directory: [] }), '987');
});

test('PowerShell exit code / payload / full notice / channel controls', async t => {
 const { sendOwnerToast } = await import('./notify-owner.mjs');
 const home = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-toast-'));
 t.after(() => fs.rmSync(home, { recursive: true, force: true }));
 const text = '進'.repeat(400) + '<&"';
 let calls = 0;
 const options = { home, label: 'nishi-PC', pcMap: { 'nishi-PC': { account: 'nishi@orgiast.jp' } }, directory: [], platform: 'win32', spawn: (exe, args) => {
   calls++;
   assert.equal(exe, 'powershell.exe');
   const script = Buffer.from(args.at(-1), 'base64').toString('utf16le');
   assert.match(script, /Claude Code 進捗/);
   const payload = JSON.parse(Buffer.from(script.match(/FromBase64String\('([^']+)'/)[1], 'base64').toString('utf8'));
   assert.equal(payload.body.length, 300);
   assert.match(payload.file, /progress-notices.md$/);
   return { status: 0 };
 } };
 const result = await notifyOwner('nishi@orgiast.jp', text, options);
 assert.equal(result.delivered, 'toast');
 assert.equal(result.exitCode, 0);
 assert.ok(fs.readFileSync(result.noticeFile, 'utf8').includes(text));
 assert.equal(sendOwnerToast('x', { platform: 'win32', spawn: () => ({ status: 1 }) }).delivered, 'none');
 assert.equal(sendOwnerToast('x', { platform: 'win32', spawn: () => ({ status: null, error: new Error('EPERM') }) }).delivered, 'none');
 options.userId = '123';
 options.notify = async () => ({ delivered: 'dm' });
 assert.equal((await notifyOwner('nishi@orgiast.jp', text, options)).delivered, 'dm');
 assert.equal(calls, 2);
 fs.writeFileSync(path.join(home, '.claude', 'notify-channels.json'), JSON.stringify({ toast: false, discord: true }));
 await notifyOwner('nishi@orgiast.jp', text, options);
 assert.equal(calls, 2);
 options.channels = { toast: true, discord: false };
 options.notify = () => assert.fail('Discord disabled');
 assert.equal((await notifyOwner('nishi@orgiast.jp', text, options)).delivered, 'toast');
 options.spawn = () => ({ status: 3 });
 assert.equal((await notifyOwner('nishi@orgiast.jp', text, options)).delivered, 'none');
});
