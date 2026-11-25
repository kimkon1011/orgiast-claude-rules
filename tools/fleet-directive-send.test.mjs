import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { directiveId, main, pruneDirectives, resolvePushRepo } from './fleet-directive-send.mjs';

function tempRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-send-'));
  fs.writeFileSync(path.join(repo, 'fleet-directives.json'), JSON.stringify({ version: 1, directives: [] }));
  return repo;
}

test('--why 無しは失敗し、ファイルを書き換えない', () => {
  const repo = tempRepo();
  const before = fs.readFileSync(path.join(repo, 'fleet-directives.json'), 'utf8');
  assert.throws(() => main(['--kind', 'status'], { repo }), /--why は必須/);
  assert.equal(fs.readFileSync(path.join(repo, 'fleet-directives.json'), 'utf8'), before);
});

test('id は同時刻・同 kind でも乱数で毎回ユニーク', () => {
  const date = new Date('2026-09-02T12:34:56Z');
  assert.notEqual(directiveId('status', date, () => 1), directiveId('status', date, () => 2));
  assert.match(directiveId('prompt', date, () => 42), /^prompt-20260902-123456-0042$/);
});

test('prompt 本文は --body-file からそのまま読み期限を付ける', () => {
  const repo = tempRepo();
  const body = path.join(repo, 'prompt.md');
  fs.writeFileSync(body, 'run `literal`\n');
  const directive = main(['--kind', 'prompt', '--targets', 'PC', '--why', '点検', '--body-file', body, '--expires-hours', '24'], { repo, randomInt: () => 7 });
  const saved = JSON.parse(fs.readFileSync(path.join(repo, 'fleet-directives.json'), 'utf8')).directives[0];
  assert.equal(saved.body, 'run `literal`\n');
  assert.equal(saved.id, directive.id);
  assert.ok(saved.expiresAt);
});

test('--prune は期限切れと処理済みだけを除く', () => {
  const remaining = pruneDirectives([
    { id: 'expired', expiresAt: '2000-01-01T00:00:00Z' },
    { id: 'processed', processedAt: '2026-09-01T00:00:00Z' },
    { id: 'active', expiresAt: '2999-01-01T00:00:00Z' },
  ], Date.parse('2026-09-02T00:00:00Z'));
  assert.deepEqual(remaining.map((item) => item.id), ['active']);
});

function git(dir, ...args) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-push-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bare = path.join(root, 'origin.git');
  const seed = path.join(root, 'seed');
  const execTree = path.join(root, 'execTree');
  const home = path.join(root, 'home');
  git(root, 'init', '--bare', '-b', 'main', bare);
  git(root, 'clone', bare, seed);
  git(seed, 'config', 'user.name', 'Test');
  git(seed, 'config', 'user.email', 'test@localhost');
  fs.writeFileSync(path.join(seed, 'fleet-directives.json'), JSON.stringify({ version: 1, directives: [] }));
  git(seed, 'add', '.');
  git(seed, 'commit', '-m', 'seed');
  git(seed, 'push', 'origin', 'main');
  git(root, 'clone', bare, execTree);
  git(execTree, 'config', 'user.name', 'Test');
  git(execTree, 'config', 'user.email', 'test@localhost');
  git(execTree, 'checkout', '--detach', 'origin/main');
  const dedicated = path.join(home, '.claude', 'fleet-directives-repo');
  return { root, bare, seed, execTree, home, dedicated };
}

const sendArgs = ['--kind', 'status', '--why', '点検', '--push'];
const ids = bare => JSON.parse(git(bare, 'show', 'main:fleet-directives.json')).directives.map(d => d.id);

function checkedSpawn(command, args, options) {
  assert.equal(command, 'git');
  assert.equal(options.shell, false);
  assert.equal(options.windowsHide, true);
  assert.equal(options.encoding, 'utf8');
  assert.ok(options.timeout > 0);
  assert.ok(!args.includes('&&'));
  return spawnSync(command, args, options);
}

test('detached HEAD は専用 main クローン経由で配信し実行ツリーを汚さない', t => {
  const f = fixture(t);
  const before = git(f.execTree, 'rev-parse', 'HEAD');
  const d = main(sendArgs, { repo: f.execTree, home: f.home, randomInt: () => 1, spawnSync: checkedSpawn });
  assert.deepEqual(ids(f.bare), [d.id]);
  assert.equal(git(f.execTree, 'status', '--porcelain'), '');
  assert.equal(git(f.execTree, 'rev-parse', 'HEAD'), before);
  assert.equal(git(f.dedicated, 'symbolic-ref', '--short', 'HEAD'), 'main');
  assert.equal(git(f.dedicated, 'log', '-1', '--format=%an <%ae>'), 'Fleet Directive <fleet-directive@localhost>');
});

test('push 直前の競合は一度だけ再試行し両方の指令を保持する', t => {
  const f = fixture(t);
  resolvePushRepo({ repo: f.execTree, home: f.home });
  let pushes = 0;
  const injected = (command, args, options) => {
    if (args[0] === 'push' && ++pushes === 1) {
      fs.writeFileSync(path.join(f.seed, 'fleet-directives.json'), JSON.stringify({ version: 1, directives: [{ id: 'concurrent' }] }));
      git(f.seed, 'commit', '-am', 'concurrent directive');
      git(f.seed, 'push', 'origin', 'main');
    }
    return checkedSpawn(command, args, options);
  };
  const d = main(sendArgs, { repo: f.execTree, home: f.home, spawnSync: injected });
  assert.equal(pushes, 2);
  assert.deepEqual(ids(f.bare), ['concurrent', d.id]);
  assert.equal(git(f.dedicated, 'status', '--porcelain'), '');
});

test('既存専用クローンの origin が不通でも残骸を消して例外を返す', t => {
  const f = fixture(t);
  resolvePushRepo({ repo: f.execTree, home: f.home });
  fs.writeFileSync(path.join(f.dedicated, 'fleet-directives.json'), 'abandoned');
  fs.writeFileSync(path.join(f.dedicated, 'leftover'), 'abandoned');
  git(f.dedicated, 'remote', 'set-url', 'origin', path.join(f.root, 'missing.git'));
  assert.throws(() => main(sendArgs, { repo: f.execTree, home: f.home }), /fleet-directive-send: push failed:/);
  assert.equal(git(f.dedicated, 'status', '--porcelain'), '');
  assert.deepEqual(ids(f.bare), []);
});

test('main 上では直接 push し他の staged/unstaged 差分を保存する', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.seed, 'other'), 'staged');
  git(f.seed, 'add', 'other');
  fs.writeFileSync(path.join(f.seed, 'other'), 'unstaged');
  const before = git(f.seed, 'status', '--porcelain');
  assert.deepEqual(resolvePushRepo({ repo: f.seed, home: f.home }), { dir: f.seed, dedicated: false });
  const d = main(sendArgs, { repo: f.seed, home: f.home });
  assert.deepEqual(ids(f.bare), [d.id]);
  assert.equal(git(f.seed, 'status', '--porcelain'), before);
  assert.equal(git(f.seed, 'show', ':other'), 'staged');
  assert.equal(fs.readFileSync(path.join(f.seed, 'other'), 'utf8'), 'unstaged');
  assert.equal(fs.existsSync(f.dedicated), false);
});

for (const phase of ['add', 'commit', 'push', 'retry']) {
  test(`${phase} 失敗でも専用クローンは clean に戻る`, t => {
    const f = fixture(t);
    let pushes = 0;
    const injected = (command, args, options) => {
      if (args[0] === 'push') pushes++;
      if ((phase === 'add' && args[0] === 'add') || (phase === 'commit' && args.includes('commit')) ||
          ((phase === 'push' || phase === 'retry') && args[0] === 'push')) {
        return { status: 1, stderr: phase === 'retry' ? 'rejected (non-fast-forward)\nextra' : 'forced failure\nextra' };
      }
      return checkedSpawn(command, args, options);
    };
    assert.throws(() => main(sendArgs, { repo: f.execTree, home: f.home, spawnSync: injected }), /fleet-directive-send: push failed: [^\n]+$/);
    assert.equal(git(f.dedicated, 'status', '--porcelain'), '');
    assert.equal(git(f.dedicated, 'rev-parse', 'HEAD'), git(f.bare, 'rev-parse', 'main'));
    assert.equal(pushes, phase === 'retry' ? 2 : phase === 'push' ? 1 : 0);
  });
}

for (const phase of ['commit', 'push']) {
  test(`main で ${phase} 失敗時も他の変更を保存し指令ファイルの差分を消す`, t => {
    const f = fixture(t);
    fs.writeFileSync(path.join(f.seed, 'other'), 'staged');
    git(f.seed, 'add', 'other');
    fs.writeFileSync(path.join(f.seed, 'other'), 'unstaged');
    const before = git(f.seed, 'status', '--porcelain');
    assert.throws(() => main(sendArgs, {
      repo: f.seed, home: f.home,
      spawnSync: (command, args, options) => args.includes(phase)
        ? { status: 1, stderr: 'forced failure' } : checkedSpawn(command, args, options),
    }), /push failed/);
    assert.equal(git(f.seed, 'status', '--porcelain'), before);
    assert.equal(git(f.seed, 'show', ':other'), 'staged');
    assert.equal(fs.readFileSync(path.join(f.seed, 'other'), 'utf8'), 'unstaged');
  });
}

test('main の競合再試行でも両指令と無関係な作業を保持する', t => {
  const f = fixture(t);
  git(f.execTree, 'checkout', 'main');
  fs.writeFileSync(path.join(f.execTree, 'other'), 'staged');
  git(f.execTree, 'add', 'other');
  fs.writeFileSync(path.join(f.execTree, 'other'), 'unstaged');
  const before = git(f.execTree, 'status', '--porcelain');
  let pushes = 0;
  const d = main(sendArgs, {
    repo: f.execTree, home: f.home,
    spawnSync: (command, args, options) => {
      if (args[0] === 'push' && ++pushes === 1) {
        fs.writeFileSync(path.join(f.seed, 'fleet-directives.json'), JSON.stringify({ version: 1, directives: [{ id: 'concurrent' }] }));
        git(f.seed, 'commit', '-am', 'concurrent directive');
        git(f.seed, 'push', 'origin', 'main');
      }
      return checkedSpawn(command, args, options);
    },
  });
  assert.equal(pushes, 2);
  assert.deepEqual(ids(f.bare), ['concurrent', d.id]);
  assert.equal(git(f.execTree, 'status', '--porcelain'), before);
  assert.equal(git(f.execTree, 'show', ':other'), 'staged');
  assert.equal(fs.readFileSync(path.join(f.execTree, 'other'), 'utf8'), 'unstaged');
  assert.equal(git(f.execTree, 'stash', 'list'), '');
});
