import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureMainWorktree, commitAndPush, runCycle, writeRunLog } from './tetsuko-growth-loop.mjs';
const success = { status: 0, stdout: '', stderr: '' };
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'growth-heal-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const wt = path.join(home, '.claude/tetsuko-growth-main');
  const repo = path.join(home, 'shared');
  for (const dir of [wt, repo]) {
    fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.git'), 'gitdir: unused');
    fs.writeFileSync(path.join(dir, 'data/growth-loop-log.md'), '');
    fs.writeFileSync(path.join(dir, 'TETSUKO_DAILY_BRIEFING.md'), 'brief');
  }
  return { home, wt, repo };
}
function stub(handler = () => undefined) {
  const calls = [];
  const spawn = (cmd, args, opts) => {
    calls.push({ cmd, args, cwd: opts?.cwd });
    return handler(cmd, args, opts) ?? (args.join(' ') === 'rev-parse --abbrev-ref HEAD'
      ? { ...success, stdout: 'main\n' } : cmd === 'git' ? success : { status: 1, stderr: 'offline' });
  };
  spawn.calls = calls;
  return spawn;
}
for (const state of ['rebase-merge', 'rebase-apply']) test(`recovery backs up before abort: ${state}`, t => {
  const { home, wt, repo } = fixture(t);
  fs.mkdirSync(path.join(wt, state));
  fs.writeFileSync(path.join(wt, 'data/growth-loop-log.md'), 'unpublished');
  const spawn = stub((cmd, args) => {
    if (args[0] === 'rev-parse' && args[1] === '--git-path') return { ...success, stdout: args[2] };
    if (args.join(' ') === 'rebase --abort') {
      const pending = path.join(home, '.claude/tetsuko-growth/pending');
      const dir = fs.readdirSync(pending)[0];
      assert.equal(fs.readFileSync(path.join(pending, dir, 'data/growth-loop-log.md'), 'utf8'), 'unpublished');
      assert.equal(fs.readFileSync(path.join(pending, dir, 'TETSUKO_DAILY_BRIEFING.md'), 'utf8'), 'brief');
    }
  });
  assert.equal(ensureMainWorktree(repo, wt, spawn, 'main', { home }).ok, true);
  const commands = spawn.calls.map(c => c.args.join(' '));
  assert.ok(commands.indexOf('rebase --abort') >= 0);
  assert.ok(commands.indexOf('reset --hard origin/main') > commands.indexOf('rebase --abort'));
});
test('backup failure never aborts or resets', t => {
  const { home, wt, repo } = fixture(t);
  fs.mkdirSync(path.join(wt, 'rebase-merge'));
  fs.mkdirSync(path.join(home, '.claude/tetsuko-growth'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude/tetsuko-growth/pending'), 'blocked');
  const spawn = stub((cmd, args) => args[1] === '--git-path' ? { ...success, stdout: args[2] } : undefined);
  assert.equal(ensureMainWorktree(repo, wt, spawn, 'main', { home }).ok, false);
  assert.equal(spawn.calls.some(c => ['rebase', 'checkout', 'reset'].includes(c.args[0])), false);
});
test('failed retry rebase is immediately aborted', () => {
  const spawn = stub((cmd, args) => ['push', 'pull --rebase'].includes(args.join(' ')) ? { status: 1 } : undefined);
  const result = commitAndPush('/unused', 1, spawn);
  assert.equal(result.ok, false);
  assert.equal(spawn.calls.at(-1).args.join(' '), 'rebase --abort');
});
test('failed ff-only is a failure', t => {
  const { wt, repo } = fixture(t);
  const spawn = stub((cmd, args) => args.join(' ') === 'pull --ff-only' ? { status: 1 } : undefined);
  assert.equal(ensureMainWorktree(repo, wt, spawn).ok, false);
  assert.equal(commitAndPush(wt, 1, spawn).ok, false);
});
const draft = '**【テスト】施策**\n- 根拠: 確認\n- 期待効果: 改善\n- 実行難易度: 低\n- 担当区分: Codex実装';
test('failed worktree queues body without shared writes; next run imports once with new numbers', async t => {
  const { home, wt, repo } = fixture(t);
  const spawn = stub((cmd, args) => cmd !== 'git' ? { ...success, stdout: draft }
    : args.join(' ') === 'rev-parse --abbrev-ref HEAD' ? { ...success, stdout: 'other-branch' }
    : args.join(' ') === 'status --porcelain' ? { ...success, stdout: ' M data/growth-loop-log.md' } : undefined);
  const result = await runCycle({ tetsukoDir: repo, home, spawn });
  assert.equal(fs.readFileSync(path.join(repo, 'data/growth-loop-log.md'), 'utf8'), '');
  assert.equal(result.saved, true);
  assert.equal(result.pushed, false);
  assert.equal(result.workDir, null);
  assert.equal(spawn.calls.some(c => c.args[0] === 'add'), false);
  fs.writeFileSync(path.join(wt, 'data/growth-loop-log.md'), '## date サイクル#9\n');
  const healthy = stub((cmd) => cmd !== 'git' ? { ...success, stdout: draft } : undefined);
  await runCycle({ tetsukoDir: repo, home, spawn: healthy });
  await runCycle({ tetsukoDir: repo, home, spawn: healthy });
  const text = fs.readFileSync(path.join(wt, 'data/growth-loop-log.md'), 'utf8');
  assert.deepEqual([...text.matchAll(/^## .*サイクル#(\d+)/gm)].map(m => +m[1]), [9, 10, 11, 12]);
});
test('history reports zero generation and push failure honestly', async t => {
  const { home, wt, repo } = fixture(t);
  const result = await runCycle({ tetsukoDir: repo, home, spawn: stub() });
  assert.equal(result.itemCount, 0);
  const { historyFile } = writeRunLog(home, result.cycleNumber, result);
  const row = JSON.parse(fs.readFileSync(historyFile, 'utf8').trim());
  assert.equal(row.ok, false);
  assert.equal(row.generated, false);
  assert.equal(row.saved, true);
  assert.equal(row.pushed, true);
  assert.equal(row.workDir, wt);
  assert.equal(row.gitReason, null);
  writeRunLog(home, 2, { ...result, generated: true, pushed: false, gitReason: 'push_failed', gitResult: { ok: false } });
  const failed = JSON.parse(fs.readFileSync(historyFile, 'utf8').trim().split('\n').at(-1));
  assert.equal(failed.ok, false);
  assert.equal(failed.gitReason, 'push_failed');
});
test('failed push keeps pending; retry neither duplicates nor drops body', async t => {
  const { home, wt, repo } = fixture(t);
  const failed = stub((cmd, args) => cmd !== 'git' ? { ...success, stdout: draft }
    : args[0] === 'push' ? { status: 1 } : undefined);
  const result = await runCycle({ home, tetsukoDir: repo, spawn: failed });
  assert.equal(result.pushed, false);
  assert.ok(fs.existsSync(path.join(result.pendingDir, 'cycle.json')));
  const healthy = stub(cmd => cmd !== 'git' ? { ...success, stdout: draft } : undefined);
  await runCycle({ home, tetsukoDir: repo, spawn: healthy });
  const log = fs.readFileSync(path.join(wt, 'data/growth-loop-log.md'), 'utf8');
  assert.deepEqual([...log.matchAll(/^## .*サイクル#(\d+)/gm)].map(m => +m[1]), [1, 2]);
  assert.equal(fs.existsSync(path.join(result.pendingDir, 'cycle.json')), false);
});
test('abort failure stops before checkout/reset', t => {
  const { home, wt, repo } = fixture(t);
  fs.mkdirSync(path.join(wt, 'rebase-merge'));
  const spawn = stub((cmd, args) => args[1] === '--git-path' ? { ...success, stdout: args[2] }
    : args[0] === 'rebase' ? { status: 1 } : undefined);
  const result = ensureMainWorktree(repo, wt, spawn, 'main', { home });
  assert.equal(result.reason, 'worktree_abort_failed');
  assert.equal(spawn.calls.some(c => ['checkout', 'reset'].includes(c.args[0])), false);
});
test('pending write failure is saved:false and preserves generated:true', async t => {
  const { home, repo } = fixture(t);
  fs.mkdirSync(path.join(home, '.claude/tetsuko-growth'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude/tetsuko-growth/pending'), 'blocked');
  const spawn = stub(cmd => cmd !== 'git' ? { ...success, stdout: draft } : undefined);
  const result = await runCycle({ home, tetsukoDir: repo, skipGit: true, spawn });
  assert.equal(result.generated, true);
  assert.equal(result.saved, false);
  assert.equal(result.pushed, false);
  assert.equal(result.gitReason, 'save_or_git_failed');
});
test('failure notification uses existing notify-kim with spawn stub only', async () => {
  const { notifyFailure } = await import('./tetsuko-growth-loop.mjs');
  const spawn = stub(() => success);
  await notifyFailure('/tmp/fake-home', { generated: false }, spawn);
  assert.equal(path.basename(spawn.calls[0].args[0]), 'notify-kim.mjs');
  assert.match(spawn.calls[0].args[1], /施策生成0件/);
});
