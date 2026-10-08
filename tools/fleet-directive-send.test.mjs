import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { directiveId, main, pruneDirectives } from './fleet-directive-send.mjs';

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

// 2026-10-08 朝バッチ実績: 夜間ツリー(nightly-repo)は bootstrap が checkout --detach させるため、
// 旧実装の refspec 無し `git push` は「not currently on a branch」で必ず落ち、stale_report の
// 再送指令が毎朝失敗していた。detach 状態でも push が通ることを固定する。
function tempGitRepo(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-send-git-'));
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); });
  const remote = path.join(root, 'remote.git');
  const repo = path.join(root, 'repo');
  const git = (dir, args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  fs.mkdirSync(repo, { recursive: true });
  git(root, ['init', '--bare', remote]);
  git(repo, ['init', '-b', 'main']);
  git(repo, ['config', 'user.name', 'Test']);
  git(repo, ['config', 'user.email', 'test@example.invalid']);
  fs.writeFileSync(path.join(repo, 'fleet-directives.json'), JSON.stringify({ version: 1, directives: [] }));
  git(repo, ['add', 'fleet-directives.json']);
  git(repo, ['commit', '-m', 'initial']);
  git(repo, ['remote', 'add', 'origin', remote]);
  git(repo, ['push', '-u', 'origin', 'main']);
  return { repo, remote, git };
}

test('--push は detached HEAD でも HEAD:main で push して遠隔に届く', (t) => {
  const { repo, remote, git } = tempGitRepo(t);
  git(repo, ['fetch', 'origin']);
  git(repo, ['checkout', '--detach', 'origin/main']);
  const directive = main(['--kind', 'status', '--targets', 'kimko-PC', '--why', 'stale_report 自動復旧', '--push'], { repo, randomInt: () => 1 });
  const pushed = JSON.parse(git(remote, ['show', 'main:fleet-directives.json']));
  assert.deepEqual(pushed.directives.map((item) => item.id), [directive.id]);
  assert.equal(pushed.directives[0].targets, 'kimko-PC');
});

test('--push の失敗理由に stderr を含めて throw する', (t) => {
  const { repo, git } = tempGitRepo(t);
  git(repo, ['remote', 'set-url', 'origin', path.join(path.dirname(repo), 'missing-remote.git')]);
  assert.throws(() => main(['--kind', 'status', '--why', '再送', '--push'], { repo, randomInt: () => 1 }), /git push failed/);
});

test('--push はコマンドを引数配列で個別実行し shell 経由にしない', () => {
  const repo = tempRepo();
  const calls = [];
  const spawnSync = (cmd, args, opts) => {
    calls.push({ cmd, args, shell: Boolean(opts?.shell) });
    if (args[0] === 'symbolic-ref') return { status: 1, stdout: '', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  const directive = main(['--kind', 'status', '--why', '再送', '--push'], { repo, randomInt: () => 1, spawnSync });
  assert.deepEqual(calls.find((call) => call.args[0] === 'commit').args, ['commit', '-m', `fleet: add directive ${directive.id}`]);
  assert.deepEqual(calls.find((call) => call.args[0] === 'push').args, ['push', 'origin', 'HEAD:main']);
  assert.ok(calls.length > 0 && calls.every((call) => !call.shell));
  assert.ok(!calls.some((call) => call.args.includes('&&')), 'shell 連結引数が残っている');
});

test('--push はブランチ上では従来どおり refspec 無しの push', () => {
  const repo = tempRepo();
  const calls = [];
  const spawnSync = (cmd, args) => {
    calls.push({ args });
    if (args[0] === 'symbolic-ref') return { status: 0, stdout: 'refs/heads/main\n', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  main(['--kind', 'status', '--why', '再送', '--push'], { repo, randomInt: () => 1, spawnSync });
  assert.deepEqual(calls.find((call) => call.args[0] === 'push').args, ['push']);
});
