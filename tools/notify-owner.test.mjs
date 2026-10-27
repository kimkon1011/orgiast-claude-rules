import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveOwner, resolveOwnerDiscordId, notifyOwner, sendOwnerToast } from './notify-owner.mjs';
import { KIM_DISCORD_USER_ID } from './notify-kim.mjs';

test('owner 解決は fleet account を使う', () => {
  assert.equal(resolveOwner({ label: 'cr-PC', pcMap: { 'cr-PC': { account: 'cr@orgiast.jp' } }, gitEmail: 'other@example.com' }), 'cr@orgiast.jp');
});
test('owner Discord ID をメールで解決する', () => {
  assert.equal(resolveOwnerDiscordId('cr@orgiast.jp', { directory: { x: { members: [{ id: '42', emails: ['cr@orgiast.jp'] }] } } }), '42');
});
test('DM 解決不能時は未達にして他人へ送らない', async () => {
  const result = await notifyOwner('cr@orgiast.jp', '結果', { home: fs.mkdtempSync(path.join(os.tmpdir(), 'notify-owner-')), directory: {}, notify: async () => { assert.fail('must not send'); } });
  assert.equal(result.delivered, 'none');
});

test('owner directory reads queries cache and refuses ambiguous email matches', () => {
  const directory = { queries: { cr: { members: [{ id: '42', emails: ['cr@orgiast.jp'] }] } } };
  assert.equal(resolveOwnerDiscordId('cr@orgiast.jp', { directory }), '42');
  directory.queries.other = { members: [{ id: '43', emails: ['cr@orgiast.jp'] }] };
  assert.equal(resolveOwnerDiscordId('cr@orgiast.jp', { directory }), '');
});

test('owner空の旧行はローカル持ち主を解決して通知する', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-empty-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  let call;
  await notifyOwner('', '自動進行', { home, label: 'kim-PC', pcMap: { 'kim-PC': { account: 'kim@orgiast.jp' } }, directory: [{ id: KIM_DISCORD_USER_ID, emails: ['kim@orgiast.jp'] }], notify: async (text, options) => { call = { text, options }; return { delivered: 'dm' }; } });
  assert.equal(call.text, '自動進行');
  assert.equal(call.options.userId, KIM_DISCORD_USER_ID);
});

test('持ち主未設定・別ownerへのkim ID流用はいずれも未達', async () => {
  for (const owner of ['', 'nishi@orgiast.jp']) {
    const result = await notifyOwner(owner, '自動進行', { home: fs.mkdtempSync(path.join(os.tmpdir(), 'notify-owner-')), label: 'DESKTOP-X', pcMap: {}, gitEmail: '', userId: KIM_DISCORD_USER_ID, notify: async () => { assert.fail('must not send'); } });
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
 assert.equal((await notifyOwner('nishi@orgiast.jp', '別の進捗', options)).channel, 'none');
});

test('toast PowerShell uses reminder, dismiss action and escaped bounded title/body', () => {
 let script;
 let scriptFile;
 const text = '確認<&>\n' + '長'.repeat(350);
 assert.equal(sendOwnerToast(text, { platform: 'win32', exec: (file, args) => {
   assert.equal(file, 'powershell.exe');
   assert.ok(args.includes('-File'));
   assert.ok(!args.includes('-EncodedCommand'));
   scriptFile = args[args.indexOf('-File') + 1];
   script = fs.readFileSync(scriptFile, 'utf8');
   assert.ok(script.startsWith('\ufeff'));
 } }), true);
 assert.equal(fs.existsSync(scriptFile), false);
 assert.ok(script.includes('<toast scenario="reminder">'));
 assert.ok(script.includes('<actions><action content="閉じる" arguments="dismiss" activationType="system"/></actions>'));
 assert.ok(script.includes("-split '\\r?\\n',2"));
 assert.ok(script.includes("$title='依頼の進捗'"));
 assert.ok(script.includes('$title.Substring(0,60)'));
 assert.ok(script.includes("$body.Substring(0,299)+'…'"));
 assert.ok(script.includes('[Security.SecurityElement]::Escape($title)'));
 assert.ok(script.includes('[Security.SecurityElement]::Escape($body)'));
 assert.ok(script.includes(Buffer.from(text, 'utf8').toString('base64')));
});

test('同一toastは6時間抑止し、期限経過・本文変更では再表示する', async t => {
 const home = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-dedupe-'));
 t.after(() => fs.rmSync(home, { recursive: true, force: true }));
 let calls = 0;
 const options = { home, label: 'nishi-PC', pcMap: { 'nishi-PC': { account: 'nishi@orgiast.jp' } }, directory: [], platform: 'win32', exec: () => { calls++; } };
 assert.equal((await notifyOwner('nishi@orgiast.jp', '進捗', options)).delivered, 'toast');
 const file = path.join(home, '.claude', 'logs', 'owner-toast-last.json');
 const last = JSON.parse(fs.readFileSync(file, 'utf8'));
 const result = await notifyOwner('nishi@orgiast.jp', '進捗', options);
 assert.equal(result.delivered, 'toast');
 assert.equal(result.deduped, true);
 assert.equal(calls, 1);
 assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), last);
 fs.writeFileSync(file, JSON.stringify({ ...last, at: Date.now() - 6 * 60 * 60 * 1000 }));
 assert.equal((await notifyOwner('nishi@orgiast.jp', '進捗', options)).deduped, undefined);
 assert.equal(calls, 2);
 await notifyOwner('nishi@orgiast.jp', '新しい進捗', options);
 assert.equal(calls, 3);
});

test('toast失敗は記録して抑止せず次回再試行する', async t => {
 const home = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-retry-'));
 t.after(() => fs.rmSync(home, { recursive: true, force: true }));
 let calls = 0;
 const options = { home, label: 'nishi-PC', pcMap: { 'nishi-PC': { account: 'nishi@orgiast.jp' } }, directory: [], platform: 'win32', exec: () => { calls++; throw new Error('failed'); } };
 for (let i = 0; i < 2; i++) assert.equal((await notifyOwner('nishi@orgiast.jp', '進捗', options)).delivered, 'none');
 assert.equal(calls, 2);
 assert.equal(fs.existsSync(path.join(home, '.claude', 'logs', 'owner-toast-last.json')), false);
});

test('ローカルmapのdiscordIdは正本のowner設定を継承する', t => {
 const home = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-map-'));
 t.after(() => fs.rmSync(home, { recursive: true, force: true }));
 fs.mkdirSync(path.join(home, '.claude'));
 fs.writeFileSync(path.join(home, '.claude', 'fleet-pc-map.json'), JSON.stringify({ 'nishi-PC': { discordId: '987' } }));
 assert.equal(resolveOwner({ home, label: 'nishi-PC' }), 'nishi@orgiast.jp');
 assert.equal(resolveOwnerDiscordId('nishi@orgiast.jp', { home, directory: [] }), '987');
});


test('toast temporary script is removed after execution failure', () => {
 let scriptFile;
 assert.equal(sendOwnerToast('failure', { platform: 'win32', exec: (_file, args) => {
   scriptFile = args[args.indexOf('-File') + 1];
   assert.ok(fs.existsSync(scriptFile));
   throw new Error('spawn failed');
 } }), false);
 assert.equal(fs.existsSync(path.dirname(scriptFile)), false);
});

test('generated toast script parses in real Windows PowerShell without Show', { skip: process.platform !== 'win32' }, () => {
 const text = "日本語<&>\n'quoted' ` $(); " + '長'.repeat(20000);
 assert.equal(sendOwnerToast(text, { exec: (file, args) => {
   const scriptFile = args[args.indexOf('-File') + 1];
   const parser = path.join(path.dirname(scriptFile), 'parse.ps1');
   fs.writeFileSync(parser, '\ufeff' + `$ErrorActionPreference='Stop'
$source=[IO.File]::ReadAllText((Join-Path $PSScriptRoot 'toast.ps1'))
$null=[ScriptBlock]::Create($source)
`, 'utf8');
   // Only compile the generated source; never invoke its script block.
   execFileSync(file, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', parser], { windowsHide: true, timeout: 15000, stdio: 'pipe' });
 } }), true);
});

test('toast・none は伏字本文をowner inboxに保存しDM成功では保存しない', async t => {
 const home = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-inbox-delivery-'));
 t.after(() => fs.rmSync(home, { recursive: true, force: true }));
 const options = { home, label: 'nishi-PC', pcMap: { 'nishi-PC': { account: 'nishi@orgiast.jp' } }, directory: [], toast: () => true };
 const file = path.join(home, '.claude', 'auto-progress-inbox', '_owner.jsonl');
 const rows = () => fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
 assert.equal((await notifyOwner('nishi@orgiast.jp', '進捗', options)).channel, 'toast');
 assert.equal(rows().length, 1);
 await notifyOwner('nishi@orgiast.jp', '進捗', options);
 assert.equal(rows().length, 1);
 assert.equal(rows()[0].source, 'notify-owner');
 assert.equal(rows()[0].shown, false);
 options.toast = () => false;
 assert.equal((await notifyOwner('nishi@orgiast.jp', '別の進捗', options)).channel, 'none');
 assert.equal(rows().length, 2);
 await notifyOwner('nishi@orgiast.jp', 'token=example-secret', options);
 assert.equal(rows()[2].text, 'token=***REDACTED***');
 await notifyOwner('nishi@orgiast.jp', 'DM成功', { ...options, userId: '42', notify: async () => ({ delivered: 'dm' }) });
 assert.equal(rows().length, 3);
 await notifyOwner('kim@orgiast.jp', '他の持ち主宛', options);
 assert.equal(rows().length, 3);
});

test('owner inbox 書き込み失敗でも呼び出し元を壊さない', async t => {
 const home = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-inbox-failure-'));
 t.after(() => fs.rmSync(home, { recursive: true, force: true }));
 fs.mkdirSync(path.join(home, '.claude'));
 fs.writeFileSync(path.join(home, '.claude', 'auto-progress-inbox'), 'blocked');
 const result = await notifyOwner('nishi@orgiast.jp', '結果', { home, userId: '', pcMap: {}, gitEmail: '', toast: () => false });
 assert.equal(result.channel, 'none');
});
