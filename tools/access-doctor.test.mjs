import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { diagnose, main } from './access-doctor.mjs';
import { githubRepo, repositoryTarget, repairOrigin, repairUnreachableOrigin, originReachability, originFailureKind, RULES_ORIGIN_URL } from './lib/seat-github.mjs';

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
// --- 配布元リポ origin の自動修復（git を mock した単体テスト） ---
function gitError(stderr) { const error = new Error(stderr); error.stderr = stderr; return error; }
function mockGit(overrides) {
  const calls = [];
  const run = (file, args) => {
    calls.push([file, ...args]);
    const key = args.join(' ');
    if (Object.prototype.hasOwnProperty.call(overrides, key)) {
      const value = overrides[key];
      if (value instanceof Error) throw value;
      // 関数は状態付き（set-url 後の read-back など）のための返却値
      return typeof value === 'function' ? value() : value;
    }
    throw new Error(`unexpected git: ${key}`);
  };
  return { run, calls };
}
const setUrlKey = `remote set-url origin ${RULES_ORIGIN_URL}`;
function changedOrigin(notes) { return notes.some(note => note.kind === 'ok' && note.repaired === true); }
test('git 失敗を not-found / auth / network に分類する', () => {
  assert.equal(originFailureKind(gitError('fatal: Repository not found.')), 'not-found');
  assert.equal(originFailureKind(gitError("fatal: repository 'https://github.com/x/y.git/' not found")), 'not-found');
  assert.equal(originFailureKind(gitError("fatal: 'C:/x' does not appear to be a git repository")), 'not-found');
  assert.equal(originFailureKind(gitError("fatal: could not read Username for 'https://github.com': terminal prompts disabled")), 'auth');
  assert.equal(originFailureKind(gitError("fatal: Authentication failed for 'https://github.com/x/y.git/'")), 'auth');
  assert.equal(originFailureKind(gitError('fatal: Permission denied (publickey).')), 'auth');
  assert.equal(originFailureKind(gitError("fatal: unable to access 'https://github.com/x/y.git/': Failed to connect to github.com port 443")), 'network');
  assert.equal(originFailureKind(gitError('fatal: unable to access ... Could not resolve host: github.com')), 'network');
  // 単なる "not found"（command not found 等のシム起動失敗）は not-found 扱いにしない。
  assert.equal(originFailureKind(gitError('sh: /tmp/deny-ssh: not found')), 'network');
  assert.equal(originFailureKind(gitError('/tmp/deny-ssh: line 1: not found')), 'network');
});
test('origin が既に届くなら何もしない（set-url もログも書かない）', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-repair-ok-')); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const { run, calls } = mockGit({ 'remote get-url origin': RULES_ORIGIN_URL, 'ls-remote origin HEAD': '7a64280f93f005e5155354c17dd3767ae44356f6\tHEAD' });
  const note = repairUnreachableOrigin({ repoDir: 'x', home, run });
  assert.equal(note.kind, 'ok'); assert.equal(note.repaired, false);
  assert(!calls.some(parts => parts[1] === 'set-url'));
  assert.equal(fs.existsSync(path.join(home, '.claude', 'logs', 'access-doctor-origin-repair.jsonl')), false);
});
test('not-found かつ履歴が一致（HEAD 祖先/逆）なら正しいリポジトリへ向け替え、読み戻し確認しログを書く', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-repair-fix-')); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const origins = { origin: 'https://github.com/orgiast/nightly-repo.git' };
  const { run, calls } = mockGit({
    'remote get-url origin': () => origins.origin,
    'ls-remote origin HEAD': gitError('fatal: Repository not found.'),
    [`ls-remote ${RULES_ORIGIN_URL} HEAD`]: '7a64280f93f005e5155354c17dd3767ae44356f6\tHEAD',
    [`fetch ${RULES_ORIGIN_URL} HEAD:refs/remotes/nightly-origin-probe/rules`]: '',
    'rev-parse --verify --quiet HEAD': 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'rev-parse --verify --quiet refs/remotes/origin/main': 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    'merge-base --is-ancestor HEAD refs/remotes/nightly-origin-probe/rules': '',
    'update-ref -d refs/remotes/nightly-origin-probe/rules': '',
    [setUrlKey]: () => { origins.origin = RULES_ORIGIN_URL; return ''; },
  });
  const note = repairUnreachableOrigin({ repoDir: 'x', home, run });
  assert.equal(note.repaired, true); assert.equal(note.kind, 'ok'); assert.equal(note.originUrl, 'https://github.com/orgiast/nightly-repo.git');
  assert(calls.some(parts => parts.slice(1).join(' ').includes('remote set-url') && parts.at(-1) === RULES_ORIGIN_URL));
  assert(calls.some(parts => parts.includes('-d')));
  const log = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'logs', 'access-doctor-origin-repair.jsonl'), 'utf8').trim().split(/\r?\n/).at(-1));
  assert.equal(log.oldUrl, 'https://github.com/orgiast/nightly-repo.git'); assert.equal(log.newUrl, RULES_ORIGIN_URL); assert.ok(log.repairedAt);
});
test('ネットワーク断は向け替えない（別リポジトリを誤って指さない）', () => {
  const failure = gitError('fatal: unable to access ... Failed to connect to github.com port 443');
  const { run, calls } = mockGit({ 'remote get-url origin': 'https://github.com/orgiast/nightly-repo.git', 'ls-remote origin HEAD': failure });
  const note = repairUnreachableOrigin({ repoDir: 'x', home: os.tmpdir(), run });
  assert.equal(note.repaired, false); assert(!changedOrigin([note]));
  assert(!calls.some(parts => parts[1] === 'set-url'));
});
test('認証エラー（could not read Username）でも正しい URL が届き履歴が一致すれば向け替え、ログを書く', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-repair-auth-fix-')); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const origins = { origin: 'https://github.com/orgiast/nightly-repo.git' };
  const { run, calls } = mockGit({
    'remote get-url origin': () => origins.origin,
    'ls-remote origin HEAD': gitError("fatal: could not read Username for 'https://github.com': terminal prompts disabled"),
    [`ls-remote ${RULES_ORIGIN_URL} HEAD`]: '7a64280f93f005e5155354c17dd3767ae44356f6\tHEAD',
    [`fetch ${RULES_ORIGIN_URL} HEAD:refs/remotes/nightly-origin-probe/rules`]: '',
    'rev-parse --verify --quiet HEAD': 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'rev-parse --verify --quiet refs/remotes/origin/main': 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    'merge-base --is-ancestor HEAD refs/remotes/nightly-origin-probe/rules': '',
    'update-ref -d refs/remotes/nightly-origin-probe/rules': '',
    [setUrlKey]: () => { origins.origin = RULES_ORIGIN_URL; return ''; },
  });
  const note = repairUnreachableOrigin({ repoDir: 'x', home, run });
  assert.equal(note.repaired, true); assert.equal(note.kind, 'ok'); assert.equal(note.originUrl, 'https://github.com/orgiast/nightly-repo.git');
  assert(calls.some(parts => parts.slice(1).join(' ').includes('remote set-url') && parts.at(-1) === RULES_ORIGIN_URL));
  const log = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'logs', 'access-doctor-origin-repair.jsonl'), 'utf8').trim().split(/\r?\n/).at(-1));
  assert.equal(log.oldUrl, 'https://github.com/orgiast/nightly-repo.git'); assert.equal(log.newUrl, RULES_ORIGIN_URL);
});
test('認証エラーでも履歴が無関係なら向け替えず、probe は掃除する', () => {
  const { run, calls } = mockGit({
    'remote get-url origin': 'https://github.com/orgiast/nightly-repo.git',
    'ls-remote origin HEAD': gitError("fatal: could not read Username for 'https://github.com': terminal prompts disabled"),
    [`ls-remote ${RULES_ORIGIN_URL} HEAD`]: '7a64280f93f005e5155354c17dd3767ae44356f6\tHEAD',
    [`fetch ${RULES_ORIGIN_URL} HEAD:refs/remotes/nightly-origin-probe/rules`]: '',
    'rev-parse --verify --quiet HEAD': 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'merge-base --is-ancestor HEAD refs/remotes/nightly-origin-probe/rules': gitError('exit 1'),
    'merge-base --is-ancestor refs/remotes/nightly-origin-probe/rules HEAD': gitError('exit 1'),
    'update-ref -d refs/remotes/nightly-origin-probe/rules': '',
  });
  const note = repairUnreachableOrigin({ repoDir: 'x', home: os.tmpdir(), run });
  assert.equal(note.kind, 'unrelated-history'); assert.equal(note.repaired, false);
  assert(!calls.some(parts => parts[1] === 'set-url'));
  assert(calls.some(parts => parts.includes('-d')));
});
test('認証エラーで正しい URL も届かないときは向け替えない', () => {
  const { run, calls } = mockGit({
    'remote get-url origin': 'https://github.com/orgiast/nightly-repo.git',
    'ls-remote origin HEAD': gitError("fatal: could not read Username for 'https://github.com': terminal prompts disabled"),
    [`ls-remote ${RULES_ORIGIN_URL} HEAD`]: gitError('fatal: unable to access ... Failed to connect'),
  });
  const note = repairUnreachableOrigin({ repoDir: 'x', home: os.tmpdir(), run });
  assert.equal(note.kind, 'correct-url-unreachable'); assert.equal(note.repaired, false);
  assert(!calls.some(parts => parts[1] === 'set-url'));
});
test('正しい URL も届かないときは向け替えない', () => {
  const { run, calls } = mockGit({
    'remote get-url origin': 'https://github.com/orgiast/nightly-repo.git',
    'ls-remote origin HEAD': gitError('fatal: Repository not found.'),
    [`ls-remote ${RULES_ORIGIN_URL} HEAD`]: gitError('fatal: unable to access ... Failed to connect'),
  });
  const note = repairUnreachableOrigin({ repoDir: 'x', home: os.tmpdir(), run });
  assert.equal(note.kind, 'correct-url-unreachable'); assert.equal(note.repaired, false);
  assert(!calls.some(parts => parts[1] === 'set-url'));
});
test('履歴が無関係（merge-base がどちら向きも失敗）なら向け替えず、probe は掃除する', () => {
  const { run, calls } = mockGit({
    'remote get-url origin': 'https://github.com/orgiast/nightly-repo.git',
    'ls-remote origin HEAD': gitError('fatal: Repository not found.'),
    [`ls-remote ${RULES_ORIGIN_URL} HEAD`]: '7a64280f93f005e5155354c17dd3767ae44356f6\tHEAD',
    [`fetch ${RULES_ORIGIN_URL} HEAD:refs/remotes/nightly-origin-probe/rules`]: '',
    'rev-parse --verify --quiet HEAD': 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'merge-base --is-ancestor HEAD refs/remotes/nightly-origin-probe/rules': gitError('exit 1'),
    'merge-base --is-ancestor refs/remotes/nightly-origin-probe/rules HEAD': gitError('exit 1'),
    'update-ref -d refs/remotes/nightly-origin-probe/rules': '',
  });
  const note = repairUnreachableOrigin({ repoDir: 'x', home: os.tmpdir(), run });
  assert.equal(note.kind, 'unrelated-history'); assert.equal(note.repaired, false);
  assert(!calls.some(parts => parts[1] === 'set-url'));
  assert(calls.some(parts => parts.includes('-d')));
});
test('originReachability は no-repo / ok / not-found を返す', () => {
  assert.equal(originReachability({ repoDir: 'x', run() { throw new Error('absent'); } }).kind, 'no-repo');
  const ok = mockGit({ 'remote get-url origin': RULES_ORIGIN_URL, 'ls-remote origin HEAD': 'abc\tHEAD' });
  assert.equal(originReachability({ repoDir: 'x', run: ok.run }).kind, 'ok');
  const nf = mockGit({ 'remote get-url origin': RULES_ORIGIN_URL, 'ls-remote origin HEAD': gitError('fatal: Repository not found.') });
  assert.equal(originReachability({ repoDir: 'x', run: nf.run }).kind, 'not-found');
});
test('main は --origin-repair <path> で修復だけ動かし、未知引数は拒否する', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-repair-main-'));
  assert.equal(main(['--origin-repair', '.claude/nightly-repo'], { home, run() { throw new Error('absent'); } }), 0);
  assert.equal(main(['--bogus']), 2);
  fs.rmSync(home, { recursive: true, force: true });
});
