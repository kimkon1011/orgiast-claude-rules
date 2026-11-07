import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hasConversation, hasHostExit, exclusion, parseAgents, parseOptions, localIndex, acquireLock, resolveClaudeCli, reopenLost, watchReopen, findWorkspaceForCwd, parseJsonTolerant, uriToPath } from './reopen-lost-sessions.mjs';

const since = '2026-11-05T19:40:00Z', until = '2026-11-05T20:15:00Z';
const exit = { event_type: 'system', payload: { reason: 'host_exit' }, created_at: since };

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
  const result = await reopenLost({ base, since, until, claudeCli: 'claude.exe', codeCli: 'C:\\code.cmd', now: () => clock,
    fetchImpl: async url => ({ ok: true, json: async () => url.includes('/events?') ? { data: [exit] } : { data: [{ id: 'cse_one' }] } }),
    spawn: (cmd, args) => { calls.push(args); return { status: 0, stdout: args[0] === 'agents' ? '[]' : '' }; },
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
  assert.match(result.error, /failed/);
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

  // reopenLoop test: session reopened 3 times in reopen-lost-sessions.log in last 24h
  const logFile = path.join(base, 'reopen-lost-sessions.log');
  const logEntries = [
    { at: '2026-11-07T08:00:00.000Z', reopened: [{ id: 'one' }] },
    { at: '2026-11-07T09:00:00.000Z', reopened: [{ id: 'one' }] },
    { at: '2026-11-07T10:00:00.000Z', reopened: [{ id: 'one' }] },
  ];
  fs.writeFileSync(logFile, logEntries.map(e => JSON.stringify(e)).join('\n') + '\n');

  const fetchImplNormal = async url => ({ ok: true, json: async () => url.includes('/events?') ? { data: [exit] } : { data: [{ id: 'cse_one' }] } });
  result = await reopenLost({ base, since, until, dryRun: true, claudeCli: 'claude.exe', now, fetchImpl: fetchImplNormal, spawn: () => ({ status: 0, stdout: '[]' }) });
  assert.equal(result.skipped.reopenLoop, 1);
});

test('post-reopen verification records verified and unverified', async t => {
  const base = fixture(t);
  let clock = 0;
  let agentCheckCount = 0;

  const result = await reopenLost({
    base, since, until, claudeCli: 'claude.exe', codeCli: 'C:\\code.cmd', now: () => clock,
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

test('reopenLost reuses workspace file and does not call code <cwd> when workspace matches', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reopen-ws-cmd-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const base = path.join(root, '.claude');
  const wsDir = path.join(root, 'myproject');
  const wsSubDir = path.join(root, 'myproject', 'sub');
  fs.mkdirSync(path.join(base, 'projects', 'proj'), { recursive: true });
  fs.mkdirSync(wsSubDir, { recursive: true });

  const wsFile = path.join(wsDir, 'myproject.code-workspace');
  fs.writeFileSync(wsFile, JSON.stringify({ folders: [{ path: '.' }] }), 'utf8');

  fs.writeFileSync(path.join(base, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'mock' } }));
  fs.writeFileSync(path.join(root, '.claude.json'), JSON.stringify({ oauthAccount: { organizationUuid: 'mock' } }));

  fs.writeFileSync(path.join(base, 'projects', 'proj', 'one.jsonl'), [
    { type: 'bridge-session', bridgeSessionId: 'cse_one' },
    { type: 'user', cwd: wsDir, message: { content: 'session 1' } },
  ].map(JSON.stringify).join('\n'));

  fs.writeFileSync(path.join(base, 'projects', 'proj', 'two.jsonl'), [
    { type: 'bridge-session', bridgeSessionId: 'cse_two' },
    { type: 'user', cwd: wsSubDir, message: { content: 'session 2' } },
  ].map(JSON.stringify).join('\n'));

  const psCalls = [];
  const fetchImpl = async url => ({
    ok: true,
    json: async () => url.includes('/events?')
      ? { data: [exit] }
      : { data: [{ id: 'cse_one' }, { id: 'cse_two' }] }
  });

  const env = { ORGIAST_VSCODE_WORKSPACE: wsFile };

  const result = await reopenLost({
    base, since, until, claudeCli: 'claude.exe', codeCli: 'C:\\code.cmd', fetchImpl, env,
    spawn: (cmd, args) => {
      if (args[0] !== 'agents') psCalls.push(args[args.length - 1]);
      return { status: 0, stdout: args[0] === 'agents' ? '[]' : '' };
    },
    windowReady: () => true,
    wait: async () => {},
  });

  assert.equal(result.reopened.length, 2);

  for (const call of psCalls) {
    assert.ok(!call.includes(wsSubDir), `Command should not open cwd directly: ${call}`);
    if (!call.includes('--open-url')) {
      assert.ok(call.includes(wsFile), `Command should target workspace file: ${call}`);
    }
  }

  assert.equal(result.reopened[0].openedWith, 'workspace');
  assert.equal(result.reopened[0].target, path.resolve(wsFile));
  assert.equal(result.reopened[1].openedWith, 'workspace');
  assert.equal(result.reopened[1].target, path.resolve(wsFile));
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
    base, since, until, claudeCli: 'claude.exe', codeCli: 'C:\\code.cmd',
    fetchImpl: async url => ({
      ok: true,
      json: async () => url.includes('/events?') ? { data: [exit] } : { data: [{ id: 'cse_one' }] }
    }),
    spawn: (cmd, args) => {
      if (args[0] !== 'agents') psCalls.push(args[args.length - 1]);
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
