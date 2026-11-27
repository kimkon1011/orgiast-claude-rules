import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { db } from './fixtures/session-cap-state.mjs';
import { main } from './session-cap-enforce.mjs';

const now = Date.parse('2026-11-27T12:00:00Z'), hour = 3600000;
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'session-cap-enforce-test-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const base = path.join(home, '.claude'), user = path.join(home, 'Code/User');
  const root = path.join(home, 'workspace'), projectId = root.replace(/[^a-zA-Z0-9]/g, '-');
  const project = path.join(base, 'projects', projectId), arch = path.join(base, 'projects-archive', projectId);
  fs.mkdirSync(project, { recursive: true });
  const stateFile = path.join(user, 'globalStorage/state.vscdb');
  db(stateFile, {});
  fs.writeFileSync(path.join(user, 'globalStorage/storage.json'), JSON.stringify({
    windowsState: { lastActiveWindow: { folder: pathToFileURL(root).href } },
  }));
  const pids = new Set(), killed = [], commands = { text: '' };
  const options = { home, vscodeUserDir: user, now, platform: 'win32',
    getProcesses: () => ({ pids, cmdlines: commands.text }), kill: pid => { killed.push(pid); } };
  function session({ title = '', entrypoint = 'claude-vscode', assistant = '作業中', age = 8,
    userTurns = 1, rows = [], directory = project } = {}) {
    const id = randomUUID(), file = path.join(directory, id + '.jsonl');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(file, [
      { type: 'custom-title', customTitle: title, entrypoint },
      ...Array.from({ length: userTurns }, () => ({ type: 'user', message: { content: '依頼' } })),
      ...(assistant ? [{ type: 'assistant', message: { content: [{ type: 'text', text: assistant }] } }] : []), ...rows,
    ].map(row => JSON.stringify(row)).join('\n') + '\n');
    fs.utimesSync(file, new Date(now - age * hour), new Date(now - age * hour));
    return id;
  }
  function proc(id, pid, status, age, live = true) {
    const dir = path.join(base, 'sessions'); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${pid}.json`), JSON.stringify({
      sessionId: id, pid, status, updatedAt: now - age * hour,
    }));
    if (live) pids.add(pid);
  }
  const exists = id => fs.existsSync(path.join(project, id + '.jsonl'));
  const ledger = () => fs.readFileSync(path.join(base, 'archived-sessions.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  return { home, base, user, root, project, projectId, arch, stateFile, options, session, proc, killed, commands, exists, ledger };
}
test('closable, login-expired, empty and sdk-done move with sidecar and ledger', async t => {
  const f = fixture(t), expected = new Map([
    [f.session({ assistant: 'このセッション: 閉じてよい' }), 'closable'],
    [f.session({ title: 'KimPC｜【閉じて可】完了' }), 'closable'],
    [f.session({ assistant: 'Login expired' }), 'login-expired'],
    [f.session({ assistant: '', userTurns: 0 }), 'empty'],
    [f.session({ entrypoint: 'sdk', age: 0.5 }), 'sdk-done'],
  ]);
  const first = [...expected.keys()][0];
  fs.mkdirSync(path.join(f.project, first)); fs.writeFileSync(path.join(f.project, first, 'note.txt'), 'preserved');
  const before = fs.readFileSync(f.stateFile);
  assert.equal(await main(f.options), 0);
  const ledger = f.ledger(); assert.equal(ledger.length, expected.size);
  for (const [id, why] of expected) {
    assert.equal(f.exists(id), false);
    const row = ledger.find(r => r.sessionId === id);
    assert.deepEqual(row, { sessionId: id, projectId: f.projectId, reason: `cap30-enforce:${why}`,
      at: new Date(now).toISOString(), dest: path.join(f.arch, id + '.jsonl') });
    assert.ok(fs.existsSync(row.dest));
  }
  assert.equal(fs.readFileSync(path.join(f.arch, first, 'note.txt'), 'utf8'), 'preserved');
  assert.deepEqual(fs.readFileSync(f.stateFile), before);
  assert.match(fs.readFileSync(path.join(f.base, 'logs/session-cap-enforce-history.log'), 'utf8'),
    /files 5 -> 0 moved=5 killedIdle=0 skippedBusy=0 interactiveLeft=0/);
});
test('start-dup keeps only the newest qualifying session', async t => {
  const f = fixture(t), rows = [{ type: 'assistant', message: { content: [
    { type: 'tool_use', name: 'AskUserQuestion', id: 'ask', input: {} },
  ] } }];
  const old = f.session({ title: 'session-start', age: 10, rows });
  const latest = f.session({ title: '待機中', age: 7, rows });
  const recent = f.session({ title: 'session-start', age: 5, rows });
  const answered = f.session({ title: 'session-start', rows: [...rows,
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'ask', content: '回答' }] } }], age: 12 });
  assert.equal(await main(f.options), 0);
  assert.equal(f.exists(old), false);
  for (const id of [latest, recent, answered]) assert.ok(f.exists(id));
  assert.equal(f.ledger()[0].reason, 'cap30-enforce:start-dup');
});
test('live busy and recent idle/waiting stay; only old idle/waiting are killed', async t => {
  const f = fixture(t), title = '【閉じて可】完了';
  const protectedIds = ['busy', 'idle', 'waiting'].map((status, index) => {
    const id = f.session({ title }); f.proc(id, 100 + index, status, status === 'busy' ? 10 : 1);
    return id;
  });
  const idle = f.session({ title }), waiting = f.session({ title }), dead = f.session({ title });
  f.proc(idle, 200, 'idle', 2); f.proc(waiting, 201, 'waiting', 2); f.proc(dead, 202, 'busy', 2, false);
  assert.equal(await main(f.options), 0);
  for (const id of protectedIds) assert.ok(f.exists(id));
  for (const id of [idle, waiting, dead]) assert.equal(f.exists(id), false);
  assert.deepEqual(new Set(f.killed), new Set([200, 201]));
});
test('hidden, ordinary interactive, recent sdk and sdk with live command line stay', async t => {
  const f = fixture(t), ordinary = f.session(), hidden = f.session({ title: '【閉じて可】完了' });
  const recent = f.session({ entrypoint: 'sdk', age: 0.25 }), running = f.session({ entrypoint: 'sdk' });
  const loginWithWork = f.session({ assistant: 'Login expired', userTurns: 2 });
  db(f.stateFile, { hiddenSessionIds: [hidden] }); f.commands.text = `node --resume ${running}`;
  assert.equal(await main(f.options), 0);
  for (const id of [ordinary, hidden, recent, running, loginWithWork]) assert.ok(f.exists(id));
  assert.equal(fs.existsSync(path.join(f.base, 'archived-sessions.jsonl')), false);
});
test('dry-run does not move files, create archives or ledger, or kill', async t => {
  const f = fixture(t), id = f.session({ title: '【閉じて可】完了' }); f.proc(id, 123, 'idle', 2);
  const before = fs.readFileSync(path.join(f.project, id + '.jsonl'));
  assert.equal(await main({ ...f.options, dryRun: true }), 0);
  assert.deepEqual(fs.readFileSync(path.join(f.project, id + '.jsonl')), before);
  assert.equal(fs.existsSync(f.arch), false); assert.deepEqual(f.killed, []);
  assert.equal(fs.existsSync(path.join(f.base, 'archived-sessions.jsonl')), false);
  assert.match(fs.readFileSync(path.join(f.base, 'logs/session-cap-enforce-history.log'), 'utf8'), /DRY files 1 -> 0/);
});
test('archive and sidecar collisions preserve all old files under resurrected', async t => {
  const f = fixture(t), id = f.session({ title: '【閉じて可】完了' });
  fs.mkdirSync(path.join(f.project, id)); fs.writeFileSync(path.join(f.project, id, 'note.txt'), 'new side');
  fs.mkdirSync(f.arch, { recursive: true }); fs.writeFileSync(path.join(f.arch, id + '.jsonl'), 'old archive');
  assert.equal(await main(f.options), 0);
  const dest = path.join(f.arch, 'resurrected', `${id}.${now}.jsonl`);
  assert.equal(f.ledger()[0].dest, dest); assert.ok(fs.existsSync(dest));
  assert.equal(fs.readFileSync(path.join(f.arch, 'resurrected', `${id}.${now}`, 'note.txt'), 'utf8'), 'new side');
  assert.equal(fs.readFileSync(path.join(f.arch, id + '.jsonl'), 'utf8'), 'old archive');
  // A second run at the same injected time must not overwrite the first resurrected copy.
  fs.copyFileSync(dest, path.join(f.project, id + '.jsonl'));
  assert.equal(await main(f.options), 0);
  assert.equal(f.ledger()[1].dest, path.join(f.arch, 'resurrected', `${id}.${now}.1.jsonl`));
  const sideOnly = f.session({ title: '【閉じて可】完了' });
  fs.mkdirSync(path.join(f.arch, sideOnly)); fs.writeFileSync(path.join(f.arch, sideOnly, 'old.txt'), 'old side');
  assert.equal(await main(f.options), 0);
  assert.equal(f.ledger()[2].dest, path.join(f.arch, 'resurrected', `${sideOnly}.${now}.jsonl`));
  assert.equal(fs.readFileSync(path.join(f.arch, sideOnly, 'old.txt'), 'utf8'), 'old side');
});
test('VS Code missing User or state DB and non-Windows are no-ops', async t => {
  const f = fixture(t), id = f.session({ title: '【閉じて可】完了' });
  const forbidden = () => assert.fail('must not inspect or kill real processes');
  for (const user of [path.join(f.home, 'absent'), path.join(f.home, 'empty-user')]) {
    if (user.endsWith('empty-user')) fs.mkdirSync(user);
    assert.equal(await main({ ...f.options, vscodeUserDir: user, getProcesses: forbidden, kill: forbidden }), 0);
  }
  assert.equal(await main({ ...f.options, platform: 'linux', getProcesses: forbidden, kill: forbidden }), 0);
  assert.ok(f.exists(id)); assert.equal(fs.existsSync(f.arch), false);
  assert.equal(fs.readFileSync(path.join(f.base, 'logs/session-cap-enforce-history.log'), 'utf8').trim().split('\n').length, 2);
});
test('workspace first folder only, multiple windows and actual project directory names', async t => {
  const f = fixture(t), second = path.join(f.home, 'second'), ignored = path.join(f.home, 'ignored');
  const workspace = path.join(f.home, 'test.code-workspace');
  fs.writeFileSync(workspace, JSON.stringify({ folders: [{ path: f.root }, { path: ignored }] }));
  fs.writeFileSync(path.join(f.user, 'globalStorage/storage.json'), JSON.stringify({ windowsState: {
    lastActiveWindow: { workspaceIdentifier: { configURIPath: pathToFileURL(workspace).href } },
    openedWindows: [{ folder: pathToFileURL(second).href }],
  } }));
  const dir = root => path.join(f.base, 'projects', root.replace(/[^a-zA-Z0-9]/g, '-').toUpperCase());
  const one = f.session({ title: '【閉じて可】完了' });
  const two = f.session({ title: '【閉じて可】完了', directory: dir(second) });
  const three = f.session({ title: '【閉じて可】完了', directory: dir(ignored) });
  assert.equal(await main(f.options), 0);
  assert.equal(f.exists(one), false);
  assert.equal(fs.existsSync(path.join(dir(second), two + '.jsonl')), false);
  assert.ok(fs.existsSync(path.join(dir(ignored), three + '.jsonl')));
  assert.equal(f.ledger().find(r => r.sessionId === two).projectId, path.basename(dir(second)));
});
test('unreadable protections fail closed; failed kill leaves the session in place', async t => {
  const f = fixture(t), id = f.session({ title: '【閉じて可】完了' }); f.proc(id, 321, 'idle', 2);
  assert.equal(await main({ ...f.options, getProcesses: () => { throw new Error('process list unavailable'); } }), 1);
  assert.ok(f.exists(id));
  assert.equal(await main({ ...f.options, kill: () => { throw new Error('kill failed'); } }), 1);
  assert.ok(f.exists(id)); assert.equal(fs.existsSync(f.arch), false);
  fs.writeFileSync(f.stateFile, 'broken');
  assert.equal(await main(f.options), 1); assert.ok(f.exists(id)); assert.deepEqual(f.killed, []);
});
