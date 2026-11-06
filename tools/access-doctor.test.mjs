import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { diagnose } from './access-doctor.mjs';
import { githubRepo, repositoryTarget, repairOrigin } from './lib/seat-github.mjs';

function fixture(t, { push = true, owner = 'cr568', account = 'cr@orgiast.jp' } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'seat-doctor-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, '.claude'));
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: account } }));
  const base = { owner: { login: 'kimkon1011' }, full_name: 'kimkon1011/repo', permissions: { push }, default_branch: 'main' };
  const remotes = { origin: `https://github.com/${owner}/repo.git`, upstream: 'git@github.com:kimkon1011/repo.git' }, calls = [];
  const run = (file, args) => {
    calls.push([file, ...args]);
    if (file === 'git') {
      if (args[0] === 'config') throw new Error('absent');
      if (args[1] === 'get-url') { if (!remotes[args[2]]) throw new Error('absent'); return remotes[args[2]]; }
      if (['set-url', 'add'].includes(args[1])) { remotes[args[2]] = args[3]; return ''; }
    }
    if (args.includes('--slurp')) return args.at(-1).includes('invitations') ? '[[]]' : JSON.stringify([[base]]);
    if (args[1] === 'repos/cr568/repo') return JSON.stringify({ fork: true, owner: { login: owner }, parent: base });
    if (args[1] === 'repos/kimkon1011/repo') return JSON.stringify(base);
    throw new Error('unexpected command');
  };
  return { home, run, remotes, calls, status: () => ({ success: true, files: ['present.env', 'missing.env', '../outside'] }), out() {} };
}
test('URL解析とfork/base判定、権限のあるforkだけ保存して付け替え', t => {
  for (const url of ['https://github.com/a/b.git', 'git@github.com:a/b.git', 'ssh://git@github.com/a/b']) assert.equal(githubRepo(url), 'a/b');
  assert.equal(githubRepo('https://evil.example/github.com/a/b'), null);
  for (const options of [{}, { push: false }, { owner: 'kimkon1011' }]) {
    const f = fixture(t, options), target = repositoryTarget(f.run);
    assert.equal(repairOrigin(target, f.run), target.fork && target.push);
    assert.equal(f.remotes.origin, target.fork && target.push ? target.url : target.originUrl);
    if (target.fork && target.push) assert.equal(f.remotes.fork, target.originUrl);
  }
});
test('通常診断は変更せず、--fix のkim席だけorigin変更。秘密値は読まず存在確認', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.home, '.claude', 'present.env'), 'test fixture');
  const rows = diagnose(f);
  assert.equal(f.remotes.fork, undefined);
  assert(rows.find(row => row.resource === '配布ファイル present.env').ok);
  assert(!rows.find(row => row.resource === '配布ファイル missing.env').ok);
  assert(!rows.some(row => row.resource.includes('outside')));
  diagnose({ ...f, fix: true }); assert.equal(f.remotes.origin, 'https://github.com/kimkon1011/repo.git');
  const other = fixture(t, { account: 'employee@example.com' });
  diagnose({ ...other, fix: true }); assert.equal(other.remotes.fork, undefined);
});
test('既存forkリモートを上書きせず、非forkの同名repoも変更しない', t => {
  const f = fixture(t); f.remotes.fork = 'https://github.com/other/repo.git';
  assert.throws(() => repairOrigin(repositoryTarget(f.run), f.run), /別リポジトリ/);
  delete f.remotes.upstream;
  assert.throws(() => repositoryTarget((file, args) => args[1] === 'repos/cr568/repo' ? JSON.stringify({ fork: false, owner: { login: 'cr568' } }) : f.run(file, args)), /fork 関係/);
});
test('明示upstreamのpush権限を確認し、pushurlがあると修復を停止する', t => {
  const f = fixture(t);
  const run = (file, args) => args[1] === 'repos/cr568/repo' ? JSON.stringify({ owner: { login: 'cr568' } }) : f.run(file, args);
  const target = repositoryTarget(run);
  assert.equal(target.base, 'kimkon1011/repo'); assert(target.push);
  assert.throws(() => repairOrigin(target, (file, args) => args[0] === 'config' ? 'https://github.com/cr568/repo.git' : f.run(file, args)), /pushurl/);
  assert.equal(f.remotes.fork, undefined);
});
test('招待は表示だけ、--fixで承諾して権限を再照会', t => {
  const f = fixture(t); let pending = true;
  const invitation = { id: 1, inviter: { login: 'kimkon1011' }, repository: { owner: { login: 'kimkon1011' }, full_name: 'kimkon1011/repo' } };
  const run = (file, args) => {
    if (args.includes('PATCH')) { pending = false; return ''; }
    if (args[0] === 'auth') return '';
    if (args.at(-1).includes('invitations')) return JSON.stringify([pending ? [invitation] : []]);
    return f.run(file, args);
  };
  diagnose({ ...f, run }); assert(pending);
  const rows = diagnose({ ...f, run, fix: true }); assert(!pending); assert(rows.find(row => row.resource === 'GitHub 招待').ok);
});
test('ghとkeyserveの障害は表に出し他PCへの依頼を案内しない', t => {
  const f = fixture(t), output = [];
  const rows = diagnose({ ...f, out: line => output.push(line), run() { throw new Error('offline'); }, status() { throw new Error('offline'); } });
  assert(rows.every(row => !row.ok)); assert(!output.join('\n').includes('kim-PC'));
});
