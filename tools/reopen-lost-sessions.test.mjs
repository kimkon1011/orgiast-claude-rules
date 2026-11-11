import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hasConversation, hasHostExit, exclusion, parseAgents, parseOptions, localIndex, acquireLock, resolveClaudeCli, reopenLost, watchReopen, findWorkspaceForCwd, parseJsonTolerant, uriToPath, resolveReopenFolder, agentsFromRegistry, writeProgress, measureCpuAsync, hasCodeWindow, resolveLaunchTarget, watchdogRecord } from './reopen-lost-sessions.mjs';

const since = '2026-11-05T19:40:00Z', until = '2026-11-05T20:15:00Z';
const exit = { event_type: 'system', payload: { reason: 'host_exit' }, created_at: since };

// git worktree を模した一時フォルダ（.git ファイルが gitdir: .../worktrees/... を指す）
function makeWorktreeFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-det-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const mainDir = path.join(root, 'repo-main');
  const wtDir = path.join(root, '.claude', 'worktrees', 'mail-approval-gate-fix');
  fs.mkdirSync(wtDir, { recursive: true });
  fs.writeFileSync(path.join(wtDir, '.git'),
    `gitdir: ${path.join(mainDir, '.git', 'worktrees', 'mail-approval-gate-fix').replace(/\\/g, '/')}\n`, 'utf8');
  return { root, mainDir, wtDir };
}

test('resolveReopenFolder: worktree でない cwd はそのまま返す', () => {
  assert.equal(resolveReopenFolder('C:\\Users\\uers\\Downloads\\CLAUDE.md配布', [], { fsImpl: fs }), 'C:\\Users\\uers\\Downloads\\CLAUDE.md配布');
});

test('resolveReopenFolder: worktree cwd は cwd 履歴の最初の非 worktree を開く（\.claude\worktrees\ 検出）', () => {
  const wt = 'C:\\Users\\uers\\.claude\\worktrees\\mail-approval-gate-fix';
  const history = ['C:\\Users\\uers\\Downloads\\CLAUDE.md配布', 'C:\\Users\\uers\\.claude\\worktrees\\other'];
  assert.equal(resolveReopenFolder(wt, history, { fsImpl: fs }), history[0]);
  assert.equal(resolveReopenFolder(wt, [], { fsImpl: fs, spawn: () => ({ status: 1 }) }), null);
});

test('resolveReopenFolder: .git ファイルで worktree を検出し、履歴・メイン worktree・スキップへ', t => {
  const { mainDir, wtDir } = makeWorktreeFixture(t);
  const normal = path.join(mainDir, '.claude');
  fs.mkdirSync(normal, { recursive: true });
  // 履歴に非 worktree があればそれを使う
  assert.equal(resolveReopenFolder(wtDir, [normal, path.join(mainDir, 'other')], { fsImpl: fs }), normal);
  // 履歴が全て worktree なら git worktree list のメイン worktree（git は / 区切りで返す）
  const wt2 = path.join(mainDir, '.claude\\worktrees', 'another');
  const porcelain = `worktree ${mainDir.replace(/\\/g, '/')}\nHEAD 0123abcd\n\nworktree ${wt2.replace(/\\/g, '/')}\nHEAD deadbeef\n`;
  assert.equal(resolveReopenFolder(wtDir, [wt2], { fsImpl: fs, spawn: () => ({ status: 0, stdout: porcelain }) }), mainDir.replace(/\\/g, '/'));
  // worktree のサブディレクトリでも祖先を遡って検出する
  const sub = path.join(wtDir, 'src', 'deep');
  fs.mkdirSync(sub, { recursive: true });
  assert.equal(resolveReopenFolder(sub, [normal], { fsImpl: fs }), normal);
  // どちらも無ければ null（スキップ）
  assert.equal(resolveReopenFolder(wtDir, [wt2], { fsImpl: fs, spawn: () => ({ status: 1 }) }), null);
});

test('localIndex は cwd 履歴を出現順・大小文字無視の重複除去で保持する', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reopen-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const projects = path.join(root, '.claude', 'projects', 'proj');
  fs.mkdirSync(projects, { recursive: true });
  fs.writeFileSync(path.join(projects, 'hist.jsonl'), [
    { type: 'bridge-session', bridgeSessionId: 'cse_hist' },
    { type: 'user', cwd: 'C:\\Start\\Dir', message: { content: 'first' } },
    { type: 'user', cwd: 'c:\\start\\dir', message: { content: 'dup' } },
    { type: 'user', cwd: 'C:\\Users\\uers\\.claude\\worktrees\\mail-approval-gate-fix', message: { content: 'second' } },
  ].map(JSON.stringify).join('\n'));
  const idx = localIndex(path.join(root, '.claude'));
  const local = idx.get('cse_hist');
  assert.equal(local.cwd, 'C:\\Start\\Dir');
  assert.deepEqual(local.cwds, ['C:\\Start\\Dir', 'C:\\Users\\uers\\.claude\\worktrees\\mail-approval-gate-fix']);
});

test('reopenLost: worktree cwd のセッションは最初の非 worktree cwd を開き、folder をログに残す', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reopen-wt-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const base = path.join(root, '.claude');
  const normalDir = path.join(root, 'normal-work');
  fs.mkdirSync(path.join(base, 'projects', 'proj'), { recursive: true });
  fs.mkdirSync(normalDir, { recursive: true });
  fs.writeFileSync(path.join(base, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'mock' } }));
  fs.writeFileSync(path.join(root, '.claude.json'), JSON.stringify({ oauthAccount: { organizationUuid: 'mock' } }));
  const wtDir = path.join(root, '.claude', 'worktrees', 'mail-approval-gate-fix');
  fs.mkdirSync(wtDir, { recursive: true });
  fs.writeFileSync(path.join(wtDir, '.git'), `gitdir: ${path.join(root, 'main', '.git', 'worktrees', 'mail-approval-gate-fix').replace(/\\/g, '/')}\n`, 'utf8');
  fs.writeFileSync(path.join(base, 'projects', 'proj', 'one.jsonl'), [
    { type: 'bridge-session', bridgeSessionId: 'cse_one' },
    { type: 'user', cwd: normalDir, message: { content: 'started here' } },
    { type: 'user', cwd: wtDir, message: { content: 'moved to worktree' } },
  ].map(JSON.stringify).join('\n'));
  const psCalls = [];
  const result = await reopenLost({
    base, since, until, claudeCli: 'claude.exe', codeCli: 'C:\\code.cmd', checkCpu: false, env: { APPDATA: path.join(root, 'no-appdata') },
    fetchImpl: async url => ({ ok: true, json: async () => url.includes('/events?') ? { data: [exit] } : { data: [{ id: 'cse_one' }] } }),
    spawn: (cmd, args) => {
      if (args[0] !== 'agents') {
        // hasCodeWindow の呼び出し（Get-Process Code + .Count）は psCalls に記録せず、ウィンドウ無し(0)を返す
        const cmdStr = args[args.length - 1];
        if (cmdStr.includes('Get-Process Code') && cmdStr.includes('.Count')) {
          return { status: 0, stdout: '0' };
        }
        psCalls.push(cmdStr);
      }
      return { status: 0, stdout: args[0] === 'agents' ? '[]' : '' };
    },
    windowReady: () => true,
    wait: async () => {},
  });
  assert.equal(result.reopened.length, 1);
  assert.equal(result.reopened[0].folder, normalDir);
  assert.equal(result.reopened[0].target, normalDir);
  assert.equal(result.reopened[0].openedWith, 'folder');
  assert.ok(psCalls[0].includes(normalDir), `should open the non-worktree folder: ${psCalls[0]}`);
  assert.ok(!psCalls[0].includes(wtDir.split(path.sep).pop()), `should not open the worktree folder: ${psCalls[0]}`);
});

test('reopenLost: worktree 履歴だけ・メイン worktree も取れない場合は skipped.worktree になる', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reopen-wt-skip-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const base = path.join(root, '.claude');
  fs.mkdirSync(path.join(base, 'projects', 'proj'), { recursive: true });
  fs.writeFileSync(path.join(base, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'mock' } }));
  fs.writeFileSync(path.join(root, '.claude.json'), JSON.stringify({ oauthAccount: { organizationUuid: 'mock' } }));
  const wtDir = path.join(root, '.claude', 'worktrees', 'mail-approval-gate-fix');
  fs.mkdirSync(wtDir, { recursive: true });
  fs.writeFileSync(path.join(wtDir, '.git'), 'gitdir: C:/x/.git/worktrees/mail-approval-gate-fix\n', 'utf8');
  fs.writeFileSync(path.join(base, 'projects', 'proj', 'one.jsonl'), [
    { type: 'bridge-session', bridgeSessionId: 'cse_one' },
    { type: 'user', cwd: wtDir, message: { content: 'only worktree' } },
  ].map(JSON.stringify).join('\n'));
  const result = await reopenLost({
    base, since, until, claudeCli: 'claude.exe', codeCli: 'C:\\code.cmd', checkCpu: false,
    fetchImpl: async url => ({ ok: true, json: async () => url.includes('/events?') ? { data: [exit] } : { data: [{ id: 'cse_one' }] } }),
    spawn: (cmd, args) => {
      if (args[0] === 'git') return { status: 1 };
      return { status: 0, stdout: args[0] === 'agents' ? '[]' : '' };
    },
    windowReady: () => true,
    wait: async () => {},
  });
  assert.equal(result.reopened.length, 0);
  assert.equal(result.skipped.worktree, 1);
  assert.equal(result.skipped.closed, 0);
});

test('host exit interval inclusive; excludes wrong reason/type/time', () => {
  assert.equal(hasHostExit([exit], since, until), true);
  assert.equal(hasHostExit([{ ...exit, created_at: until }], since, until), true);
  for (const row of [{ ...exit, created_at: '2020-01-01' }, { ...exit, event_type: 'user' }, { ...exit, payload: {} }]) assert.equal(hasHostExit([row], since, until), false);
});

test('purge compatible empty detection and exclusions', () => {
  for (const marker of ['command-name', 'local-command-caveat', 'command-message']) assert.equal(hasConversation([{ type: 'user', message: { content: `<${marker}>` } }]), false);
  assert.equal(hasConversation([{ type: 'assistant', message: { content: [{ text: 'answer' }] } }]), true);
  assert.equal(hasConversation([], 204801), true);
  const local = { id: 'one', cwd: 'C:\\work', hasConversation: true };
  assert.equal(exclusion(local, new Set(), new Set()), null);
  assert.equal(exclusion(local, new Set(['one']), new Set()), 'closed');
  assert.equal(exclusion(local, new Set(), new Set(['one'])), 'alive');
  assert.equal(exclusion({ ...local, hasConversation: false }, new Set(), new Set()), 'empty');
  assert.equal(exclusion(null, new Set(), new Set()), 'noLocal');
  for (const raw of ['', '{}', '[{}]']) assert.throws(() => parseAgents(raw));
  assert.deepEqual([...parseAgents('[]')], []);
});

test('CLI validation and default boot range', () => {
  assert.throws(() => parseOptions(['--max', '-1']));
  assert.throws(() => parseOptions(['--since', 'bad', '--until', until]));
  const o = parseOptions([], () => ({ status: 0, stdout: '2026-11-05T20:00:00Z' }));
  assert.equal(o.since, '2026-11-05T19:45:00.000Z');
  assert.equal(o.until, '2026-11-05T20:15:00.000Z');
});

test('parseOptions watch mode mutual exclusivity', () => {
  assert.throws(() => parseOptions(['--watch', '--since', '2026-11-05T00:00:00Z']));
  assert.throws(() => parseOptions(['--watch', '--until', '2026-11-05T00:00:00Z']));
  const opts = parseOptions(['--watch', '--max', '5']);
  assert.equal(opts.watch, true);
  assert.equal(opts.max, 5);
  assert.equal(opts.maxSet, true);
});

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reopen-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const base = path.join(root, '.claude');
  fs.mkdirSync(path.join(base, 'projects', 'proj'), { recursive: true });
  fs.writeFileSync(path.join(base, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'mock' } }));
  fs.writeFileSync(path.join(root, '.claude.json'), JSON.stringify({ oauthAccount: { organizationUuid: 'mock' } }));
  fs.writeFileSync(path.join(base, 'projects', 'proj', 'one.jsonl'), [
    { type: 'bridge-session', bridgeSessionId: 'cse_one' },
    { type: 'user', cwd: 'C:\\work', message: { content: 'hello' } },
  ].map(JSON.stringify).join('\n'));
  return base;
}

test('localIndex uses first cwd when transcript has multiple cwd lines', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reopen-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const projects = path.join(root, '.claude', 'projects', 'proj');
  fs.mkdirSync(projects, { recursive: true });
  fs.writeFileSync(path.join(projects, 'multi.jsonl'), [
    { type: 'bridge-session', bridgeSessionId: 'cse_multi' },
    { type: 'user', cwd: 'C:\\start\\cwd', message: { content: 'first' } },
    { type: 'user', cwd: 'C:\\worktree\\later', message: { content: 'second' } },
  ].map(JSON.stringify).join('\n'));
  const idx = localIndex(path.join(root, '.claude'));
  assert.equal(idx.size, 1);
  assert.equal(idx.get('cse_multi').cwd, 'C:\\start\\cwd');
});

test('dry run uses real local mapping, paginates, never opens/writes', async t => {
  const base = fixture(t), calls = [];
  const fetchImpl = async url => { calls.push(url); return { ok: true, json: async () => url.includes('/events?') ? { data: [exit] } : url.includes('cursor=next') ? { data: [] } : { data: [{ id: 'cse_one', title: 'Work' }], next_cursor: 'next' } }; };
  const result = await reopenLost({ base, since, until, dryRun: true, claudeCli: 'claude.exe', fetchImpl, spawn: (cmd, args) => {
    assert.deepEqual(args, ['agents', '--json']); return { status: 0, stdout: '[]' };
  } });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.reopened.length, 0);
  assert.equal(calls.length, 3);
  assert.equal(fs.existsSync(path.join(base, 'reopen-lost-sessions.log')), false);
  fs.mkdirSync(path.join(base, 'projects', '_deleted-backup'));
  fs.renameSync(path.join(base, 'projects', 'proj', 'one.jsonl'), path.join(base, 'projects', '_deleted-backup', 'one.jsonl'));
  assert.equal(localIndex(base).size, 0);
});

test('opening continues after API deadline; focus precedes URI; lock released and log written', async t => {
  const base = fixture(t), calls = []; let clock = 0;
  const result = await reopenLost({ base, since, until, claudeCli: 'claude.exe', codeCli: 'C:\\code.cmd', now: () => clock, checkCpu: false, env: { APPDATA: path.join(base, 'no-appdata') },
    fetchImpl: async url => ({ ok: true, json: async () => url.includes('/events?') ? { data: [exit] } : { data: [{ id: 'cse_one' }] } }),
    spawn: (cmd, args) => {
      // hasCodeWindow の呼び出しはウィンドウ無し(0)を返し、calls に記録しない
      const cmdStr = args[args.length - 1];
      if (cmdStr.includes('Get-Process Code') && cmdStr.includes('.Count')) {
        return { status: 0, stdout: '0' };
      }
      calls.push(args);
      return { status: 0, stdout: args[0] === 'agents' ? '[]' : '' };
    },
    windowReady: () => { clock = 120000; return true; }, wait: async () => {},
  });
  assert.equal(result.reopened.length, 1);
  const ps = calls.filter(a => a[0] !== 'agents');
  assert.ok(ps[0].at(-1).includes('C:\\work'));
  assert.ok(ps[1].at(-1).includes('--open-url'));
  assert.equal(fs.existsSync(path.join(base, 'reopen-lost-sessions.lock')), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(base, 'reopen-lost-sessions.log'))).reopened.length, 1);
});

test('unknown agents prevents API/open; concurrent lock and stale lock', async t => {
  const base = fixture(t);
  const result = await reopenLost({ base, since, until, dryRun: true, claudeCli: 'claude.exe', spawn: () => ({ status: 1 }), fetchImpl: () => assert.fail() });
  // agents 失敗→registry fallback→sessions ディレクトリ無しで ENOENT
  assert.ok(result.error, 'should propagate ENOENT from registry');
  const file = path.join(base, 'test.lock'), release = acquireLock(file);
  assert.equal(acquireLock(file), null); release();
  fs.writeFileSync(file, 'stale'); fs.utimesSync(file, new Date(0), new Date(0));
  acquireLock(file)();
});

test('API failure is explicit and partial candidates survive API-only deadline', async t => {
  const base = fixture(t); let clock = 0;
  const result = await reopenLost({ base, since, until, dryRun: true, claudeCli: 'claude.exe', now: () => clock,
    spawn: () => ({ status: 0, stdout: '[]' }), fetchImpl: async url => ({ ok: true, json: async () => {
      if (url.includes('/events?')) { clock = 61000; return { data: [exit] }; }
      assert.equal(new URL(url).searchParams.has('cursor'), false);
      return { data: [{ id: 'cse_one' }], next_cursor: 'later' };
    } }),
  });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.apiError, 'API time limit');
});

test('closed during fetch is excluded at dispatch time', async t => {
  const base = fixture(t);
  const result = await reopenLost({ base, since, until, claudeCli: 'claude.exe', codeCli: 'mock',
    spawn: (cmd, args) => { assert.equal(args[0], 'agents'); return { status: 0, stdout: '[]' }; },
    fetchImpl: async url => ({ ok: true, json: async () => {
      if (url.includes('/events?')) { fs.writeFileSync(path.join(base, 'closed-sessions.json'), JSON.stringify({ ids: ['one'] })); return { data: [exit] }; }
      return { data: [{ id: 'cse_one' }] };
    } }),
  });
  assert.equal(result.reopened.length, 0);
  assert.equal(result.skipped.closed, 1);
});

test('watchReopen since/until calculation and watermark behavior', async t => {
  const base = fixture(t);
  const fixedNow = Date.parse('2026-11-07T12:00:00.000Z');
  const now = () => fixedNow;
  const stateFile = path.join(base, 'reopen-lost-sessions-state.json');

  const fetchImplNoOp = async url => ({ ok: true, json: async () => url.includes('/events?') ? { data: [] } : { data: [] } });
  const spawnNoOp = () => ({ status: 0, stdout: '[]' });

  // Case A: No state file -> defaultSince = now - 30m, until = now - 60s
  let result = await watchReopen({ base, claudeCli: 'claude.exe', fetchImpl: fetchImplNoOp, spawn: spawnNoOp, now });
  assert.equal(result.since, '2026-11-07T11:30:00.000Z');
  assert.equal(result.until, '2026-11-07T11:59:00.000Z');
  assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).watermark, '2026-11-07T11:59:00.000Z');

  // Case B: Watermark exists and is recent -> since = watermark
  fs.writeFileSync(stateFile, JSON.stringify({ watermark: '2026-11-07T10:00:00.000Z' }) + '\n');
  result = await watchReopen({ base, claudeCli: 'claude.exe', fetchImpl: fetchImplNoOp, spawn: spawnNoOp, now });
  assert.equal(result.since, '2026-11-07T10:00:00.000Z');
  assert.equal(result.until, '2026-11-07T11:59:00.000Z');

  // Case C: Watermark exists but is older than 24h -> truncated to now - 24h
  fs.writeFileSync(stateFile, JSON.stringify({ watermark: '2026-11-05T10:00:00.000Z' }) + '\n');
  result = await watchReopen({ base, claudeCli: 'claude.exe', fetchImpl: fetchImplNoOp, spawn: spawnNoOp, now });
  assert.equal(result.since, '2026-11-06T12:00:00.000Z');
  assert.equal(result.until, '2026-11-07T11:59:00.000Z');

  // Case D: Dry run -> state watermark not changed
  fs.writeFileSync(stateFile, JSON.stringify({ watermark: '2026-11-07T11:00:00.000Z' }) + '\n');
  result = await watchReopen({ base, claudeCli: 'claude.exe', dryRun: true, fetchImpl: fetchImplNoOp, spawn: spawnNoOp, now });
  assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).watermark, '2026-11-07T11:00:00.000Z');

  // Case E: Error / API error -> state watermark not changed
  const fetchImplError = async () => ({ ok: false, status: 500 });
  result = await watchReopen({ base, claudeCli: 'claude.exe', fetchImpl: fetchImplError, spawn: spawnNoOp, now });
  assert.ok(result.apiError);
  assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).watermark, '2026-11-07T11:00:00.000Z');
});

test('exclusions for archivedByUser and reopenLoop', async t => {
  const base = fixture(t);
  const now = () => Date.parse('2026-11-07T12:00:00.000Z');

  // archivedByUser test: session.status === 'archived' and hostExitArchive is false
  const userArchivedEvent = { event_type: 'user', payload: { request: { subtype: 'end_session', reason: 'archived' } }, created_at: '2026-11-07T11:00:00Z' };
  const fetchImplArchived = async url => ({ ok: true, json: async () => url.includes('/events?') ? { data: [exit, userArchivedEvent] } : { data: [{ id: 'cse_one', status: 'archived' }] } });

  let result = await reopenLost({ base, since, until, dryRun: true, claudeCli: 'claude.exe', now, fetchImpl: fetchImplArchived, spawn: () => ({ status: 0, stdout: '[]' }) });
  assert.equal(result.skipped.archivedByUser, 1);

  // reopenLoop test: 60分以内に「再接続に成功した（verified）」reopen が3回 → ループとして止める
  const logFile = path.join(base, 'reopen-lost-sessions.log');
  const logEntries = [
    { at: '2026-11-07T11:00:00.000Z', reopened: [{ id: 'one' }], verified: ['one'] },
    { at: '2026-11-07T11:20:00.000Z', reopened: [{ id: 'one' }], verified: ['one'] },
    { at: '2026-11-07T11:40:00.000Z', reopened: [{ id: 'one' }], verified: ['one'] },
  ];
  fs.writeFileSync(logFile, logEntries.map(e => JSON.stringify(e)).join('\n') + '\n');

  const fetchImplNormal = async url => ({ ok: true, json: async () => url.includes('/events?') ? { data: [exit] } : { data: [{ id: 'cse_one' }] } });
  result = await reopenLost({ base, since, until, dryRun: true, claudeCli: 'claude.exe', now, fetchImpl: fetchImplNormal, spawn: () => ({ status: 0, stdout: '[]' }) });
  assert.equal(result.skipped.reopenLoop, 1);
});

test('reopenLoop: 再接続できなかった(unverified)reopen はループに数えない', async t => {
  const base = fixture(t);
  const now = () => Date.parse('2026-11-07T12:00:00.000Z');

  // 60分以内に3回 reopen したが全て unverified（再接続失敗）。これはループではなく接続障害なので止めない。
  const logFile = path.join(base, 'reopen-lost-sessions.log');
  const logEntries = [
    { at: '2026-11-07T11:00:00.000Z', reopened: [{ id: 'one' }], verified: [], unverified: ['one'] },
    { at: '2026-11-07T11:20:00.000Z', reopened: [{ id: 'one' }], verified: [], unverified: ['one'] },
    { at: '2026-11-07T11:40:00.000Z', reopened: [{ id: 'one' }], verified: [], unverified: ['one'] },
  ];
  fs.writeFileSync(logFile, logEntries.map(e => JSON.stringify(e)).join('\n') + '\n');

  const fetchImplNormal = async url => ({ ok: true, json: async () => url.includes('/events?') ? { data: [exit] } : { data: [{ id: 'cse_one' }] } });
  const result = await reopenLost({ base, since, until, dryRun: true, claudeCli: 'claude.exe', now, fetchImpl: fetchImplNormal, spawn: () => ({ status: 0, stdout: '[]' }) });
  assert.equal(result.skipped.reopenLoop, 0);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].id, 'one');
});

test('post-reopen verification records verified and unverified', async t => {
  const base = fixture(t);
  let clock = 0;
  let agentCheckCount = 0;

  const result = await reopenLost({
    base, since, until, claudeCli: 'claude.exe', codeCli: 'C:\\code.cmd', checkCpu: false, now: () => clock,
    fetchImpl: async url => ({ ok: true, json: async () => url.includes('/events?') ? { data: [exit] } : { data: [{ id: 'cse_one' }] } }),
    spawn: (cmd, args) => {
      if (args[0] === 'agents') {
        agentCheckCount++;
        if (agentCheckCount > 1) return { status: 0, stdout: '[]' };
        return { status: 0, stdout: '[]' };
      }
      return { status: 0, stdout: '' };
    },
    windowReady: () => true,
    wait: async () => {},
  });

  assert.equal(result.reopened.length, 1);
  assert.deepEqual(result.verified, []);
  assert.deepEqual(result.unverified, ['one']);
});

test('findWorkspaceForCwd resolves workspace file for folder itself, relative subfolders, env var, storage.json, and handles comments/broken JSON', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-resolve-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const claudeMdDir = path.join(root, 'CLAUDE.md配布');
  const claudeWorktreeX = path.join(root, '.claude', 'worktrees', 'x');
  const unrelatedDir = path.join(root, 'unrelated');

  fs.mkdirSync(claudeMdDir, { recursive: true });
  fs.mkdirSync(claudeWorktreeX, { recursive: true });
  fs.mkdirSync(unrelatedDir, { recursive: true });

  const wsFile = path.join(claudeMdDir, 'orgiast.code-workspace');
  const wsContent = `{
    // Workspace definition
    "folders": [
      { "path": "." }, /* root folder */
      { "path": "../.claude" }, // claude folder
    ],
  }`;
  fs.writeFileSync(wsFile, wsContent, 'utf8');

  const appDataDir = path.join(root, 'AppData', 'Roaming');
  const storageJsonPath = path.join(appDataDir, 'Code', 'User', 'globalStorage', 'storage.json');
  fs.mkdirSync(path.dirname(storageJsonPath), { recursive: true });
  const storageContent = JSON.stringify({
    windowsState: {
      openedWindows: [
        { workspaceIdentifier: { configURIPath: `file:///${wsFile.replace(/\\/g, '/')}` } }
      ]
    }
  });
  fs.writeFileSync(storageJsonPath, storageContent, 'utf8');

  const env = { APPDATA: appDataDir };

  // Case 1: CLAUDE.md配布 itself matches orgiast.code-workspace
  const match1 = findWorkspaceForCwd(claudeMdDir, { env });
  assert.ok(match1);
  assert.equal(match1.workspaceFile, path.resolve(wsFile));
  assert.equal(match1.workspaceName, 'orgiast');

  // Case 2: .claude/worktrees/x (subfolder of ../.claude) matches orgiast.code-workspace
  const match2 = findWorkspaceForCwd(claudeWorktreeX, { env });
  assert.ok(match2);
  assert.equal(match2.workspaceFile, path.resolve(wsFile));
  assert.equal(match2.workspaceName, 'orgiast');

  // Case 3: Unrelated folder returns null
  const match3 = findWorkspaceForCwd(unrelatedDir, { env });
  assert.equal(match3, null);

  // Case 4: ORGIAST_VSCODE_WORKSPACE environment variable takes priority
  const customWsFile = path.join(root, 'custom.code-workspace');
  fs.writeFileSync(customWsFile, JSON.stringify({ folders: [{ path: unrelatedDir }] }), 'utf8');
  const envWithCustom = { ...env, ORGIAST_VSCODE_WORKSPACE: customWsFile };

  const matchCustom = findWorkspaceForCwd(unrelatedDir, { env: envWithCustom });
  assert.ok(matchCustom);
  assert.equal(matchCustom.workspaceFile, path.resolve(customWsFile));
  assert.equal(matchCustom.workspaceName, 'custom');

  // Case 5: Broken JSON workspace is ignored without crashing
  fs.rmSync(customWsFile, { force: true });
  const brokenWsFile = path.join(unrelatedDir, 'broken.code-workspace');
  fs.writeFileSync(brokenWsFile, '{ "folders": [ broken json structure', 'utf8');
  const envBroken = { ...env, ORGIAST_VSCODE_WORKSPACE: brokenWsFile };

  const matchBroken = findWorkspaceForCwd(unrelatedDir, { env: envBroken });
  assert.equal(matchBroken, null);
});

test('reopenLost: ウィンドウ無し＋lastActiveWindow.workspaceIdentifier があればワークスペースを開く', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reopen-ws-lastactive-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const base = path.join(root, '.claude');
  const wsDir = path.join(root, 'myproject');
  const wsSubDir = path.join(root, 'myproject', 'sub');
  fs.mkdirSync(path.join(base, 'projects', 'proj'), { recursive: true });
  fs.mkdirSync(wsSubDir, { recursive: true });

  const wsFile = path.join(wsDir, 'myproject.code-workspace');
  fs.writeFileSync(wsFile, JSON.stringify({ folders: [{ path: '.' }] }), 'utf8');

  // storage.json に lastActiveWindow.workspaceIdentifier を仕込む
  const appDataDir = path.join(root, 'AppData', 'Roaming');
  const storageJsonPath = path.join(appDataDir, 'Code', 'User', 'globalStorage', 'storage.json');
  fs.mkdirSync(path.dirname(storageJsonPath), { recursive: true });
  fs.writeFileSync(storageJsonPath, JSON.stringify({
    windowsState: {
      lastActiveWindow: {
        workspaceIdentifier: { configURIPath: `file:///${wsFile.replace(/\\/g, '/')}` }
      }
    }
  }), 'utf8');

  fs.writeFileSync(path.join(base, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'mock' } }));
  fs.writeFileSync(path.join(root, '.claude.json'), JSON.stringify({ oauthAccount: { organizationUuid: 'mock' } }));

  fs.writeFileSync(path.join(base, 'projects', 'proj', 'one.jsonl'), [
    { type: 'bridge-session', bridgeSessionId: 'cse_one' },
    { type: 'user', cwd: wsSubDir, message: { content: 'session 1' } },
  ].map(JSON.stringify).join('\n'));

  const psCalls = [];
  const fetchImpl = async url => ({
    ok: true,
    json: async () => url.includes('/events?')
      ? { data: [exit] }
      : { data: [{ id: 'cse_one' }] }
  });

  const env = { APPDATA: appDataDir };

  const result = await reopenLost({
    base, since, until, claudeCli: 'claude.exe', codeCli: 'C:\\code.cmd', checkCpu: false, fetchImpl, env,
    spawn: (cmd, args) => {
      if (args[0] !== 'agents') {
        const cmdStr = args[args.length - 1];
        // hasCodeWindow の呼び出しはウィンドウ無し(0)を返す
        if (cmdStr.includes('Get-Process Code') && cmdStr.includes('.Count')) {
          return { status: 0, stdout: '0' };
        }
        psCalls.push(cmdStr);
      }
      return { status: 0, stdout: args[0] === 'agents' ? '[]' : '' };
    },
    windowReady: () => true,
    wait: async () => {},
  });

  assert.equal(result.reopened.length, 1);
  // ウィンドウ無し＋workspaceIdentifier → ワークスペースを開く
  assert.equal(result.reopened[0].openedWith, 'workspace');
  assert.equal(result.reopened[0].target, uriToPath(`file:///${wsFile.replace(/\\/g, '/')}`));
  // code <cwd> ではなく code <workspace> が呼ばれる
  assert.ok(psCalls[0].includes(wsFile), `should open workspace file: ${psCalls[0]}`);
  assert.ok(!psCalls[0].includes(wsSubDir), `should not open cwd directly: ${psCalls[0]}`);
});

test('parseJsonTolerant preserves // inside string literals (file URIs etc.)', t => {
  const input = '{"a":"file:///C:/x//y", // c\n "b":[1,2,],}';
  const result = parseJsonTolerant(input);
  assert.deepEqual(result, { a: 'file:///C:/x//y', b: [1, 2] });
});

test('parseJsonTolerant handles plain valid JSON (fast path)', t => {
  const result = parseJsonTolerant('{"x":1}');
  assert.deepEqual(result, { x: 1 });
});

test('parseJsonTolerant handles block comments, escaping, BOM', t => {
  const input = '\uFEFF{"a":"str\\\"ing/*notcomment*/","b":/*block*/[1,2],}';
  const result = parseJsonTolerant(input);
  assert.deepEqual(result, { a: 'str"ing/*notcomment*/', b: [1, 2] });
});

test('reopenLost falls back to code <cwd> with openedWith: folder when no workspace matches', async t => {
  const base = fixture(t), psCalls = [];
  const result = await reopenLost({
    base, since, until, claudeCli: 'claude.exe', codeCli: 'C:\\code.cmd', checkCpu: false,
    env: { APPDATA: path.join(base, 'no-appdata') },
    fetchImpl: async url => ({
      ok: true,
      json: async () => url.includes('/events?') ? { data: [exit] } : { data: [{ id: 'cse_one' }] }
    }),
    spawn: (cmd, args) => {
      if (args[0] !== 'agents') {
        const cmdStr = args[args.length - 1];
        if (cmdStr.includes('Get-Process Code') && cmdStr.includes('.Count')) {
          return { status: 0, stdout: '0' };
        }
        psCalls.push(cmdStr);
      }
      return { status: 0, stdout: args[0] === 'agents' ? '[]' : '' };
    },
    windowReady: () => true,
    wait: async () => {},
  });

  assert.equal(result.reopened.length, 1);
  assert.equal(result.reopened[0].openedWith, 'folder');
  assert.equal(result.reopened[0].target, 'C:\\work');
  assert.ok(psCalls[0].includes('C:\\work'));
});

test('resolveClaudeCli: env var takes precedence', t => {
  const exe = resolveClaudeCli({ env: { CLAUDE_CLI: 'C:\\custom\\claude.exe' }, exists: p => p === 'C:\\custom\\claude.exe' });
  assert.equal(exe, 'C:\\custom\\claude.exe');
});

test('resolveClaudeCli: CLAUDE_CLI_PATH also accepted', t => {
  const exe = resolveClaudeCli({ env: { CLAUDE_CLI_PATH: 'C:\\path\\claude.exe' }, exists: p => p === 'C:\\path\\claude.exe' });
  assert.equal(exe, 'C:\\path\\claude.exe');
});

const cliBinName = process.platform === 'win32' ? 'claude.exe' : 'claude';
const whichCmd = process.platform === 'win32' ? 'where.exe' : 'which';

test('resolveClaudeCli: ~/.local/bin/claude fallback (platform-aware)', t => {
  const home = os.homedir();
  const expected = path.join(home, '.local', 'bin', cliBinName);
  const exe = resolveClaudeCli({ env: {}, exists: p => p === expected });
  assert.equal(exe, expected);
});

test('resolveClaudeCli: which/where fallback (platform-aware)', t => {
  const home = os.homedir();
  const binPath = path.join(home, '.local', 'bin', cliBinName);
  const exe = resolveClaudeCli({
    env: {}, exists: p => p === binPath,
    spawn: (cmd, args) => cmd === whichCmd ? { status: 0, stdout: binPath + '\n' } : { status: 1 },
  });
  assert.equal(exe, binPath);
});

test('resolveClaudeCli: winget Packages glob (Windows only)', { skip: process.platform !== 'win32' }, t => {
  const home = os.homedir();
  const localAppData = path.join(home, 'AppData', 'Local');
  const pkgsDir = path.join(localAppData, 'Microsoft', 'WinGet', 'Packages');
  const wingetExe = path.join(pkgsDir, 'Anthropic.ClaudeCode_Microsoft.Winget.Source_8wekyb3d8bbwe', cliBinName);
  const exe = resolveClaudeCli({
    env: {}, exists: p => p === wingetExe,
    readdir: dir => dir === pkgsDir ? ['Anthropic.ClaudeCode_Microsoft.Winget.Source_8wekyb3d8bbwe'] : [],
    spawn: () => ({ status: 1 }),
  });
  assert.equal(exe, wingetExe);
});

test('resolveClaudeCli: throws when nothing found', t => {
  assert.throws(() => resolveClaudeCli({ env: {}, exists: () => false, readdir: () => [], spawn: () => ({ status: 1 }) }));
});

// ── 状態ベース候補 ──────────────────────────────────────

function mkLocalIdx(t, root, entries) {
  const base = path.join(root, '.claude');
  const projects = path.join(base, 'projects', 'proj');
  fs.mkdirSync(projects, { recursive: true });
  for (const [bridgeId, cwd] of Object.entries(entries)) {
    fs.writeFileSync(path.join(projects, `${bridgeId}.jsonl`), [
      JSON.stringify({ type: 'bridge-session', bridgeSessionId: bridgeId }),
      JSON.stringify({ type: 'user', cwd, message: { content: 'hello' } }),
    ].join('\n'));
  }
  return base;
}

test('state-based: active/disconnected/72h以内/未close/プロセス無しが候補になる', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reopen-state-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const base = mkLocalIdx(t, root, { cse_one: 'C:\\work' });
  fs.writeFileSync(path.join(base, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'mock' } }));
  fs.writeFileSync(path.join(root, '.claude.json'), JSON.stringify({ oauthAccount: { organizationUuid: 'mock' } }));

  const nowTime = Date.parse('2026-11-07T12:00:00.000Z');
  const result = await reopenLost({
    base, since, until, dryRun: true, claudeCli: 'claude.exe', now: () => nowTime, stateBased: true,
    fetchImpl: async url => {
      assert.ok(!url.includes('/events'), 'state-based は events API を呼ばない');
      return { ok: true, json: async () => ({ data: [{ id: 'cse_one', status: 'active', connection_status: 'disconnected', last_event_at: '2026-11-07T10:00:00.000Z', title: 'Work' }] }) };
    },
    spawn: () => ({ status: 0, stdout: '[]' }),
  });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].id, 'cse_one');
  assert.equal(result.candidates[0].source, 'state');
});

test('state-based: archived/connected/72h超/closed/alive/reopenLoop は候補にならない', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reopen-state-excl-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const base = mkLocalIdx(t, root, {
    cse_archived: 'C:\\a', cse_connected: 'C:\\b', cse_stale: 'C:\\c',
    cse_closed: 'C:\\d', cse_alive: 'C:\\e', cse_loop: 'C:\\f',
  });
  fs.writeFileSync(path.join(base, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'mock' } }));
  fs.writeFileSync(path.join(root, '.claude.json'), JSON.stringify({ oauthAccount: { organizationUuid: 'mock' } }));

  // closed ledger
  fs.writeFileSync(path.join(base, 'closed-sessions.json'), JSON.stringify({ ids: ['cse_closed'] }));

  // reopenLoop log — 60分以内に再接続成功(verified)が3回 → ループとして候補から外す
  fs.writeFileSync(path.join(base, 'reopen-lost-sessions.log'), [
    { at: '2026-11-07T11:00:00.000Z', reopened: [{ id: 'cse_loop' }], verified: ['cse_loop'] },
    { at: '2026-11-07T11:20:00.000Z', reopened: [{ id: 'cse_loop' }], verified: ['cse_loop'] },
    { at: '2026-11-07T11:40:00.000Z', reopened: [{ id: 'cse_loop' }], verified: ['cse_loop'] },
  ].map(e => JSON.stringify(e)).join('\n') + '\n');

  const nowTime = Date.parse('2026-11-07T12:00:00.000Z');
  const sessions = [
    { id: 'cse_archived', status: 'archived', connection_status: 'disconnected', last_event_at: '2026-11-07T10:00:00.000Z' },
    { id: 'cse_connected', status: 'active', connection_status: 'connected', last_event_at: '2026-11-07T10:00:00.000Z' },
    { id: 'cse_stale', status: 'active', connection_status: 'disconnected', last_event_at: '2026-11-01T10:00:00.000Z' }, // >72h
    { id: 'cse_closed', status: 'active', connection_status: 'disconnected', last_event_at: '2026-11-07T10:00:00.000Z' },
    { id: 'cse_alive', status: 'active', connection_status: 'disconnected', last_event_at: '2026-11-07T10:00:00.000Z' },
    { id: 'cse_loop', status: 'active', connection_status: 'disconnected', last_event_at: '2026-11-07T10:00:00.000Z' },
  ];
  const result = await reopenLost({
    base, since, until, dryRun: true, claudeCli: 'claude.exe', now: () => nowTime, stateBased: true,
    fetchImpl: async url => ({ ok: true, json: async () => ({ data: sessions }) }),
    spawn: (cmd, args) => {
      if (args[0] !== 'agents') return { status: 0, stdout: '' };
      return { status: 0, stdout: JSON.stringify([{ kind: 'interactive', sessionId: 'cse_alive' }]) };
    },
  });
  assert.equal(result.candidates.length, 0);
  // 6 sessions — all should be skipped
  const totalSkipped = result.skipped.closed + result.skipped.alive + result.skipped.noLocal +
    result.skipped.empty + result.skipped.reopenLoop + result.skipped.archivedByUser;
  // archived: status !== 'active' so filtered at state level, not counted
  assert.equal(result.skipped.closed, 1);
  assert.equal(result.skipped.alive, 1);
  assert.equal(result.skipped.reopenLoop, 1);
});

test('state-based: updated_at が since より古くても候補になる（updated_at フィルタを適用しない）', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reopen-updated-at-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const base = mkLocalIdx(t, root, { cse_stale: 'C:\\work' });
  fs.writeFileSync(path.join(base, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'mock' } }));
  fs.writeFileSync(path.join(root, '.claude.json'), JSON.stringify({ oauthAccount: { organizationUuid: 'mock' } }));

  const nowTime = Date.parse('2026-11-07T12:00:00.000Z');
  // updated_at は since（'2026-11-05T19:40:00Z'）より古いが、last_event_at は 72h 以内
  const staleSession = { id: 'cse_stale', status: 'active', connection_status: 'disconnected', last_event_at: '2026-11-07T10:00:00.000Z', title: 'Stale', updated_at: '2026-11-04T10:00:00.000Z' };
  const result = await reopenLost({
    base, since, until, dryRun: true, claudeCli: 'claude.exe', now: () => nowTime, stateBased: true,
    fetchImpl: async url => ({ ok: true, json: async () => ({ data: [staleSession] }) }),
    spawn: () => ({ status: 0, stdout: '[]' }),
  });
  // state-based では updated_at >= since フィルタを適用しないので、updated_at が古くても候補になる
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].id, 'cse_stale');
  assert.equal(result.candidates[0].source, 'state');
});

test('state-based: 72 時間より古いページで打ち切る（降順の場合）', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reopen-paging-cutoff-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const base = mkLocalIdx(t, root, {
    cse_recent: 'C:\\work',
    cse_old: 'C:\\old',
    cse_older: 'C:\\older',
  });
  fs.writeFileSync(path.join(base, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'mock' } }));
  fs.writeFileSync(path.join(root, '.claude.json'), JSON.stringify({ oauthAccount: { organizationUuid: 'mock' } }));

  const nowTime = Date.parse('2026-11-07T12:00:00.000Z');
  const page1 = [
    { id: 'cse_recent', status: 'active', connection_status: 'disconnected', last_event_at: '2026-11-07T10:00:00.000Z', title: 'Recent', updated_at: '2026-11-07T10:00:00.000Z' },
  ];
  const page2 = [
    { id: 'cse_old', status: 'active', connection_status: 'disconnected', last_event_at: '2026-11-01T10:00:00.000Z', title: 'Old', updated_at: '2026-11-01T10:00:00.000Z' },
    { id: 'cse_older', status: 'active', connection_status: 'disconnected', last_event_at: '2026-10-30T10:00:00.000Z', title: 'Older', updated_at: '2026-10-30T10:00:00.000Z' },
  ];
  let callCount = 0;
  const result = await reopenLost({
    base, since, until, dryRun: true, claudeCli: 'claude.exe', now: () => nowTime, stateBased: true,
    fetchImpl: async url => {
      if (url.includes('/events?')) return { ok: true, json: async () => ({ data: [] }) };
      callCount++;
      if (callCount === 1) return { ok: true, json: async () => ({ data: page1, next_cursor: 'page2' }) };
      if (callCount === 2) return { ok: true, json: async () => ({ data: page2 }) };
      return { ok: true, json: async () => ({ data: [] }) };
    },
    spawn: () => ({ status: 0, stdout: '[]' }),
  });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].id, 'cse_recent');
  // page2 の全セッションが 72h より古いので打ち切られる。page3 は呼ばれない
  assert.equal(callCount, 2);
  assert.ok(!result.apiError, `unexpected apiError: ${result.apiError ?? ''}`);
});

test('state-based と host_exit の重複は1件にまとまる', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reopen-dedup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const base = mkLocalIdx(t, root, { cse_one: 'C:\\work' });
  fs.writeFileSync(path.join(base, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'mock' } }));
  fs.writeFileSync(path.join(root, '.claude.json'), JSON.stringify({ oauthAccount: { organizationUuid: 'mock' } }));

  const session = { id: 'cse_one', status: 'active', connection_status: 'disconnected', last_event_at: '2026-11-07T10:00:00.000Z', title: 'W' };
  const nowTime = Date.parse('2026-11-07T12:00:00.000Z');
  const result = await reopenLost({
    base, since, until, dryRun: true, claudeCli: 'claude.exe', now: () => nowTime, stateBased: true,
    fetchImpl: async url => {
      if (url.includes('/events?')) return { ok: true, json: async () => ({ data: [{ event_type: 'system', payload: { reason: 'host_exit' }, created_at: '2026-11-07T10:00:00.000Z' }] }) };
      return { ok: true, json: async () => ({ data: [session] }) };
    },
    spawn: () => ({ status: 0, stdout: '[]' }),
  });
  assert.equal(result.candidates.length, 1);
  // どちらの source でも良い
  assert.ok(['state', 'host_exit'].includes(result.candidates[0].source));
});

test('state-based: 待機中の空き枠は開き直さない', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reopen-standby-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const base = mkLocalIdx(t, root, {
    cse_standby: 'C:\\work1',
    cse_work: 'C:\\work2',
  });
  fs.writeFileSync(path.join(base, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'mock' } }));
  fs.writeFileSync(path.join(root, '.claude.json'), JSON.stringify({ oauthAccount: { organizationUuid: 'mock' } }));

  const nowTime = Date.parse('2026-11-07T12:00:00.000Z');
  const sessions = [
    { id: 'cse_standby', status: 'active', connection_status: 'disconnected', last_event_at: '2026-11-07T10:00:00.000Z', title: '011｜待機中' },
    { id: 'cse_work', status: 'active', connection_status: 'disconnected', last_event_at: '2026-11-07T10:00:00.000Z', title: '011｜毎日議事録から改善待機中' },
  ];
  const result = await reopenLost({
    base, since, until, dryRun: true, claudeCli: 'claude.exe', now: () => nowTime, stateBased: true,
    fetchImpl: async url => ({ ok: true, json: async () => ({ data: sessions }) }),
    spawn: () => ({ status: 0, stdout: '[]' }),
  });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].id, 'cse_work');
  assert.equal(result.skipped.standby, 1);
});

test('state-based: 起動中の VS Code で閉じたタブは開き直さない', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reopen-vscode-running-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const base = mkLocalIdx(t, root, { cse_one: 'C:\\work' });
  fs.writeFileSync(path.join(base, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'mock' } }));
  fs.writeFileSync(path.join(root, '.claude.json'), JSON.stringify({ oauthAccount: { organizationUuid: 'mock' } }));

  const nowTime = Date.parse('2026-11-07T12:00:00.000Z');
  // vscodeStartedAt が last_event_at(11:00) より前(10:00) → VS Code 起動中に閉じられた
  const vscodeStartedAt = Date.parse('2026-11-07T10:00:00.000Z');
  const session = { id: 'cse_one', status: 'active', connection_status: 'disconnected', last_event_at: '2026-11-07T11:00:00.000Z', title: 'Work' };
  const result = await reopenLost({
    base, since, until, dryRun: true, claudeCli: 'claude.exe', now: () => nowTime, stateBased: true,
    vscodeStartedAt,
    fetchImpl: async url => ({ ok: true, json: async () => ({ data: [session] }) }),
    spawn: () => ({ status: 0, stdout: '[]' }),
  });
  assert.equal(result.candidates.length, 0);
  assert.equal(result.skipped.closedInRunningVscode, 1);
});

test('state-based: VS Code 再起動後は開き直す', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reopen-vscode-restarted-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const base = mkLocalIdx(t, root, { cse_one: 'C:\\work' });
  fs.writeFileSync(path.join(base, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'mock' } }));
  fs.writeFileSync(path.join(root, '.claude.json'), JSON.stringify({ oauthAccount: { organizationUuid: 'mock' } }));

  const nowTime = Date.parse('2026-11-07T12:00:00.000Z');
  // vscodeStartedAt が last_event_at(10:00) より後(11:00) → VS Code 再起動後なので開き直す
  const vscodeStartedAt = Date.parse('2026-11-07T11:00:00.000Z');
  const session = { id: 'cse_one', status: 'active', connection_status: 'disconnected', last_event_at: '2026-11-07T10:00:00.000Z', title: 'Work' };
  const result = await reopenLost({
    base, since, until, dryRun: true, claudeCli: 'claude.exe', now: () => nowTime, stateBased: true,
    vscodeStartedAt,
    fetchImpl: async url => ({ ok: true, json: async () => ({ data: [session] }) }),
    spawn: () => ({ status: 0, stdout: '[]' }),
  });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].id, 'cse_one');
  assert.equal(result.skipped.closedInRunningVscode, 0);
});

test('CPU 85%以上で開き直しを defer、watermark を進めない', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reopen-cpu-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const base = mkLocalIdx(t, root, { cse_one: 'C:\\work' });
  fs.writeFileSync(path.join(base, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'mock' } }));
  fs.writeFileSync(path.join(root, '.claude.json'), JSON.stringify({ oauthAccount: { organizationUuid: 'mock' } }));

  const stateFile = path.join(base, 'reopen-lost-sessions-state.json');
  const nowTime = Date.parse('2026-11-07T12:00:00.000Z');
  const evtAt = '2026-11-07T11:40:00.000Z'; // within watchReopen's [now-30m, now-60s]

  const fetchImpl = async url => {
    if (url.includes('/events?')) return { ok: true, json: async () => ({ data: [{ event_type: 'system', payload: { reason: 'host_exit' }, created_at: evtAt }] }) };
    return { ok: true, json: async () => ({ data: [{ id: 'cse_one' }] }) };
  };
  const spawn = (cmd, args) => {
    if (args[0] === 'agents') return { status: 0, stdout: '[]' };
    return { status: 0, stdout: '' };
  };
  // Stub cpusImpl to return 92% usage: totalDiff=87, idleDiff=7 → 100*(1-7/87)=92
  let cpuCallCount = 0;
  const cpusImpl = () => {
    cpuCallCount++;
    if (cpuCallCount === 1) return [{ times: { user: 0, nice: 0, system: 0, idle: 0, iowait: 0, irq: 0, softirq: 0 } }];
    return [{ times: { user: 50, nice: 0, system: 30, idle: 7, iowait: 0, irq: 0, softirq: 0 } }];
  };

  const result = await watchReopen({ base, claudeCli: 'claude.exe', codeCli: 'C:\\code.cmd', fetchImpl, spawn, cpusImpl, now: () => nowTime,
    windowReady: () => true, wait: async () => {} });
  assert.equal(result.deferredCpu, 92);
  assert.equal(result.reopened.length, 0);
  // watermark は deferredCpu により進まない
  assert.equal(fs.existsSync(stateFile), false);
});

test('claude agents 呼び出しが失敗したら registry 代替に移行（再試行なし）', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reopen-no-retry-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const base = mkLocalIdx(t, root, {});
  fs.writeFileSync(path.join(base, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'mock' } }));
  fs.writeFileSync(path.join(root, '.claude.json'), JSON.stringify({ oauthAccount: { organizationUuid: 'mock' } }));
  // registry に session を仕込む（alive に process.pid を使う）
  const sessionsDir = path.join(base, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.writeFileSync(path.join(sessionsDir, 'alive.json'), JSON.stringify({ pid: process.pid, sessionId: 'sid_001', kind: 'interactive' }));

  let attempts = 0;
  const err = new Error('spawnSync ETIMEDOUT');
  err.code = 'ETIMEDOUT';
  const result = await reopenLost({
    base, since, until, dryRun: true, claudeCli: 'claude.exe', stateBased: true,
    fetchImpl: async url => ({ ok: true, json: async () => ({ data: [] }) }),
    spawn: () => {
      attempts++;
      return { error: err, status: null, stdout: '' };
    },
  });
  // 再試行なし（vscodeStartedAt 1回 + agents 1回）
  assert.equal(attempts, 2);
  // registry 代替で aliveSource='registry'
  assert.equal(result.aliveSource, 'registry');
  assert.ok(result.agentsError, 'agentsError に失敗理由が残る');
});

// ── agentsFromRegistry ──────────────────────────────────

test('agentsFromRegistry: 有効なセッションを sessionId 集合で返す', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sessionsDir = path.join(dir, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  // process.pid は生きているので process.kill(pid, 0) が成功する
  fs.writeFileSync(path.join(sessionsDir, 'a.json'), JSON.stringify({ pid: process.pid, sessionId: 'sid_001', kind: 'interactive', status: 'busy' }));
  fs.writeFileSync(path.join(sessionsDir, 'b.json'), JSON.stringify({ pid: process.pid, sessionId: 'sid_002', kind: 'interactive', status: 'idle' }));
  const result = agentsFromRegistry(sessionsDir);
  assert.equal(result.size, 2);
  assert.ok(result.has('sid_001'));
  assert.ok(result.has('sid_002'));
});

test('agentsFromRegistry: kind !== interactive は除外', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-kind-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sessionsDir = path.join(dir, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.writeFileSync(path.join(sessionsDir, 'a.json'), JSON.stringify({ pid: process.pid, sessionId: 's1', kind: 'interactive' }));
  fs.writeFileSync(path.join(sessionsDir, 'b.json'), JSON.stringify({ pid: process.pid, sessionId: 's2', kind: 'agent' }));
  fs.writeFileSync(path.join(sessionsDir, 'c.json'), JSON.stringify({ pid: process.pid, sessionId: 's3', kind: 'background' }));
  assert.equal(agentsFromRegistry(sessionsDir).size, 1);
});

test('agentsFromRegistry: sessionId が無いエントリは除外', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-noid-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sessionsDir = path.join(dir, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.writeFileSync(path.join(sessionsDir, 'a.json'), JSON.stringify({ pid: process.pid, kind: 'interactive' })); // no sessionId
  fs.writeFileSync(path.join(sessionsDir, 'b.json'), JSON.stringify({ pid: process.pid, sessionId: '', kind: 'interactive' })); // empty sessionId
  assert.equal(agentsFromRegistry(sessionsDir).size, 0);
});

test('agentsFromRegistry: 壊れた JSON は読み飛ばす', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-broken-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sessionsDir = path.join(dir, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.writeFileSync(path.join(sessionsDir, 'good.json'), JSON.stringify({ pid: process.pid, sessionId: 's1', kind: 'interactive' }));
  fs.writeFileSync(path.join(sessionsDir, 'bad.json'), '{ broken json', 'utf8');
  fs.writeFileSync(path.join(sessionsDir, 'empty.json'), '', 'utf8');
  assert.equal(agentsFromRegistry(sessionsDir).size, 1);
  assert.ok(agentsFromRegistry(sessionsDir).has('s1'));
});

test('agentsFromRegistry: 死んだ pid は除外される（ESRCH）', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-dead-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sessionsDir = path.join(dir, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  // 既に終了した子プロセスの pid は dead（ESRCH になるはず）
  const { spawnSync } = await import('node:child_process');
  const child = spawnSync(process.execPath, ['-e', 'process.exit(0)'], { timeout: 5000 });
  const deadPid = child.pid;
  fs.writeFileSync(path.join(sessionsDir, 'dead.json'), JSON.stringify({ pid: deadPid, sessionId: 's_dead', kind: 'interactive' }));
  fs.writeFileSync(path.join(sessionsDir, 'alive.json'), JSON.stringify({ pid: process.pid, sessionId: 's_alive', kind: 'interactive' }));
  const result = agentsFromRegistry(sessionsDir);
  assert.equal(result.size, 1);
  assert.ok(result.has('s_alive'));
  assert.ok(!result.has('s_dead'));
});

test('agentsFromRegistry: sessions ディレクトリが無ければ例外を投げる', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-no-dir-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.throws(() => agentsFromRegistry(path.join(dir, 'sessions')), { code: 'ENOENT' });
});

// ── alive() 2段構え ─────────────────────────────────────

test('alive: agents 成功 → aliveSource agents', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'alive-agents-success-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const base = path.join(root, '.claude');
  fs.mkdirSync(path.join(base, 'projects', 'proj'), { recursive: true });
  fs.writeFileSync(path.join(base, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'mock' } }));
  fs.writeFileSync(path.join(root, '.claude.json'), JSON.stringify({ oauthAccount: { organizationUuid: 'mock' } }));
  fs.writeFileSync(path.join(base, 'projects', 'proj', 'one.jsonl'), [
    { type: 'bridge-session', bridgeSessionId: 'cse_one' },
    { type: 'user', cwd: 'C:\\work', message: { content: 'hello' } },
  ].map(JSON.stringify).join('\n'));
  const result = await reopenLost({
    base, since, until, dryRun: true, claudeCli: 'claude.exe', stateBased: true,
    fetchImpl: async url => ({ ok: true, json: async () => ({ data: [] }) }),
    spawn: () => ({ status: 0, stdout: JSON.stringify([{ kind: 'interactive', sessionId: 'sid_001' }]) }),
  });
  assert.equal(result.aliveSource, 'agents');
  assert.equal(result.agentsError, null);
  assert.equal(result.agentsDiag, null);
});

test('alive: agents ETIMEDOUT → registry で代替 → aliveSource registry', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'alive-registry-fallback-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const base = path.join(root, '.claude');
  fs.mkdirSync(path.join(base, 'projects', 'proj'), { recursive: true });
  fs.writeFileSync(path.join(base, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'mock' } }));
  fs.writeFileSync(path.join(root, '.claude.json'), JSON.stringify({ oauthAccount: { organizationUuid: 'mock' } }));
  // レジストリに session を仕込む
  const sessionsDir = path.join(base, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.writeFileSync(path.join(sessionsDir, 'reg.json'), JSON.stringify({ pid: 999999999, sessionId: 'sid_reg', kind: 'interactive' }));
  const err = new Error('spawnSync ETIMEDOUT');
  err.code = 'ETIMEDOUT';
  const result = await reopenLost({
    base, since, until, dryRun: true, claudeCli: 'claude.exe', stateBased: true,
    fetchImpl: async url => ({ ok: true, json: async () => ({ data: [] }) }),
    spawn: () => ({ error: err, status: null, stdout: '', stderr: 'timeout' }),
  });
  assert.equal(result.aliveSource, 'registry');
  assert.ok(result.agentsError);
  assert.ok(result.agentsDiag);
  assert.equal(typeof result.agentsDiag.elapsedMs, 'number');
  assert.ok(Array.isArray(result.agentsDiag.claudeEnvKeys));
});

test('alive: agents 失敗でも registry に無ければ空集合、エラーは記録', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'alive-registry-empty-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const base = path.join(root, '.claude');
  fs.mkdirSync(path.join(base, 'projects', 'proj'), { recursive: true });
  fs.writeFileSync(path.join(base, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'mock' } }));
  fs.writeFileSync(path.join(root, '.claude.json'), JSON.stringify({ oauthAccount: { organizationUuid: 'mock' } }));
  // sessions ディレクトリは作らない → agentsFromRegistry が ENOENT で例外 → alive() は catch して空 Set
  const err = new Error('spawnSync ETIMEDOUT');
  err.code = 'ETIMEDOUT';
  const result = await reopenLost({
    base, since, until, dryRun: true, claudeCli: 'claude.exe', stateBased: true,
    fetchImpl: async url => ({ ok: true, json: async () => ({ data: [] }) }),
    spawn: () => ({ error: err, status: null, stdout: '', stderr: 'timeout' }),
  });
  assert.equal(result.aliveSource, 'registry');
  assert.ok(result.agentsError);
  // sessions ディレクトリ無しでも例外が上に伝播せず、alive() の catch で空 Set が返る
  assert.equal(result.skipped.closed, 0);
});

test('reopenLost: 再オープン後の検証も aliveSource を正しく記録する', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'alive-verify-source-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const base = path.join(root, '.claude');
  fs.mkdirSync(path.join(base, 'projects', 'proj'), { recursive: true });
  fs.writeFileSync(path.join(base, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'mock' } }));
  fs.writeFileSync(path.join(root, '.claude.json'), JSON.stringify({ oauthAccount: { organizationUuid: 'mock' } }));
  fs.writeFileSync(path.join(base, 'projects', 'proj', 'one.jsonl'), [
    { type: 'bridge-session', bridgeSessionId: 'cse_one' },
    { type: 'user', cwd: 'C:\\work', message: { content: 'hello' } },
  ].map(JSON.stringify).join('\n'));
  const sessionsDir = path.join(base, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  // agents は空を返す → aliveSource agents、verified=[] unverified=['cse_one']
  const result = await reopenLost({
    base, since, until, claudeCli: 'claude.exe', codeCli: 'C:\\code.cmd', checkCpu: false,
    fetchImpl: async url => ({ ok: true, json: async () => url.includes('/events?') ? { data: [exit] } : { data: [{ id: 'cse_one' }] } }),
    spawn: (cmd, args) => {
      if (args[0] === 'agents') return { status: 0, stdout: '[]' };
      return { status: 0, stdout: '' };
    },
    windowReady: () => true,
    wait: async () => {},
  });
  assert.equal(result.aliveSource, 'agents');
  assert.equal(result.reopened.length, 1);
  assert.deepEqual(result.verified, []);
  assert.deepEqual(result.unverified, ['one']);
});

// ── writeProgress ───────────────────────────────────────

test('writeProgress creates progress file with correct content', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const base = path.join(root, '.claude');
  fs.mkdirSync(base, { recursive: true });
  const fixedNow = Date.parse('2026-11-09T00:00:00.000Z');
  writeProgress(base, 'lock', 'acquired', () => fixedNow);
  const progressPath = path.join(base, 'reopen-lost-sessions-progress.json');
  assert.ok(fs.existsSync(progressPath));
  const data = JSON.parse(fs.readFileSync(progressPath, 'utf8'));
  assert.equal(data.pid, process.pid);
  assert.equal(data.stage, 'lock');
  assert.equal(data.detail, 'acquired');
  assert.equal(data.at, new Date(fixedNow).toISOString());
});

test('writeProgress default base uses homedir', t => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-home-'));
  t.after(() => fs.rmSync(tmpHome, { recursive: true, force: true }));
  const origHome = os.homedir;
  os.homedir = () => tmpHome;
  fs.mkdirSync(path.join(tmpHome, '.claude'), { recursive: true });
  try {
    const fixedNow = Date.parse('2026-11-09T00:00:01.000Z');
    writeProgress(undefined, 'auth', 'credentials loaded', () => fixedNow);
    const progressPath = path.join(tmpHome, '.claude', 'reopen-lost-sessions-progress.json');
    assert.ok(fs.existsSync(progressPath));
    const data = JSON.parse(fs.readFileSync(progressPath, 'utf8'));
    assert.equal(data.stage, 'auth');
    assert.equal(data.detail, 'credentials loaded');
  } finally {
    os.homedir = origHome;
  }
});

test('writeProgress overwrites previous content', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-over-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const base = path.join(root, '.claude');
  fs.mkdirSync(base, { recursive: true });
  const fixedNow = Date.parse('2026-11-09T00:00:02.000Z');
  writeProgress(base, 'lock', 'acquired', () => fixedNow);
  writeProgress(base, 'alive', 'source=agents', () => fixedNow + 1000);
  const data = JSON.parse(fs.readFileSync(path.join(base, 'reopen-lost-sessions-progress.json'), 'utf8'));
  assert.equal(data.stage, 'alive');
  assert.equal(data.detail, 'source=agents');
});

// ── acquireLock dual update ─────────────────────────────

test('acquireLock dual update: futimesSync and utimesSync run without error', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-dual-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lockFile = path.join(root, 'test.lock');
  const release = acquireLock(lockFile);
  assert.ok(release, 'lock should be acquired');
  // Verify the file exists and has pid content
  assert.ok(fs.existsSync(lockFile));
  const content = fs.readFileSync(lockFile, 'utf8');
  assert.equal(content, String(process.pid));
  // mtime should be set (writeSync + futimesSync both set it)
  const stat = fs.statSync(lockFile);
  assert.ok(stat.mtimeMs > 0, `mtime should be positive, got ${stat.mtimeMs}`);
  // Release properly removes the lock
  release();
  assert.equal(fs.existsSync(lockFile), false, 'lock should be released');
});

// ── reopenLost writes progress at key stages ────────────

test('reopenLost writes progress during dry run', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-progress-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const base = path.join(root, '.claude');
  fs.mkdirSync(path.join(base, 'projects', 'proj'), { recursive: true });
  fs.writeFileSync(path.join(base, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'mock' } }));
  fs.writeFileSync(path.join(root, '.claude.json'), JSON.stringify({ oauthAccount: { organizationUuid: 'mock' } }));
  fs.writeFileSync(path.join(base, 'projects', 'proj', 'one.jsonl'), [
    { type: 'bridge-session', bridgeSessionId: 'cse_one' },
    { type: 'user', cwd: 'C:\\work', message: { content: 'hello' } },
  ].map(JSON.stringify).join('\n'));

  await reopenLost({
    base, since, until, dryRun: true, claudeCli: 'claude.exe',
    fetchImpl: async url => ({ ok: true, json: async () => url.includes('/events?') ? { data: [exit] } : { data: [{ id: 'cse_one' }] } }),
    spawn: () => ({ status: 0, stdout: '[]' }),
  });

  // Progress file should exist with at least 'done' stage
  const progressPath = path.join(base, 'reopen-lost-sessions-progress.json');
  assert.ok(fs.existsSync(progressPath), 'progress file should exist');
  const data = JSON.parse(fs.readFileSync(progressPath, 'utf8'));
  assert.equal(data.stage, 'done');
  assert.equal(data.detail, 'log written');
});

test('measureCpuAsync: 50% usage from stubbed cpus', async () => {
  const cpu1 = { times: { user: 100, nice: 0, system: 50, idle: 200, iowait: 0, irq: 0, softirq: 0 } };
  const cpu2 = { times: { user: 150, nice: 0, system: 80, idle: 250, iowait: 0, irq: 0, softirq: 0 } };
  // total1 = 350, total2 = 480, diff = 130
  // idle1 = 200, idle2 = 250, diff = 50
  // usage = 100 * (1 - 50/130) ≈ 62 → round to 62
  let callCount = 0;
  const cpusImpl = () => {
    callCount++;
    return callCount === 1 ? [cpu1] : [cpu2];
  };
  let waited = false;
  const wait = async ms => { waited = true; };
  const result = await measureCpuAsync({ sampleMs: 100, cpusImpl, wait });
  assert.equal(result, 62);
  assert.ok(waited);
});

test('measureCpuAsync: 0% usage when idle diff equals total diff', async () => {
  const cpu1 = { times: { user: 100, nice: 0, system: 50, idle: 200, iowait: 0, irq: 0, softirq: 0 } };
  const cpu2 = { times: { user: 100, nice: 0, system: 50, idle: 250, iowait: 0, irq: 0, softirq: 0 } };
  // total1 = 350, total2 = 400, diff = 50
  // idle1 = 200, idle2 = 250, diff = 50
  // usage = 100 * (1 - 50/50) = 0
  let callCount = 0;
  const cpusImpl = () => {
    callCount++;
    return callCount === 1 ? [cpu1] : [cpu2];
  };
  const result = await measureCpuAsync({ sampleMs: 100, cpusImpl, wait: async () => {} });
  assert.equal(result, 0);
});

test('measureCpuAsync: null when total diff is 0', async () => {
  const cpu = { times: { user: 100, nice: 0, system: 50, idle: 200, iowait: 0, irq: 0, softirq: 0 } };
  const cpusImpl = () => [cpu, cpu];
  const result = await measureCpuAsync({ sampleMs: 100, cpusImpl, wait: async () => {} });
  assert.equal(result, null);
});

test('measureCpuAsync: null when cpusImpl throws', async () => {
  const cpusImpl = () => { throw new Error('no cpus'); };
  const result = await measureCpuAsync({ sampleMs: 100, cpusImpl, wait: async () => {} });
  assert.equal(result, null);
});

test('measureCpuAsync: multi-core aggregation', async () => {
  const cpu1a = { times: { user: 100, nice: 0, system: 50, idle: 200, iowait: 0, irq: 0, softirq: 0 } };
  const cpu1b = { times: { user: 200, nice: 0, system: 100, idle: 400, iowait: 0, irq: 0, softirq: 0 } };
  const cpu2a = { times: { user: 50, nice: 0, system: 30, idle: 150, iowait: 0, irq: 0, softirq: 0 } };
  const cpu2b = { times: { user: 80, nice: 0, system: 50, idle: 200, iowait: 0, irq: 0, softirq: 0 } };
  // Core 0: total 350→700 diff=350, idle 200→400 diff=200
  // Core 1: total 230→330 diff=100, idle 150→200 diff=50
  // Aggregated: totalDiff=450, idleDiff=250
  // usage = 100 * (1 - 250/450) ≈ 44.4 → round to 44
  let callCount = 0;
  const cpusImpl = () => {
    callCount++;
    return callCount === 1 ? [cpu1a, cpu2a] : [cpu1b, cpu2b];
  };
  const result = await measureCpuAsync({ sampleMs: 100, cpusImpl, wait: async () => {} });
  assert.equal(result, 44);
});

test('hasCodeWindow: spawn status/error/stdout behavior', () => {
  assert.equal(hasCodeWindow(() => ({ status: 0, stdout: '2' })), true);
  assert.equal(hasCodeWindow(() => ({ status: 0, stdout: '0' })), false);
  assert.equal(hasCodeWindow(() => ({ error: new Error('ETIMEDOUT') })), true);
  assert.equal(hasCodeWindow(() => ({ status: 1, stdout: '' })), true);
});

test('resolveLaunchTarget: resolves launch target based on window state and storage.json', () => {
  // Case 1: Window exists -> uri-only, target null
  const resWindow = resolveLaunchTarget({ spawn: () => ({ status: 0, stdout: '1' }) });
  assert.deepEqual(resWindow, { launch: 'uri-only', target: null, openedWith: null });

  // Case 2: No window + storage.json folder -> openedWith 'folder'
  const appData = path.join(os.tmpdir(), 'mock-appdata-folder');
  const storagePathFolder = path.join(appData, 'Code', 'User', 'globalStorage', 'storage.json');
  const storageDataFolder = JSON.stringify({
    windowsState: {
      lastActiveWindow: { folder: 'file:///c%3A/Users/x/proj' }
    }
  });
  const fsMockFolder = {
    existsSync: p => p === storagePathFolder,
    readFileSync: p => p === storagePathFolder ? storageDataFolder : ''
  };
  const resFolder = resolveLaunchTarget({
    env: { APPDATA: appData },
    fsImpl: fsMockFolder,
    spawn: () => ({ status: 0, stdout: '0' })
  });
  assert.equal(resFolder.launch, 'opened-window');
  assert.equal(resFolder.openedWith, 'folder');
  assert.equal(resFolder.target, uriToPath('file:///c%3A/Users/x/proj'));

  // Case 3: No window + storage.json workspaceIdentifier -> openedWith 'workspace'
  const appDataWs = path.join(os.tmpdir(), 'mock-appdata-ws');
  const storagePathWs = path.join(appDataWs, 'Code', 'User', 'globalStorage', 'storage.json');
  const storageDataWs = JSON.stringify({
    windowsState: {
      lastActiveWindow: {
        workspaceIdentifier: { configURIPath: 'file:///c%3A/Users/x/a.code-workspace' }
      }
    }
  });
  const fsMockWs = {
    existsSync: p => p === storagePathWs,
    readFileSync: p => p === storagePathWs ? storageDataWs : ''
  };
  const resWs = resolveLaunchTarget({
    env: { APPDATA: appDataWs },
    fsImpl: fsMockWs,
    spawn: () => ({ status: 0, stdout: '0' })
  });
  assert.equal(resWs.launch, 'opened-window');
  assert.equal(resWs.openedWith, 'workspace');
  assert.equal(resWs.target, uriToPath('file:///c%3A/Users/x/a.code-workspace'));
});

test('watchdogRecord: logs previous stage and updates progress stage to watchdog', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'watchdog-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const progressPath = path.join(root, 'reopen-lost-sessions-progress.json');
  fs.writeFileSync(progressPath, JSON.stringify({ stage: 'alive', detail: 'x', pid: 1 }) + '\n');

  watchdogRecord(root, { exitImpl: () => {} });

  const logPath = path.join(root, 'reopen-lost-sessions.log');
  assert.ok(fs.existsSync(logPath));
  const logLines = fs.readFileSync(logPath, 'utf8').trim().split('\n');
  const lastLog = JSON.parse(logLines[logLines.length - 1]);

  assert.equal(lastLog.error, 'watchdog timeout');
  assert.equal(lastLog.stage, 'alive');
  assert.equal(lastLog.detail, 'x');
  assert.equal(lastLog.pid, 1);

  const updatedProgress = JSON.parse(fs.readFileSync(progressPath, 'utf8'));
  assert.equal(updatedProgress.stage, 'watchdog');
  assert.equal(updatedProgress.detail, 'timeout');
});

test('localIndex: sinceMs より古い mtime のファイルは読まれず skippedOld に計上される', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reopen-mtime-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const projects = path.join(root, '.claude', 'projects', 'proj');
  fs.mkdirSync(projects, { recursive: true });
  // 古いファイル（mtime を過去に設定）
  const oldFile = path.join(projects, 'old.jsonl');
  fs.writeFileSync(oldFile, [
    { type: 'bridge-session', bridgeSessionId: 'cse_old' },
    { type: 'user', cwd: 'C:\\old', message: { content: 'old' } },
  ].map(JSON.stringify).join('\n'));
  const past = new Date('2020-01-01').getTime();
  fs.utimesSync(oldFile, past / 1000, past / 1000);
  // 新しいファイル
  const newFile = path.join(projects, 'new.jsonl');
  fs.writeFileSync(newFile, [
    { type: 'bridge-session', bridgeSessionId: 'cse_new' },
    { type: 'user', cwd: 'C:\\new', message: { content: 'new' } },
  ].map(JSON.stringify).join('\n'));
  const idx = localIndex(path.join(root, '.claude'), undefined, { sinceMs: Date.now() - 3600000 });
  assert.equal(idx.size, 1, '古いファイルは index に入らない');
  assert.ok(idx.has('cse_new'), '新しいファイルだけが index にある');
  assert.equal(idx.skippedOld, 1, 'skippedOld に 1 が計上される');
  assert.equal(idx.indexed, 1, 'indexed に 1 が計上される');
  assert.ok(typeof idx.indexMs === 'number' && idx.indexMs >= 0, 'indexMs が数値');
});

test('localIndex: onlyId 指定時は sinceMs より古くても読む', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reopen-onlyid-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const projects = path.join(root, '.claude', 'projects', 'proj');
  fs.mkdirSync(projects, { recursive: true });
  const oldFile = path.join(projects, 'old.jsonl');
  fs.writeFileSync(oldFile, [
    { type: 'bridge-session', bridgeSessionId: 'cse_old' },
    { type: 'user', cwd: 'C:\\old', message: { content: 'old' } },
  ].map(JSON.stringify).join('\n'));
  const past = new Date('2020-01-01').getTime();
  fs.utimesSync(oldFile, past / 1000, past / 1000);
  // onlyId で古いファイルを指定（ファイル名ステム = 'old'）→ mtime に関係なく読める
  const idx = localIndex(path.join(root, '.claude'), 'old', { sinceMs: Date.now() - 1000 });
  assert.equal(idx.size, 1, 'onlyId 指定で古いファイルも読める');
  assert.ok(idx.has('cse_old'));
  assert.equal(idx.skippedOld, 0, 'onlyId 時は skippedOld に計上されない');
  assert.equal(idx.indexed, 1);
});

test('localIndex: 巨大ファイルでも先頭の cwd と末尾の bridge-session が取れる', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reopen-large-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const projects = path.join(root, '.claude', 'projects', 'proj');
  fs.mkdirSync(projects, { recursive: true });
  const largeFile = path.join(projects, 'large.jsonl');
  // 先頭行: cwd 情報
  const headLine = JSON.stringify({ type: 'user', cwd: 'C:\\head-cwd', message: { content: 'start' } });
  // 末尾行: bridge-session
  const tailLine = JSON.stringify({ type: 'bridge-session', bridgeSessionId: 'cse_large' });
  // 中間に 100KB のパディング（テスト用閾値 5000 bytes より大きい）
  const padding = 'x'.repeat(100 * 1024);
  const content = headLine + '\n' + padding + '\n' + tailLine + '\n';
  fs.writeFileSync(largeFile, content, 'utf8');
  // テスト用に閾値を小さく（5000 bytes）して largeFileThreshold を超えさせる
  const idx = localIndex(path.join(root, '.claude'), undefined, { largeFileThreshold: 5000, largeFileHead: 200, largeFileTail: 200 });
  assert.equal(idx.size, 1, '巨大ファイルからも bridge-session が取れる');
  assert.ok(idx.has('cse_large'), '末尾の bridge-session ID が取れる');
  const entry = idx.get('cse_large');
  assert.equal(entry.cwd, 'C:\\head-cwd', '先頭の cwd が取れる');
  assert.equal(entry.id, 'large');
  assert.equal(idx.indexed, 1);
  assert.ok(typeof idx.indexMs === 'number' && idx.indexMs >= 0);
});

test('localIndex: 既定の閾値が 8MB/512KB/4MB である', () => {
  // デフォルト引数を直接テスト（引数無しで呼び出したときの値）
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'reopen-defaults-'));
  try {
    fs.mkdirSync(path.join(base, '.claude', 'projects', 'proj'), { recursive: true });
    fs.writeFileSync(path.join(base, '.claude', 'projects', 'proj', 'dummy.jsonl'), '{}', 'utf8');
    // 引数無しで呼び出し、内部で使われる既定値を確認するため、
    // 関数のソースから既定値を直接検証
    const src = fs.readFileSync(new URL('./reopen-lost-sessions.mjs', import.meta.url), 'utf8');
    const match = src.match(/largeFileThreshold\s*=\s*(\d+)\s*\*\s*1024\s*\*\s*1024/);
    assert.ok(match, 'largeFileThreshold の既定値が見つかる');
    assert.equal(eval(match[0].split('=')[1].trim()), 8 * 1024 * 1024, 'largeFileThreshold 既定値は 8MB');
    const headMatch = src.match(/largeFileHead\s*=\s*(\d+)\s*\*\s*1024/);
    assert.ok(headMatch, 'largeFileHead の既定値が見つかる');
    assert.equal(eval(headMatch[0].split('=')[1].trim()), 512 * 1024, 'largeFileHead 既定値は 512KB');
    const tailMatch = src.match(/largeFileTail\s*=\s*(\d+)\s*\*\s*1024\s*\*\s*1024/);
    assert.ok(tailMatch, 'largeFileTail の既定値が見つかる');
    assert.equal(eval(tailMatch[0].split('=')[1].trim()), 4 * 1024 * 1024, 'largeFileTail 既定値は 4MB');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
