import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { sessionCap, scopeRoots, inspectSession, parseArgs } from './session-cap.mjs';

const now = '2026-11-26T12:00:00.000Z', time = Date.parse(now), hour = 3600000;
function db(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const conn = new DatabaseSync(file);
  conn.exec('CREATE TABLE IF NOT EXISTS ItemTable (key TEXT PRIMARY KEY, value TEXT)');
  conn.prepare('INSERT OR REPLACE INTO ItemTable VALUES (?, ?)').run('Anthropic.claude-code', JSON.stringify(state));
  conn.close();
}
function fixture(t, state = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'session-cap-test-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const user = path.join(home, 'Code/User'), root = path.join(home, 'workspace');
  fs.mkdirSync(root);
  const project = path.join(home, '.claude/projects', root.replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(project, { recursive: true });
  const stateFile = path.join(user, 'globalStorage/state.vscdb');
  db(stateFile, state);
  fs.writeFileSync(path.join(user, 'globalStorage/storage.json'), JSON.stringify({ windowsState: { lastActiveWindow: { folder: pathToFileURL(root).href } } }));
  const processes = path.join(home, 'processes.json'); fs.writeFileSync(processes, '[]');
  const options = { home, vscodeUserDir: user, processesFile: processes, now, cap: 0 };
  function session({ id = randomUUID(), age = 48, title = '自動完了', userText, assistant = '完了', entrypoint = 'cli', rows = [], cwd = root } = {}) {
    const stamp = new Date(time - age * hour).toISOString();
    const file = path.join(project, id + '.jsonl');
    const data = [{ type: 'custom-title', customTitle: title, entrypoint, timestamp: stamp, cwd }, ...(userText ? [{ type: 'user', message: { content: userText }, timestamp: stamp, cwd }] : []), { type: 'assistant', message: { content: assistant }, timestamp: stamp, cwd }, ...rows];
    fs.writeFileSync(file, data.map(row => JSON.stringify(row)).join('\n') + '\n');
    fs.utimesSync(file, new Date(stamp), new Date(stamp));
    return id;
  }
  return { home, user, root, project, stateFile, processes, options, session };
}
const exists = (f, id) => fs.existsSync(path.join(f.project, id + '.jsonl'));
function snapshot(dir) {
  const result = {};
  function visit(current) { for (const e of fs.readdirSync(current, { withFileTypes: true })) { const file = path.join(current, e.name); if (e.isDirectory()) visit(file); else result[path.relative(dir, file)] = createHash('sha256').update(fs.readFileSync(file)).digest('hex'); } }
  visit(dir); return result;
}
test('within cap does not move; hidden and nested worktree sessions are not counted', async t => {
  const f = fixture(t), visible = f.session(), hidden = f.session();
  db(f.stateFile, { hiddenSessionIds: [hidden] });
  fs.mkdirSync(path.join(f.project, 'worktrees')); fs.writeFileSync(path.join(f.project, 'worktrees/ignored.jsonl'), '{}');
  const before = fs.readFileSync(f.stateFile);
  const result = await sessionCap({ ...f.options, cap: 1 });
  assert.equal(result.before, 1); assert.equal(result.after, 1); assert.equal(result.archived.length, 0);
  assert.ok(exists(f, visible)); assert.ok(exists(f, hidden)); assert.deepEqual(fs.readFileSync(f.stateFile), before);
});
test('moves only required oldest sessions, sidecar and ledger; restore through existing CLI', async t => {
  const f = fixture(t), oldest = f.session({ age: 96 }), middle = f.session({ age: 72 }), newest = f.session();
  fs.mkdirSync(path.join(f.project, oldest)); fs.writeFileSync(path.join(f.project, oldest, 'note.txt'), 'preserved');
  const original = fs.readFileSync(path.join(f.project, oldest + '.jsonl'));
  const reportDir = path.join(f.home, 'reports');
  const result = await sessionCap({ ...f.options, cap: 2, reportDir });
  assert.deepEqual(result.archived.map(x => x.id), [oldest]); assert.equal(result.after, 2);
  assert.ok(exists(f, middle)); assert.ok(exists(f, newest));
  const ledger = JSON.parse(fs.readFileSync(path.join(f.home, '.claude/archived-sessions.jsonl'), 'utf8').trim());
  assert.deepEqual(Object.keys(ledger).sort(), ['at', 'projectId', 'reason', 'sessionId', 'title']); assert.equal(ledger.reason, 'cap30');
  for (const name of ['inventory.json', 'skipped.json', 'pending-found.md', 'archived.json']) assert.ok(fs.existsSync(path.join(reportDir, name)));
  const output = execFileSync(process.execPath, [fileURLToPath(new URL('./purge-sessions.mjs', import.meta.url)), '--restore', oldest], { encoding: 'utf8', env: { ...process.env, HOME: f.home, USERPROFILE: f.home }, windowsHide: true });
  assert.equal(JSON.parse(output).restored, oldest);
  assert.deepEqual(fs.readFileSync(path.join(f.project, oldest + '.jsonl')), original);
  assert.equal(fs.readFileSync(path.join(f.project, oldest, 'note.txt'), 'utf8'), 'preserved');
});
test('running, process, open tab, current session, pending, draft, group and user-opened remain', async t => {
  const f = fixture(t), expected = new Map();
  expected.set(f.session({ age: 0.1 }), 'running');
  const processId = f.session(); expected.set(processId, 'running');
  fs.writeFileSync(f.processes, JSON.stringify([{ Name: 'node.exe', CommandLine: `node --resume ${processId}` }]));
  const open = f.session(); expected.set(open, 'open-tab');
  const workspaceDb = path.join(f.user, 'workspaceStorage/test/state.vscdb'); db(workspaceDb, { tabs: [{ id: open }] }); fs.utimesSync(workspaceDb, new Date(now), new Date(now));
  const current = f.session(); expected.set(current, 'running');
  fs.mkdirSync(path.join(f.home, '.claude/current-sessions')); fs.writeFileSync(path.join(f.home, '.claude/current-sessions/live.json'), JSON.stringify({ sessionId: current, at: now }));
  expected.set(f.session({ assistant: '承認待ち' }), 'pending');
  expected.set(f.session({ assistant: '下書きです' }), 'draft');
  const grouped = f.session(); expected.set(grouped, 'grouped'); db(f.stateFile, { [`sessionGroups:${f.root}`]: { group: [grouped] } });
  expected.set(f.session({ userText: '調べて', entrypoint: 'cli' }), 'user-opened');
  expected.set(f.session({ title: 'Nightly', age: 5 }), 'job-active');
  expected.set(f.session({ age: 20 }), 'automatic-recent');
  const result = await sessionCap(f.options);
  assert.equal(result.archived.length, 0); assert.equal(result.overCap.count, expected.size);
  for (const [id, reason] of expected) { assert.ok(exists(f, id)); assert.ok(result.kept.find(s => s.id === id).reasons.includes(reason), reason); }
  assert.equal(result.pending.length, 1);
});
test('user close title or existing approval permits archival, but pending still wins', async t => {
  const f = fixture(t);
  const title = f.session({ userText: '依頼', entrypoint: 'cli', title: '【閉じて可】完了' });
  const approved = f.session({ userText: '依頼', entrypoint: 'cli', assistant: 'このセッション: アーカイブしてよい' });
  const pending = f.session({ userText: '依頼', entrypoint: 'cli', title: '【閉じて可】確認', assistant: '返事待ち' });
  const r = await sessionCap(f.options);
  assert.deepEqual(new Set(r.archived.map(x => x.id)), new Set([title, approved])); assert.ok(exists(f, pending));
});
test('dry-run without report-dir writes no files, locks or last.json', async t => {
  const f = fixture(t); f.session(); const before = snapshot(f.home);
  const r = await sessionCap({ ...f.options, dryRun: true });
  assert.equal(r.archived.length, 1); assert.deepEqual(snapshot(f.home), before);
});

test('old sdk sessions do not count toward cap and never move, including sidecars', async t => {
  const f = fixture(t), visible = f.session({ entrypoint: 'claude-vscode' });
  const unknown = f.session({ entrypoint: null });
  const sdk = ['sdk-cli', 'sdk-ts', 'sdk'].map(entrypoint => f.session({ entrypoint, age: 200 }));
  for (const id of sdk) { fs.mkdirSync(path.join(f.project, id)); fs.writeFileSync(path.join(f.project, id, 'note.txt'), 'untouched'); }
  const before = snapshot(f.project);
  const within = await sessionCap({ ...f.options, cap: 2 });
  assert.equal(within.before, 2); assert.equal(within.after, 2); assert.equal(within.programmaticIgnored, 3);
  assert.equal(within.overCap, null); assert.deepEqual(within.archived, []);
  assert.deepEqual(snapshot(f.project), before);
  const over = await sessionCap({ ...f.options, cap: 0 });
  assert.equal(over.before, 2); assert.equal(over.after, 0); assert.equal(over.programmaticIgnored, 3);
  assert.deepEqual(new Set(over.archived.map(row => row.id)), new Set([visible, unknown]));
  for (const [file, hash] of Object.entries(snapshot(f.project))) assert.equal(hash, before[file]);
  for (const id of sdk) {
    assert.ok(exists(f, id)); assert.ok(fs.existsSync(path.join(f.project, id, 'note.txt')));
    assert.ok(!over.kept.some(row => row.id === id));
  }
});

test('dry-run reports visible inventory, keep reasons, unread and last assistant excerpt', async t => {
  const f = fixture(t), archive = f.session({ entrypoint: null });
  const assistant = '確認内容'.repeat(100);
  const pending = f.session({ assistant, rows: [{ type: 'user', message: { content: '最新ユーザー発言' } }] });
  const sdk = f.session({ entrypoint: 'sdk-cli' }), hidden = f.session();
  db(f.stateFile, { hiddenSessionIds: [hidden], [`sessionUnread:${f.root}`]: [pending] });
  const before = snapshot(f.home), reportDir = path.join(f.home, 'reports');
  for (const cap of [0, 10]) {
    const r = await sessionCap({ ...f.options, cap, dryRun: true, reportDir });
    const report = JSON.parse(fs.readFileSync(path.join(reportDir, 'inventory.json'), 'utf8'));
    assert.equal(r.before, 2); assert.equal(r.programmaticIgnored, 1);
    assert.equal(report.inventory.length, 2);
    assert.ok(!report.inventory.some(row => [sdk, hidden].includes(row.id)));
    const a = report.inventory.find(row => row.id === archive), p = report.inventory.find(row => row.id === pending);
    assert.deepEqual(Object.keys(a).sort(), ['decision', 'entrypoint', 'id', 'mtime', 'reasons', 'title', 'unread']);
    assert.equal(a.entrypoint, ''); assert.equal(typeof a.mtime, 'number'); assert.equal(a.unread, false);
    assert.deepEqual(a.reasons, []); assert.equal(a.decision, cap === 0 ? 'archive' : 'keep');
    assert.equal(p.unread, true); assert.equal(p.decision, 'keep'); assert.ok(p.reasons.includes('pending-user'));
    const skipped = JSON.parse(fs.readFileSync(path.join(reportDir, 'skipped.json'), 'utf8'));
    assert.deepEqual(skipped, report.inventory.filter(row => row.decision === 'keep').map(({ id, title, reasons }) => ({ id, title, reasons })));
    const markdown = fs.readFileSync(path.join(reportDir, 'pending-found.md'), 'utf8');
    assert.ok(markdown.includes(pending)); assert.ok(markdown.includes(p.title));
    assert.ok(markdown.includes(assistant.slice(0, 300))); assert.ok(!markdown.includes(assistant.slice(0, 301)));
    assert.ok(!markdown.includes('最新ユーザー発言'));
    assert.deepEqual(Object.fromEntries(Object.entries(snapshot(f.home)).filter(([file]) => !file.startsWith('reports' + path.sep))), before);
  }
});
test('archive collision is preserved and next eligible candidate is used', async t => {
  const f = fixture(t), id = f.session({ age: 72 }), other = f.session();
  const to = path.join(f.home, '.claude/projects-archive', path.basename(f.project)); fs.mkdirSync(to, { recursive: true }); fs.writeFileSync(path.join(to, id + '.jsonl'), 'existing');
  const r = await sessionCap({ ...f.options, cap: 1 });
  assert.deepEqual(r.archived.map(x => x.id), [other]); assert.ok(exists(f, id)); assert.equal(fs.readFileSync(path.join(to, id + '.jsonl'), 'utf8'), 'existing');
});
test('ledger failure rolls both transcript and sidecar back', async t => {
  const f = fixture(t), id = f.session(); fs.mkdirSync(path.join(f.project, id));
  fs.mkdirSync(path.join(f.home, '.claude/archived-sessions.jsonl'));
  const r = await sessionCap(f.options); assert.equal(r.archived.length, 0); assert.ok(exists(f, id)); assert.ok(fs.existsSync(path.join(f.project, id)));
});
test('unreadable global state is a safe no-op and CLI exits successfully', async t => {
  const f = fixture(t), id = f.session(); fs.writeFileSync(f.stateFile, 'invalid DB');
  const r = await sessionCap(f.options); assert.equal(r.stateReadable, false); assert.ok(exists(f, id));
  const cli = execFileSync(process.execPath, [fileURLToPath(new URL('./session-cap.mjs', import.meta.url)), '--home', f.home, '--vscode-user-dir', f.user, '--dry-run', '--json'], { encoding: 'utf8', windowsHide: true });
  assert.equal(JSON.parse(cli).stateReadable, false);
});
test('pending patterns, unanswered questions and future title deadlines protect', async t => {
  const f = fixture(t);
  for (const assistant of ['【kim 確認用の全文】内容', '判断してほしい', 'してよいですか', 'どうします？', '次に kim がすること: 確認', 'このセッション: 待機']) f.session({ assistant });
  f.session({ title: '【12/01/12:00まで】確認' });
  f.session({ rows: [{ type: 'user', message: { content: '追加の依頼' } }] });
  f.session({ rows: [{ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'ask1', name: 'AskUserQuestion', input: {} }] } }] });
  const r = await sessionCap(f.options); assert.equal(r.pending.length, 9); assert.equal(r.archived.length, 0);
});
test('parsing ignores broken lines/meta/sidechain/tool_result; titles and answered ask', async t => {
  const f = fixture(t), id = f.session({ userText: 'real user', rows: [
    { type: 'ai-title', aiTitle: 'AI' }, { type: 'summary', summary: 'Summary' },
    { type: 'user', isMeta: true, message: { content: 'meta' } }, { type: 'user', isSidechain: true, message: { content: 'side' } },
    { type: 'user', message: { content: '<system>' } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'q', name: 'AskUserQuestion' }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'q', content: 'yes' }] } }
  ] });
  fs.appendFileSync(path.join(f.project, id + '.jsonl'), 'broken line\n');
  const data = await inspectSession(path.join(f.project, id + '.jsonl'));
  assert.equal(data.userTurns, 1); assert.equal(data.title, '自動完了'); assert.equal(data.unanswered, false); assert.equal(data.lastMessage, 'assistant');
});
test('git dirty, unpushed and unknown protect; unrelated dirty file does not', async t => {
  const f = fixture(t);
  const git = args => execFileSync('git', ['-C', f.root, ...args], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  git(['init']); git(['config', 'user.email', 'test@example.invalid']); git(['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(f.root, 'a.txt'), 'one'); fs.writeFileSync(path.join(f.root, 'b.txt'), 'one'); git(['add', '.']); git(['commit', '-m', 'initial']);
  git(['branch', 'upstream']); git(['branch', '--set-upstream-to=upstream']);
  const edit = file => ({ type: 'assistant', cwd: f.root, message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: path.join(f.root, file) } }] } });
  fs.writeFileSync(path.join(f.root, 'a.txt'), 'dirty');
  const dirty = f.session({ rows: [edit('a.txt')] }), clean = f.session({ rows: [edit('b.txt')] });
  let r = await sessionCap(f.options); assert.ok(r.kept.find(x => x.id === dirty).reasons.includes('git-dirty')); assert.ok(r.archived.some(x => x.id === clean));
  git(['add', 'a.txt']); git(['commit', '-m', 'unpublished']);
  const unpushed = f.session({ rows: [edit('a.txt'), { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'git commit -m change' } }] } }] });
  r = await sessionCap(f.options); assert.ok(r.kept.find(x => x.id === unpushed).reasons.includes('git-unpushed'));
  git(['branch', '--unset-upstream']); const unknown = f.session({ rows: [edit('a.txt')] });
  r = await sessionCap(f.options); assert.ok(r.kept.find(x => x.id === unknown).reasons.includes('git-unknown'));
});
test('workspace JSONC resolves first relative folder and deduplicates windows', t => {
  const f = fixture(t), workspace = path.join(f.home, 'test.code-workspace');
  fs.writeFileSync(workspace, '{ // comment\n "folders": [{"path": "workspace",}, {"path":"other"}], }');
  const win = { workspaceIdentifier: { configURIPath: pathToFileURL(workspace).href } };
  fs.writeFileSync(path.join(f.user, 'globalStorage/storage.json'), JSON.stringify({ windowsState: { lastActiveWindow: win, openedWindows: [win] } }));
  assert.deepEqual(scopeRoots(f.user, f.home), [f.root]);
});
test('max-move limits archival; live lock blocks; dead PID lock is reclaimed', async t => {
  const f = fixture(t); f.session(); f.session();
  let r = await sessionCap({ ...f.options, maxMove: 1 }); assert.equal(r.archived.length, 1); assert.equal(r.overCap.count, 1);
  const lock = path.join(f.home, '.claude/session-cap/lock'); fs.writeFileSync(lock, JSON.stringify({ pid: process.pid }));
  r = await sessionCap(f.options); assert.equal(r.skipped, 'locked');
  const childPid = Number(execFileSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' }).trim());
  fs.writeFileSync(lock, JSON.stringify({ pid: childPid }));
  r = await sessionCap(f.options); assert.equal(r.archived.length, 1); assert.equal(fs.existsSync(lock), false);
});
test('invalid arguments are rejected', () => { assert.throws(() => parseArgs(['--cap']), /missing/); assert.throws(() => parseArgs(['--surprise']), /unknown/); });
test('fresh timestamp protects despite old mtime; stale workspace tabs do not protect', async t => {
  const f = fixture(t), fresh = f.session({ rows: [{ type: 'assistant', timestamp: now, message: { content: '完了' } }] }), stale = f.session();
  const file = path.join(f.user, 'workspaceStorage/old/state.vscdb'); db(file, { tabs: [stale] });
  fs.utimesSync(file, new Date(time - 15 * 24 * hour), new Date(time - 15 * 24 * hour));
  const r = await sessionCap(f.options);
  assert.ok(r.kept.find(x => x.id === fresh).reasons.includes('running'));
  assert.ok(r.archived.some(x => x.id === stale));
});
test('recent unreadable workspace and failed process inventory fail closed', async t => {
  const f = fixture(t), id = f.session();
  const file = path.join(f.user, 'workspaceStorage/recent/state.vscdb'); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'broken');
  let r = await sessionCap(f.options); assert.equal(r.archived.length, 0); assert.ok(exists(f, id)); assert.ok(r.kept[0].reasons.includes('protection-unreadable'));
  fs.writeFileSync(f.processes, 'broken');
  r = await sessionCap(f.options); assert.equal(r.archived.length, 0); assert.ok(exists(f, id));
});
