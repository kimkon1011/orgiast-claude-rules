import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveOwner, resolveOwnerDiscordId, notifyOwner as realNotifyOwner, sendOwnerToast, RECIPIENT_NOTICE } from './notify-owner.mjs';
import { KIM_DISCORD_USER_ID } from './notify-kim.mjs';
import { listItems } from './kim-inbox.mjs';

// 2026-11-04 仕様変更: 配達・宛先検査は即時配信対象の定時まとめで行う。未指定kindは別の回帰テストで保留を検査する。
const notifyOwner = (owner, text, options = {}) => realNotifyOwner(owner, text, { kind: 'digest', notifyKim: async () => ({ delivered: 'session-inbox' }), ...options });

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
  assert.equal(resolveOwnerDiscordId('cr@orgiast.jp', { pcMap: {}, directory: { x: { members: [{ id: '42', emails: ['cr@orgiast.jp'] }] } } }), '42');
});
test('DM 解決不能時は未達にして他人へ送らない', async () => {
  // pcMap を空にして「このPCの持ち主ではない」を明示する（実機の fleet-pc-map の HP→cr@ に依存させない）
  const result = await notifyOwner('cr@orgiast.jp', '結果', { home: fs.mkdtempSync(path.join(os.tmpdir(), 'notify-owner-')), directory: {}, pcMap: {}, gitEmail: '', notify: async () => { assert.fail('must not send'); } });
  assert.equal(result.delivered, 'none');
});

test('owner directory reads queries cache and refuses ambiguous email matches', () => {
  const directory = { queries: { cr: { members: [{ id: '42', emails: ['cr@orgiast.jp'] }] } } };
  assert.equal(resolveOwnerDiscordId('cr@orgiast.jp', { pcMap: {}, directory }), '42');
  directory.queries.other = { members: [{ id: '43', emails: ['cr@orgiast.jp'] }] };
  assert.equal(resolveOwnerDiscordId('cr@orgiast.jp', { pcMap: {}, directory }), '');
});

test('owner空の旧行はローカル持ち主を解決して通知する', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-empty-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const result = await notifyOwner('', '自動進行', { home, label: 'kim-PC', pcMap: { 'kim-PC': { account: 'kim@orgiast.jp' } }, directory: [{ id: KIM_DISCORD_USER_ID, emails: ['kim@orgiast.jp'] }], notify: () => assert.fail('kim DM forbidden') });
  assert.equal(result.channel, 'kim-inbox');
  assert.equal(listItems(home).length, 1);
  assert.match(JSON.stringify(listItems(home)), /自動進行/);
});

test('持ち主未設定・別ownerでも明示kim宛はDMせず受け箱へ保存する', async t => {
  for (const owner of ['', 'nishi@orgiast.jp']) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'notify-owner-'));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    const result = await notifyOwner(owner, '自動進行', { home, label: 'DESKTOP-X', pcMap: {}, gitEmail: '', userId: KIM_DISCORD_USER_ID, notify: async () => { assert.fail('must not send'); } });
    assert.equal(result.delivered, 'session-inbox');
    assert.equal(listItems(home).length, 1);
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

test('ローカルPCの明示notifyDiscordIdはownerがcrでもkim受け箱へ保存する', async t => {
 const home = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-explicit-'));
 t.after(() => fs.rmSync(home, { recursive: true, force: true }));
 let sentTo = '';
 const options = {
   home,
   label: 'cr-PC',
   pcMap: { '作業用011': { account: 'cr@orgiast.jp', aliases: ['cr-PC'], notifyDiscordId: KIM_DISCORD_USER_ID } },
   directory: [],
   notify: async (_, notifyOptions) => { sentTo = notifyOptions.userId; return { delivered: 'dm', messageId: 'receipt' }; },
   toast: () => assert.fail('must not fall back'),
 };
 assert.equal(resolveOwnerDiscordId('cr@orgiast.jp', options), KIM_DISCORD_USER_ID);
 assert.equal((await notifyOwner('cr@orgiast.jp', '進捗', options)).channel, 'kim-inbox');
 assert.equal(sentTo, '');
 assert.equal(listItems(home).length, 1);
});

test('notifyDiscordIdなしでIDファイルがkimなら従来どおりtoastへ送る', async t => {
 const options = localOptions(t);
 fs.writeFileSync(path.join(options.home, '.claude', 'orgiast-discord-user-id.txt'), KIM_DISCORD_USER_ID);
 const result = await notifyOwner('nishi@orgiast.jp', '進捗', { ...options, notify: () => assert.fail('must not DM kim'), toast: () => true });
 assert.equal(result.channel, 'toast');
});

test('別PCのnotifyDiscordIdはローカルPCの宛先に使わない', async t => {
 const options = localOptions(t);
 options.pcMap['作業用011'] = { account: 'cr@orgiast.jp', notifyDiscordId: KIM_DISCORD_USER_ID };
 assert.equal(resolveOwnerDiscordId('nishi@orgiast.jp', options), '');
 const result = await notifyOwner('nishi@orgiast.jp', '進捗', { ...options, notify: () => assert.fail('must not use another PC target'), toast: () => true });
 assert.equal(result.channel, 'toast');
});

test('toast uses NotifyIcon ShowBalloonTip, encoded Unicode and 300 characters', () => {
 const text = "日本語<&>\n'quoted' ` $(); " + '長'.repeat(350);
 assert.equal(sendOwnerToast(text, { exe: 'powershell.exe', spawn: (file, args) => {
   assert.equal(file, 'powershell.exe');
   assert.deepEqual(args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-EncodedCommand']);
   const script = Buffer.from(args[3], 'base64').toString('utf16le');
   assert.ok(script.includes('System.Windows.Forms.NotifyIcon'));
   assert.ok(script.includes('ShowBalloonTip(5000)'));
   assert.ok(script.includes('Claude 進捗'));
   assert.ok(script.includes('Start-Sleep -Seconds 6'));
   assert.ok(script.includes('.Dispose()'));
   assert.ok(script.includes(Buffer.from(Array.from(text).slice(0,300).join(''), 'utf8').toString('base64')));
   assert.ok(!script.includes('msg.exe'));
   assert.ok(!script.includes('ToastNotificationManager'));
   return { status: 0 };
 } }), true);
});

test('sendOwnerToast accepts exe override for pwsh.exe', () => {
 assert.equal(sendOwnerToast('test', { exe: 'pwsh.exe', spawn: (file) => {
   assert.equal(file, 'pwsh.exe');
   return { status: 0 };
 } }), true);
 assert.equal(sendOwnerToast('test', { exe: 'powershell.exe', spawn: (file) => {
   assert.equal(file, 'powershell.exe');
   return { status: 0 };
 } }), true);
});

test('daily setup notice is suppressed on the same day and resets next day', async t => {
 assert.match(RECIPIENT_NOTICE, /次回 Claude を開くと自動で登録を試みます/);
 assert.match(RECIPIENT_NOTICE, /登録されない場合はチャットに『Discordユーザー名: xxx』/);
 const options = localOptions(t);
 const calls = [];
 Object.assign(options, { now: new Date(2026, 9, 28, 9).getTime(), toast: text => { calls.push(text); return true; } });
 await notifyOwner('nishi@orgiast.jp', '進捗1', options);
 await notifyOwner('nishi@orgiast.jp', '進捗2', options);
 const diagnostic = '\n\n⚠ Discord 宛先未設定: fleet-pc-map.json の「nishi-PC」に notifyDiscordId を追加';
 assert.deepEqual(calls, ['進捗1' + diagnostic, RECIPIENT_NOTICE, '進捗2' + diagnostic]);
 options.now = new Date(2026, 9, 29, 9).getTime();
 await notifyOwner('nishi@orgiast.jp', '進捗3', options);
 assert.deepEqual(calls.slice(-2), ['進捗3' + diagnostic, RECIPIENT_NOTICE]);
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

test('toast・none・DM成功すべて伏字本文をowner inboxに保存する', async t => {
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
 assert.equal(rows().length, 4);
 assert.equal(rows()[3].text, 'DM成功');
 assert.match(fs.readFileSync(path.join(options.home, '.claude', 'owner-inbox.md'), 'utf8'), /DM成功/);
 await notifyOwner('kim@orgiast.jp', '他の持ち主宛', options);
 assert.equal(rows().length, 4);
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

// 実際の notify-kim 経路でも、HTTP 200 の本文が読めない DM 応答を配達成功にしない。
for (const [label, sent] of [
  ['json がない', { ok: true }],
  ['JSON 解析が失敗する', { ok: true, json: async () => { throw new SyntaxError('invalid JSON'); } }],
]) {
  test(`DM 送信応答に ${label}場合は実際の通知経路でも未配達にする`, async t => {
    const options = localOptions(t);
    let calls = 0;
    const result = await realNotifyOwner('nishi@orgiast.jp', '進捗', {
      ...options, kind: 'digest', userId: '123', token: 'test-token', plainJa: false, toast: () => true,
      fetchImpl: async () => ++calls === 1 ? { ok: true, json: async () => ({ id: 'channel' }) } : sent,
    });
    assert.equal(calls, 2);
    assert.equal(result.delivered, 'toast');
    assert.equal(result.attempts[0].ok, false);
  });
}

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

test('kim 所有者は台帳配達を成功とし toast に重複通知しない', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-kim-inbox-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  let calls = 0;
  const result = await notifyOwner('kim@orgiast.jp', '報告', { home, label: 'kim-PC', pcMap: { 'kim-PC': { account: 'kim@orgiast.jp' } }, directory: [], notify: async (_text, options) => {
    calls++; assert.equal(options.userId, KIM_DISCORD_USER_ID); return { delivered: 'session-inbox', id: '項目' };
  }, toast: () => assert.fail('二重通知禁止') });
  assert.equal(calls, 0); assert.equal(result.channel, 'kim-inbox'); assert.equal(result.ok, true);
  assert.equal(listItems(home).length, 1);
});

test('w018-PC は fleet-pc-map に discordId と notifyDiscordId を持つ', () => {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const map = JSON.parse(fs.readFileSync(path.join(repo, 'fleet-pc-map.json'), 'utf8'));
  const entry = map['w018-PC'];
  assert.ok(entry, 'w018-PC が fleet-pc-map.json に存在すること');
  assert.ok(String(entry.discordId || '').trim(), 'w018-PC に discordId が設定されていること');
  assert.ok(String(entry.notifyDiscordId || '').trim(), 'w018-PC に notifyDiscordId が設定されていること');
  assertNotifyRecipients(map);
});

test('w018-PC の notifyChannels は mobile-push（cr 2026-11-06 指示）', () => {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const map = JSON.parse(fs.readFileSync(path.join(repo, 'fleet-pc-map.json'), 'utf8'));
  assert.deepEqual(map['w018-PC'].notifyChannels, ['mobile-push']);
});

test('mobile-push 席は Discord と保留判定を経由せずキューへ積む（kind=automatic も）', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-mobile-push-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const options = {
    home, label: 'w018-PC', directory: [], kind: 'automatic',
    pcMap: { 'w018-PC': { account: 'cr@orgiast.jp', notifyDiscordId: '1557228267566665729', notifyChannels: ['mobile-push'] } },
    notify: async () => assert.fail('Discord DM を呼ばない'),
    notifyKim: () => assert.fail('mobile-push 席は宛先警告を出さない'),
    toast: () => assert.fail('キューに積めたら toast に重ねない'),
  };
  const result = await realNotifyOwner('cr@orgiast.jp', '【w018-PC の進捗】\n完了 token=example-secret', options);
  assert.equal(result.delivered, 'mobile-push-queued');
  assert.equal(result.ok, true);
  assert.ok(result.id);
  const queue = fs.readFileSync(path.join(home, '.claude', 'mobile-push-queue.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(queue.length, 1);
  assert.equal(queue[0].owner, 'cr@orgiast.jp');
  assert.equal(queue[0].sent, false);
  assert.match(queue[0].title, /^【w018-PC の進捗】$/);
  assert.match(queue[0].body, /完了/);
  assert.match(queue[0].body, /\*\*\*REDACTED\*\*\*/);
  assert.ok(queue[0].ts);
  // 台帳に delivered:mobile-push-queued を残す
  const ledger = fs.readFileSync(path.join(home, '.claude', 'logs', 'owner-notify-fallback.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(ledger.at(-1).delivered, 'mobile-push-queued');
  assert.equal(ledger.at(-1).owner, 'cr@orgiast.jp');
  // local owner の受け箱にも書かれ、次のプロンプトでチャットに出る
  assert.match(fs.readFileSync(path.join(home, '.claude', 'owner-inbox.md'), 'utf8'), /【w018-PC の進捗】/);
});

test('mobile-push 設定は kim 宛てと他 owner の経路を変えない', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-mobile-push-keep-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const pcMap = { 'w018-PC': { account: 'cr@orgiast.jp', notifyChannels: ['mobile-push'] } };
  const kim = await notifyOwner('kim@orgiast.jp', 'kim 宛て報告', { home, label: 'w018-PC', pcMap, directory: [], notify: () => assert.fail('kim は DM しない') });
  assert.equal(kim.channel, 'kim-inbox');
  // このPCの持ち主でない owner は mobile-push 席になっても従来どおり（automatic は保留）
  const other = await realNotifyOwner('nishi@orgiast.jp', '別 owner の進捗', { home, label: 'w018-PC', pcMap, directory: [], kind: 'automatic', notify: () => assert.fail('保留中は送らない'), toast: () => assert.fail('保留は toast しない') });
  assert.equal(other.delivered, 'deferred');
  assert.equal(fs.existsSync(path.join(home, '.claude', 'mobile-push-queue.jsonl')), false);
  assert.ok(listItems(home).some(item => /kim 宛て報告/.test(item.text)));
});

const KNOWN_MISSING_NOTIFY = {
  'kimko-PC': '使用者の Discord 未特定・2026-11-03',
  'HP': '使用者の Discord 未特定・2026-11-03',
  'nishi-PC': '使用者の Discord 未特定・2026-11-03',
  '015CAFE': '使用者の Discord 未特定・2026-11-09',
};

function assertNotifyRecipients(map) {
  for (const [label, entry] of Object.entries(map)) {
    if (label.startsWith('_') || !entry || typeof entry !== 'object') continue;
    const hasId = Boolean(String(entry.notifyDiscordId || '').trim());
    if (Object.hasOwn(KNOWN_MISSING_NOTIFY, label)) {
      assert.ok(!hasId, `${label}: notifyDiscordId 設定済み。KNOWN_MISSING_NOTIFY の許可リストから消せ`);
      continue;
    }
    if (String(entry.account || entry.owner || '').trim()) {
      assert.ok(hasId, `${label}: notifyDiscordId が未登録`);
    }
  }
}

test('許可リスト外の account/owner 行の宛先不足は失敗する', () => {
  for (const field of ['account', 'owner']) {
    for (const notifyDiscordId of [undefined, '', '   ']) {
      assert.throws(() => assertNotifyRecipients({ 'new-PC': { [field]: 'user@example.com', notifyDiscordId } }), /new-PC: notifyDiscordId が未登録/);
    }
    assertNotifyRecipients({ 'new-PC': { [field]: 'user@example.com', notifyDiscordId: '42' } });
  }
  assertNotifyRecipients(Object.fromEntries(Object.keys(KNOWN_MISSING_NOTIFY).map(label => [label, { account: 'user@example.com' }])));
});

test('既知の抜けに宛先を設定したら許可リストの削除を要求する', () => {
  for (const label of Object.keys(KNOWN_MISSING_NOTIFY)) {
    assert.throws(() => assertNotifyRecipients({ [label]: { account: 'user@example.com', notifyDiscordId: '42' } }), /許可リストから消せ/);
  }
});

test('session/toast 設定は Discord と宛先設定依頼を送らない', async t => {
 const options = localOptions(t);
 options.pcMap['nishi-PC'].notifyChannels = ['session', 'toast'];
 let toasted = 0;
 const result = await notifyOwner('nishi@orgiast.jp', '本人への依頼', {
   ...options, userId: '42', notify: () => assert.fail('Discord disabled'),
   notifyKim: () => assert.fail('no setup alert'), toast: () => { toasted++; return true; },
 });
 assert.equal(result.channel, 'toast');
 assert.equal(toasted, 1);
 const file = path.join(options.home, '.claude', 'auto-progress-inbox', '_owner.jsonl');
 assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 1);
 assert.match(fs.readFileSync(path.join(options.home, '.claude', 'owner-inbox.md'), 'utf8'), /本人への依頼/);
});

test('DMを保留してもローカル所有者のセッション受け箱へ保存する', async t => {
 const options = localOptions(t);
 const text = '自動作業の状況報告';
 const result = await realNotifyOwner('nishi@orgiast.jp', text, {
   ...options, kind: 'automatic',
   notify: () => assert.fail('deferred DM must not send'),
   notifyKim: () => assert.fail('deferred DM must not alert'),
   toast: () => assert.fail('progress deferral must not trigger fallback toast'),
 });
 assert.equal(result.delivered, 'deferred');
 assert.match(fs.readFileSync(path.join(options.home, '.claude', 'owner-inbox.md'), 'utf8'), /自動作業の状況報告/);
 const rows = fs.readFileSync(path.join(options.home, '.claude', 'auto-progress-inbox', '_owner.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
 assert.equal(rows.length, 1);
 assert.equal(rows[0].text, text);
});

test('宛先未解決の inbox fallback は戻り値と台帳に劣化を記録する', async t => {
  const options = { ...localOptions(t), toast: () => false };
  const result = await notifyOwner('nishi@orgiast.jp', '進捗', options);
  assert.equal(result.ok, true);
  assert.equal(result.channel, 'inbox');
  assert.equal(result.degraded, 'no-recipient');
  const ledger = JSON.parse(fs.readFileSync(path.join(options.home, '.claude', 'logs', 'owner-notify-fallback.jsonl'), 'utf8'));
  assert.equal(ledger.degraded, 'no-recipient');
  for (const receipt of [result, ledger]) {
    assert.equal(receipt.attempts.find(a => a.channel === 'discord').degraded, 'no-recipient');
    assert.equal(receipt.attempts.find(a => a.channel === 'inbox').degraded, 'no-recipient');
  }
  const failedDm = await notifyOwner('nishi@orgiast.jp', 'DM失敗', { ...options, userId: '42', notify: async () => { throw new Error('offline'); } });
  assert.equal(failedDm.degraded, undefined);
  assert.ok(failedDm.attempts.every(a => a.degraded === undefined));
});

for (const label of ['DESKTOP-BDOAK99', 'user-PC']) {
  test(`共用席 ${label} はローカルの別人宛先を無視して kim-inbox へ積む`, async t => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-shared-'));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    fs.mkdirSync(path.join(home, '.claude'));
    const owner = 'seisaku-team@orgiast.jp', wrongId = '1423319951980232744';
    fs.writeFileSync(path.join(home, '.claude', 'fleet-pc-map.json'), JSON.stringify({ [label]: { account: owner, notifyDiscordId: wrongId, discordId: wrongId } }));
    fs.writeFileSync(path.join(home, '.claude', 'orgiast-discord-user-id.txt'), wrongId);
    const options = { home, label, directory: [{ id: wrongId, emails: [owner] }, { id: KIM_DISCORD_USER_ID, emails: ['kim@orgiast.jp'] }] };
    assert.equal(resolveOwnerDiscordId(owner, options), KIM_DISCORD_USER_ID);
    assert.equal(resolveOwnerDiscordId(' SEISAKU-TEAM@ORGIAST.JP ', options), KIM_DISCORD_USER_ID);
    let calls = 0;
    const result = await notifyOwner(owner, '共用席の進捗', { ...options, notify: async () => {
      calls++; assert.fail('kim 宛は Discord へ送らない');
    }, toast: () => assert.fail('kim-inbox へ配達済み') });
    assert.equal(calls, 0);
    assert.equal(result.delivered, 'session-inbox');
    assert.equal(result.channel, 'kim-inbox');
    assert.equal(result.ok, true);
    const items = listItems(home);
    assert.equal(items.length, 1);
    assert.equal(items[0].id, result.id);
    assert.equal(items[0].kind, 'info');
    assert.equal(items[0].text, '共用席の進捗');
    const rejected = await notifyOwner(owner, '誤宛先', { ...options, userId: wrongId, notify: () => assert.fail('別人へ送らない'), toast: () => false });
    assert.equal(rejected.degraded, 'no-recipient');
  });
}

test('個人席はローカルの明示宛先を引き続き優先する', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-personal-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, '.claude'));
  fs.writeFileSync(path.join(home, '.claude', 'fleet-pc-map.json'), JSON.stringify({ 'nishi-PC': { account: 'nishi@orgiast.jp', notifyDiscordId: '123' } }));
  assert.equal(resolveOwnerDiscordId('nishi@orgiast.jp', { home, label: 'nishi-PC', directory: [{ id: '456', emails: ['nishi@orgiast.jp'] }] }), '123');
});
