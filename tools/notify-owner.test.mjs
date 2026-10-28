import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveOwner, resolveOwnerDiscordId, notifyOwner, sendOwnerToast, RECIPIENT_NOTICE } from './notify-owner.mjs';
import { KIM_DISCORD_USER_ID } from './notify-kim.mjs';

test('owner 解決は fleet account を使う', () => {
  assert.equal(resolveOwner({ label: 'cr-PC', pcMap: { 'cr-PC': { account: 'cr@orgiast.jp' } }, gitEmail: 'other@example.com' }), 'cr@orgiast.jp');
});
test('HP ラベルは fleet-pc-map の account で cr@orgiast.jp に解決される（未通知13件の原因データ）', () => {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const pcMap = JSON.parse(fs.readFileSync(path.join(repo, 'fleet-pc-map.json'), 'utf8'));
  assert.equal(pcMap.HP.account, 'cr@orgiast.jp');
  assert.equal(resolveOwner({ label: 'HP', pcMap }), 'cr@orgiast.jp');
});

test('owner Discord ID をメールで解決する', () => {
  assert.equal(resolveOwnerDiscordId('cr@orgiast.jp', { directory: { x: { members: [{ id: '42', emails: ['cr@orgiast.jp'] }] } } }), '42');
});
test('DM 解決不能時は未達にして他人へ送らない', async () => {
  // pcMap を空にして「このPCの持ち主ではない」を明示する（実機の fleet-pc-map の HP→cr@ に依存させない）
  const result = await notifyOwner('cr@orgiast.jp', '結果', { home: fs.mkdtempSync(path.join(os.tmpdir(), 'notify-owner-')), directory: {}, pcMap: {}, gitEmail: '', notify: async () => { assert.fail('must not send'); } });
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
  await notifyOwner('', '自動進行', { home, label: 'kim-PC', pcMap: { 'kim-PC': { account: 'kim@orgiast.jp' } }, directory: [{ id: KIM_DISCORD_USER_ID, emails: ['kim@orgiast.jp'] }], notify: async (text, options) => { call = { text, options }; return { delivered: 'dm', messageId: 'receipt' }; } });
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
 const options = { home, label: 'nishi-PC', pcMap: { 'nishi-PC': { account: 'nishi@orgiast.jp' } }, directory: [], notify: () => assert.fail('must not DM kim'), toast: async () => true };
 assert.equal(resolveOwnerDiscordId('nishi@orgiast.jp', options), '');
 assert.equal((await notifyOwner('nishi@orgiast.jp', '進捗', options)).channel, 'toast');
 assert.equal(JSON.parse(fs.readFileSync(path.join(home, '.claude', 'logs', 'owner-notify-fallback.jsonl'), 'utf8')).channel, 'toast');
 options.pcMap['nishi-PC'].discordId = '123';
 assert.equal(resolveOwnerDiscordId('nishi@orgiast.jp', options), '123');
 options.notify = async () => { throw new Error('DM failed'); };
 assert.equal((await notifyOwner('nishi@orgiast.jp', '進捗', options)).channel, 'toast');
 options.toast = () => false;
 assert.equal((await notifyOwner('nishi@orgiast.jp', '別の進捗', options)).channel, 'inbox');
});

test('toast uses standard PowerShell AppId, encoded Unicode and 300 characters', () => {
 const text = "日本語<&>\n'quoted' ` $(); " + '長'.repeat(350);
 assert.equal(sendOwnerToast(text, { spawn: (file, args) => {
   assert.equal(file, 'powershell.exe');
   assert.deepEqual(args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-EncodedCommand']);
   const script = Buffer.from(args[3], 'base64').toString('utf16le');
   assert.ok(script.includes('<text>Claude 進捗</text>'));
   assert.ok(script.includes('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'));
   assert.ok(script.includes('[Security.SecurityElement]::Escape($body)'));
   assert.ok(script.includes(Buffer.from(Array.from(text).slice(0,300).join(''), 'utf8').toString('base64')));
   assert.ok(!script.includes('msg.exe'));
   return { status: 0 };
 } }), true);
});

test('daily setup notice is suppressed on the same day and resets next day', async t => {
 const options = localOptions(t);
 const calls = [];
 Object.assign(options, { now: new Date(2026, 9, 28, 9).getTime(), toast: text => { calls.push(text); return true; } });
 await notifyOwner('nishi@orgiast.jp', '進捗1', options);
 await notifyOwner('nishi@orgiast.jp', '進捗2', options);
 assert.deepEqual(calls, ['進捗1', RECIPIENT_NOTICE, '進捗2']);
 options.now = new Date(2026, 9, 29, 9).getTime();
 await notifyOwner('nishi@orgiast.jp', '進捗3', options);
 assert.deepEqual(calls.slice(-2), ['進捗3', RECIPIENT_NOTICE]);
});

test('toast failure is recorded by exit code and inbox succeeds; failed setup can retry', async t => {
 const options = localOptions(t);
 let calls = 0;
 Object.assign(options, { spawn: () => { calls++; return { status: 1 }; } });
 for (let i = 0; i < 2; i++) {
   const result = await notifyOwner('nishi@orgiast.jp', '進捗' + i, options);
   assert.equal(result.channel, 'inbox');
   assert.equal(result.ok, true);
   assert.equal(result.toastExitCode, 1);
 }
 assert.equal(calls, 4);
 const inbox = fs.readFileSync(path.join(options.home, '.claude', 'owner-inbox.md'), 'utf8');
 assert.ok(inbox.indexOf('進捗1') < inbox.indexOf('進捗0'));
 assert.equal(fs.existsSync(path.join(options.home, '.claude', 'logs', 'owner-recipient-notice.json')), false);
});

test('ローカルmapのdiscordIdは正本のowner設定を継承する', t => {
 const home = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-map-'));
 t.after(() => fs.rmSync(home, { recursive: true, force: true }));
 fs.mkdirSync(path.join(home, '.claude'));
 fs.writeFileSync(path.join(home, '.claude', 'fleet-pc-map.json'), JSON.stringify({ 'nishi-PC': { discordId: '987' } }));
 assert.equal(resolveOwner({ home, label: 'nishi-PC' }), 'nishi@orgiast.jp');
 assert.equal(resolveOwnerDiscordId('nishi@orgiast.jp', { home, directory: [] }), '987');
});


test('spawn errors and nonzero exits never count as toast delivery', () => {
 for (const spawn of [() => ({ status: 1 }), () => ({ status: null, error: { code: 'ENOENT' } }), () => { throw new Error('failed'); }]) {
   assert.equal(sendOwnerToast('failure', { spawn }), false);
 }
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
 assert.equal((await notifyOwner('nishi@orgiast.jp', '別の進捗', options)).channel, 'inbox');
 assert.equal(rows().length, 2);
 await notifyOwner('nishi@orgiast.jp', 'token=example-secret', options);
 assert.equal(rows()[2].text, 'token=***REDACTED***');
 await notifyOwner('nishi@orgiast.jp', 'DM成功', { ...options, userId: '42', notify: async () => ({ delivered: 'dm', messageId: 'receipt' }) });
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

function localOptions(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "owner-safe-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, ".claude"));
  return { home, label: "nishi-PC", pcMap: { "nishi-PC": { account: "nishi@orgiast.jp" } }, directory: [] };
}

test('既知の他人のIDはファイル・map・明示指定の全経路で拒否する', async t => {
  const options = localOptions(t);
  options.directory = { queries: { other: { members: [{ id: '123', emails: ['other@orgiast.jp'] }] } } };
  fs.writeFileSync(path.join(options.home, '.claude', 'orgiast-discord-user-id.txt'), '123');
  assert.equal(resolveOwnerDiscordId('nishi@orgiast.jp', options), '');
  options.pcMap['nishi-PC'].discordId = '123';
  assert.equal(resolveOwnerDiscordId('nishi@orgiast.jp', options), '');
  const result = await notifyOwner('nishi@orgiast.jp', '進捗', { ...options, userId: '123', notify: () => assert.fail('wrong recipient'), toast: () => true });
  assert.equal(result.delivered, 'toast');
});

test('同じIDが別メールにも紐づく曖昧な台帳は拒否する', t => {
  const options = localOptions(t);
  options.directory = [{ id: '123', emails: ['nishi@orgiast.jp'] }, { id: '123', emails: ['other@orgiast.jp'] }];
  assert.equal(resolveOwnerDiscordId('nishi@orgiast.jp', options), '');
});

test('一致する持ち主へDMできたときtoastを出さない', async t => {
  const options = localOptions(t);
  options.directory = [{ id: '123', emails: ['nishi@orgiast.jp'] }];
  const result = await notifyOwner('nishi@orgiast.jp', '進捗', { ...options, notify: async (_, opts) => {
    assert.equal(opts.userId, '123');
    assert.equal(opts.webhookFallback, false);
    return { delivered: 'dm', messageId: 'receipt' };
  }, toast: () => assert.fail('already delivered') });
  assert.equal(result.channel, 'discord');
});

test('別PCの持ち主宛はローカルtoastで配達済みにしない', async t => {
  const result = await notifyOwner('other@orgiast.jp', '結果', { ...localOptions(t), toast: () => assert.fail('not local owner') });
  assert.equal(result.delivered, 'none');
});

test('メンバー台帳が空でも別ownerのPC設定に紐づくIDは拒否する', async t => {
  const options = localOptions(t);
  options.pcMap['other-PC'] = { account: 'other@orgiast.jp', discordId: '456' };
  const result = await notifyOwner('nishi@orgiast.jp', '進捗', { ...options, userId: '456', notify: () => assert.fail('wrong PC owner'), toast: () => true });
  assert.equal(result.channel, 'toast');
});

test('DM result without message id falls back, including injected notify', async t => {
 const options = localOptions(t);
 const result = await notifyOwner('nishi@orgiast.jp', '全文' + '長'.repeat(500), {
   ...options, userId: '123', notify: async () => ({ delivered: 'dm' }), spawn: () => ({ status: 0 }),
 });
 assert.equal(result.channel, 'toast');
 assert.equal(result.toastExitCode, 0);
 assert.equal(result.attempts[0].ok, false);
 assert.ok(fs.readFileSync(path.join(options.home, '.claude', 'owner-inbox.md'), 'utf8').includes('長'.repeat(500)));
});

test('kim names in directory reject alternate IDs for nishi', async t => {
 const options = localOptions(t);
 for (const row of [{ id: '999', username: 'kimkon.' }, { id: '999', global_name: '金功勇' }]) {
   const result = await notifyOwner('nishi@orgiast.jp', '進捗', { ...options, userId: row.id, directory: [row], notify: () => assert.fail('must not DM'), toast: () => true });
   assert.equal(result.channel, 'toast');
 }
});

test('missing and empty ID files never invoke Discord', async t => {
 const options = localOptions(t);
 for (const value of [null, '', '   ']) {
   if (value !== null) fs.writeFileSync(path.join(options.home, '.claude', 'orgiast-discord-user-id.txt'), value);
   const result = await notifyOwner('nishi@orgiast.jp', '進捗', { ...options, notify: () => assert.fail('must not send'), toast: () => true });
   assert.equal(result.channel, 'toast');
   assert.equal(result.attempts[0].skipped, true);
 }
});

test('both fallbacks failing returns none, ledger records actual failures', async t => {
 const options = localOptions(t);
 fs.writeFileSync(path.join(options.home, '.claude', 'owner-inbox.md'), '');
 fs.rmSync(path.join(options.home, '.claude', 'owner-inbox.md'));
 fs.mkdirSync(path.join(options.home, '.claude', 'owner-inbox.md'));
 const result = await notifyOwner('nishi@orgiast.jp', '進捗', { ...options, spawn: () => ({ status: 5 }) });
 assert.equal(result.channel, 'none');
 assert.equal(result.ok, false);
 const ledger = JSON.parse(fs.readFileSync(path.join(options.home, '.claude', 'logs', 'owner-notify-fallback.jsonl'), 'utf8'));
 assert.equal(ledger.toastExitCode, 5);
 assert.equal(ledger.attempts.find(a => a.channel === 'inbox').ok, false);
});

test('concurrent watch and digest preserve both inbox messages and one setup notice', async t => {
 const options = localOptions(t);
 let notices = 0;
 options.toast = async text => {
   if (text === RECIPIENT_NOTICE) notices++;
   await new Promise(resolve => setTimeout(resolve, 10));
   return true;
 };
 await Promise.all(['watch', 'digest'].map(text => notifyOwner('nishi@orgiast.jp', text, options)));
 const inbox = fs.readFileSync(path.join(options.home, '.claude', 'owner-inbox.md'), 'utf8');
 assert.match(inbox, /watch/);
 assert.match(inbox, /digest/);
 assert.equal(notices, 1);
});

test('Discord failure with a valid recipient falls back without setup warning', async t => {
 const options = localOptions(t), texts = [];
 const result = await notifyOwner('nishi@orgiast.jp', '進捗', { ...options, userId: '123', notify: async () => { throw new Error('network'); }, toast: text => { texts.push(text); return true; } });
 assert.equal(result.channel, 'toast');
 assert.deepEqual(texts, ['進捗']);
});
