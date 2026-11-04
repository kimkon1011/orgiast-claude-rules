import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acceptInvites, main, trustedInvitation } from './gh-accept-invites.mjs';
import { runSeatInvitations } from './onboarding-sync.mjs';

export function seat(t, account = 'cr@orgiast.jp') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'seat-invites-'));
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: account } }));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}
const invitation = (id, inviter = 'kimkon1011', owner = 'kimkon1011') => ({ id, inviter: { login: inviter }, repository: { full_name: `${owner}/repo-${id}`, owner: { login: owner } } });
test('招待者と所有者の両方を検証し全ページの対象だけ PATCH', t => {
  const home = seat(t), calls = [], output = [];
  const run = (file, args) => { calls.push(args); return args.includes('--slurp') ? JSON.stringify([[invitation(1), invitation(2, 'other')], [invitation(3, 'kimkon1011', 'other'), invitation(4)]]) : ''; };
  assert.equal(acceptInvites({ home, run, out: s => output.push(s) }).accepted, 2);
  assert.deepEqual(calls.filter(args => args.includes('PATCH')).map(args => args.at(-1)), ['user/repository_invitations/1', 'user/repository_invitations/4']);
  assert.equal(output.length, 4);
  for (const value of [null, {}, invitation(-1), invitation('1')]) assert.equal(trustedInvitation(value), false);
});
test('非kim席は gh を呼ばず、dry-run は PATCH と日次記録を書かない', t => {
  const home = seat(t), other = seat(t, 'employee@example.com'), calls = [];
  const run = (file, args) => { calls.push(args); return args.includes('--slurp') ? JSON.stringify([[invitation(1)]]) : ''; };
  assert.equal(acceptInvites({ home: other, run, out() {} }).skipped, true);
  assert.equal(calls.length, 0);
  assert.equal(main(['--dry-run', '--daily'], { home, run, out() {} }), 0);
  assert(!calls.some(args => args.includes('PATCH')));
  assert(!fs.existsSync(path.join(home, '.claude', 'gh-accept-invites.daily')));
});
test('日次間引き・期限切れ・接続失敗後の再試行', t => {
  const home = seat(t); let reads = 0;
  const run = (file, args) => { if (args.includes('--slurp')) { reads++; return '[[]]'; } return ''; };
  const options = { home, run, daily: true, out() {} };
  acceptInvites(options); acceptInvites(options); assert.equal(reads, 1);
  const stamp = path.join(home, '.claude', 'gh-accept-invites.daily');
  // WindowsのmtimeはDate.now()より小数ミリ秒だけ未来になることがある。
  fs.utimesSync(stamp, new Date(), new Date(Date.now() + 5));
  acceptInvites(options); assert.equal(reads, 1);
  fs.utimesSync(stamp, new Date(0), new Date(0));
  acceptInvites(options); assert.equal(reads, 2);
  fs.utimesSync(stamp, new Date(0), new Date(0));
  assert.equal(main(['--daily'], { ...options, run() { throw new Error('ENOENT / auth'); } }), 0);
  assert(!fs.existsSync(stamp));
  acceptInvites(options); assert.equal(reads, 3);
});
test('PATCH失敗は次の招待を妨げず日次済みにしない', t => {
  const home = seat(t);
  const result = acceptInvites({ home, daily: true, out() {}, run(file, args) {
    if (args.includes('--slurp')) return JSON.stringify([[invitation(1), invitation(2)]]);
    if (args.at(-1) === 'user/repository_invitations/1') throw new Error('offline');
    return '';
  } });
  assert.equal(result.failed, 1); assert.equal(result.accepted, 1);
  assert(!fs.existsSync(path.join(home, '.claude', 'gh-accept-invites.daily')));
});
test('途中でhookが終了してもpending記録は2分で回復する', t => {
  const home = seat(t), stamp = path.join(home, '.claude', 'gh-accept-invites.daily');
  fs.mkdirSync(path.dirname(stamp)); fs.writeFileSync(stamp, '');
  let calls = 0;
  const options = { home, daily: true, out() {}, run(file, args) { calls++; return args.includes('--slurp') ? '[[]]' : ''; } };
  acceptInvites(options); assert.equal(calls, 0);
  fs.utimesSync(stamp, new Date(0), new Date(0));
  acceptInvites(options); assert.equal(calls, 2); assert.equal(fs.readFileSync(stamp, 'utf8'), 'done');
});
test('全PCの既存SessionStartからdailyを実行しdry-runとkeys-onlyは変更しない', t => {
  const home = seat(t), repo = path.join(home, 'repo'), calls = [];
  fs.mkdirSync(path.join(repo, 'tools'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'tools/gh-accept-invites.mjs'), '// fixture');
  const options = { targetHome: home, targetRepo: repo, emit() {}, exec(file, args, config) { calls.push({ file, args, config }); return '招待: 保留なし'; } };
  assert(runSeatInvitations(options));
  assert.equal(calls[0].args.at(-1), '--daily');
  assert.equal(calls[0].config.env.ORGIAST_HOME, home);
  assert.equal(runSeatInvitations({ ...options, preview: true }), false);
  assert.equal(runSeatInvitations({ ...options, onlyKeys: true }), false);
  assert.equal(runSeatInvitations({ ...options, targetHome: seat(t, 'employee@example.com') }), false);
  assert.equal(calls.length, 1);
  const source = fs.readFileSync(new URL('./onboarding-sync.mjs', import.meta.url), 'utf8');
  assert(source.indexOf('try { runSeatInvitations(); }') < source.indexOf('const minIntervalMin'));
});
