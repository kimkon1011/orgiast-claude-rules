import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runCycle, atomicWrite, replayPending } from './tetsuko-growth-loop.mjs';
const now = new Date('2026-11-05T00:00:00Z');
function setup(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'growth-v4-git-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const repo = path.join(home, 'repo'), remote = path.join(home, 'remote.git'), root = path.join(home, 'wt');
  // File descriptors also work on restricted Linux hosts where pipe creation is denied.
  const spawn = (bin, args, opts = {}) => {
    const out = path.join(home, 'stdout'), err = path.join(home, 'stderr');
    const outFd = fs.openSync(out, 'w'), errFd = fs.openSync(err, 'w');
    try {
      const r = spawnSync(bin, args, { ...opts, stdio: ['ignore', outFd, errFd], env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
      return { ...r, stdout: fs.readFileSync(out, 'utf8'), stderr: fs.readFileSync(err, 'utf8') };
    } finally { fs.closeSync(outFd); fs.closeSync(errFd); }
  };
  const git = (args, cwd = repo) => { const r = spawn('git', args, { cwd, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout; };
  fs.mkdirSync(repo); git(['init', '--bare', remote]); git(['init', '-b', 'main']); git(['remote', 'add', 'origin', remote]);
  const actions = Array.from({ length: 6 }, (_, i) => ({ id: `A0${i + 1}`, title: `行動${i + 1}`, instructions: '確認資料を作る', status: i === 0 ? 'waiting' : 'todo', executor: 'llm', routes: ['llm-ask:gemini'], outputs: [`data/marketing/result-${i}.md`], verify: { type: 'file_contains', path: `data/marketing/result-${i}.md`, text: '用途' } }));
  atomicWrite(path.join(repo, 'data/marketing/backlog.json'), JSON.stringify({ actions }));
  git(['add', '.']); git(['commit', '-m', 'fixture']); git(['push', '-u', 'origin', 'main']);
  git(['checkout', '-b', 'owners-feature']); atomicWrite(path.join(repo, 'uncommitted'), 'preserve');
  const inboxRows = new Map();
  const inbox = async (_h, item) => { inboxRows.set(item.dedupeKey, item); return { id: item.dedupeKey }; };
  const execute = a => { atomicWrite(path.join(root, a.outputs[0]), '用途: 保管'); return { ok: true }; };
  return { home, root, tetsukoDir: repo, now, spawn, git, inbox, inboxRows, execute, weeklyImpl: async () => [] };
}
test('real git: waiting does not starve three executions; shared dirty branch preserved; migration once', async t => {
  const ctx = setup(t);
  const first = await runCycle(ctx); assert.equal(first.pushed, true);
  assert.deepEqual(first.rows.map(r => r.status), ['waiting', 'done', 'done', 'done']);
  assert.equal(ctx.git(['branch', '--show-current']).trim(), 'owners-feature');
  assert.equal(fs.readFileSync(path.join(ctx.tetsukoDir, 'uncommitted'), 'utf8'), 'preserve');
  const second = await runCycle({ ...ctx, now: new Date('2026-11-06') }); assert.equal(second.pushed, true);
  const legacy = ctx.git(['show', 'origin/main:data/growth-loop-log.md'], ctx.root);
  assert.equal(legacy.split('<!-- tetsuko-growth-v4 -->').length, 2);
  const remote = JSON.parse(ctx.git(['show', 'origin/main:data/marketing/backlog.json'], ctx.root));
  assert.equal(remote.actions.filter(a => a.status === 'done').length, 5);
  assert.equal([...ctx.inboxRows.values()].filter(a => a.kind === 'ask').length, 1);
});
test('push failure journals all output and state; replay pushes before executing later actions', async t => {
  const ctx = setup(t), real = ctx.spawn;
  ctx.spawn = (bin, args, opts) => args[0] === 'push' ? { status: 1, stdout: '', stderr: 'offline' } : real(bin, args, opts);
  const result = await runCycle(ctx); assert.equal(result.pushed, false);
  const pending = path.join(ctx.home, '.claude/tetsuko-growth/pending-v4.json');
  const record = JSON.parse(fs.readFileSync(pending)); assert.ok(record.files.some(f => f.path === 'data/marketing/result-1.md'));
  ctx.spawn = real;
  const second = await runCycle(ctx); assert.equal(second.pushed, true); assert.equal(fs.existsSync(pending), false);
  assert.equal(second.rows.filter(r => r.status === 'done').length, 2);
});
test('pending replay conflicts preserve newer content and journal', t => {
  const ctx = setup(t); fs.mkdirSync(ctx.root);
  const file = 'data/marketing/backlog.json'; atomicWrite(path.join(ctx.root, file), 'concurrent update');
  const pending = path.join(ctx.home, '.claude/tetsuko-growth/pending-v4.json');
  atomicWrite(pending, JSON.stringify({ root: ctx.root, files: [{ path: file, before: 'old', after: 'ours' }] }));
  assert.throws(() => replayPending(ctx.home, ctx.root), /pending_conflict/);
  assert.equal(fs.readFileSync(path.join(ctx.root, file), 'utf8'), 'concurrent update'); assert.ok(fs.existsSync(pending));
});
test('dirty dedicated worktree stops without discarding changes', async t => {
  const ctx = setup(t); await runCycle(ctx);
  atomicWrite(path.join(ctx.root, 'someone-else.txt'), 'preserve');
  await assert.rejects(() => runCycle(ctx), /worktree_dirty/);
  assert.equal(fs.readFileSync(path.join(ctx.root, 'someone-else.txt'), 'utf8'), 'preserve');
});
test('v3 pending records are delivered once during migration and acknowledged after push', async t => {
  const ctx = setup(t), file = path.join(ctx.home, '.claude/tetsuko-growth/pending/old-cycle/cycle.json');
  atomicWrite(file, JSON.stringify({ body: 'previous generated cycle', briefing: 'previous brief' }));
  assert.equal((await runCycle(ctx)).pushed, true);
  assert.equal(fs.existsSync(file), false);
  const log = fs.readFileSync(path.join(ctx.root, 'data/growth-loop-log.md'), 'utf8');
  assert.match(log, /previous generated cycle/); assert.match(log, /growth-pending:old-cycle/);
});
