const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createArchiveWatcher, readRows } = require('./archive-tabs');
function fixture() {
  let time = Date.now(), rows = [];
  const tabs = [{ label: '作業' }], closed = [], calls = [], logs = [];
  const watcher = createArchiveWatcher({ tabs: () => tabs, close: async tab => { closed.push(tab); return true; }, read: () => rows,
    run: async (...args) => { calls.push(args); }, log: line => logs.push(line), now: () => time });
  return { watcher, tabs, closed, calls, logs, rows(value) { rows = value; }, advance(ms) { time += ms; },
    row: { sessionId: 'id', title: '作業', archivedAt: new Date(time).toISOString() },
    change(label) { tabs[0].label = label; watcher.change({ changed: [tabs[0]] }); } };
}
const settle = () => new Promise(resolve => setImmediate(resolve));
test('captures transition, forces sync, retries delayed ledger and closes once then purges', async () => {
  const f = fixture(); f.change('Claude Code'); await settle();
  assert.equal(f.closed.length, 0); assert.deepEqual(f.calls, [['sync-remote-archives.mjs', ['--force']]]);
  f.rows([f.row]); f.advance(30_000); await f.watcher.check(); await f.watcher.check();
  assert.equal(f.closed.length, 1); assert.equal(f.calls[1][0], 'purge-sessions.mjs');
});
test('newly opened default tabs are never candidates; opened title is remembered', async () => {
  const f = fixture(); f.rows([f.row]);
  f.tabs.push({ label: 'Claude Code' }); f.watcher.change({ opened: [f.tabs[1]] });
  await f.watcher.check(); assert.equal(f.closed.length, 0);
  f.tabs[1].label = '別作業'; f.watcher.change({ changed: [f.tabs[1]] });
  f.tabs[1].label = 'Claude Code'; f.watcher.change({ changed: [f.tabs[1]] });
  await settle(); assert.equal(f.closed.length, 0);
});
test('label returning then becoming empty again cannot reuse old transition', async () => {
  const f = fixture(); f.change('Claude Code'); await settle(); f.change('再開');
  f.rows([f.row]); f.change('Claude Code'); await settle();
  assert.equal(f.closed.length, 0);
});
test('expired and disposed candidates never close after evidence arrives', async () => {
  for (const disposed of [true, false]) {
    const f = fixture(); f.change('Claude Code'); await settle();
    if (disposed) f.watcher.dispose(); else f.advance(600_001);
    f.rows([f.row]); await f.watcher.check(); assert.equal(f.closed.length, 0);
  }
});
test('ambiguous archive rows or two same-title tab transitions stay open', async () => {
  const f = fixture(); f.rows([f.row, { ...f.row, sessionId: 'other' }]); f.change('Claude Code'); await settle();
  assert.equal(f.closed.length, 0);
  const g = fixture(); g.tabs.push({ label: '作業' }); g.watcher.change({ opened: [g.tabs[1]] });
  g.rows([g.row]); for (const tab of g.tabs) tab.label = 'Claude Code';
  g.watcher.change({ changed: g.tabs }); await settle(); assert.equal(g.closed.length, 0);
});
test('audit uses remote rows with archivedAt, honors kept and rejects incomplete evidence', t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-tabs-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  fs.writeFileSync(path.join(base, 'remote-archived-sessions.json'), JSON.stringify({ ids: [{ sessionId: 'queued' }], kept: ['restored'] }));
  fs.writeFileSync(path.join(base, 'archived-sessions.jsonl'), [
    { sessionId: 'moved', reason: 'remote-archived', archivedAt: '2026-11-02T05:57:03Z' },
    { sessionId: 'restored', reason: 'remote-archived' }, { sessionId: 'closed', reason: 'closed' },
  ].map(JSON.stringify).join('\n') + '\n');
  assert.deepEqual(readRows(base).map(row => row.sessionId), ['queued', 'moved']);
  fs.appendFileSync(path.join(base, 'archived-sessions.jsonl'), '{');
  assert.throws(() => readRows(base));
});
test('tool runner uses standalone Node, force args, coalesces in-flight sync, and reports missing tools', async () => {
  const vm = require('node:vm');
  const calls = [], logs = []; let callback;
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'archive-tabs.js'), 'utf8'), {
    module, process: { env: { ORGIAST_NIGHTLY_REPO: '/synced' } },
    require(name) {
      if (name === 'node:fs') return { existsSync: file => file === path.join('/synced', 'tools', 'sync-remote-archives.mjs') };
      if (name === 'node:child_process') return { execFile(...args) { calls.push(args.slice(0, 3)); callback = args[3]; } };
      return require(name);
    },
  });
  const run = module.exports.createToolRunner('/home/test', line => logs.push(line));
  const first = run('sync-remote-archives.mjs', ['--force']);
  assert.equal(first, run('sync-remote-archives.mjs', ['--force']));
  assert.equal(calls.length, 1); assert.equal(calls[0][0], 'node');
  assert.deepEqual(Array.from(calls[0][1]), [path.join('/synced', 'tools', 'sync-remote-archives.mjs'), '--force']);
  assert.equal(calls[0][2].windowsHide, true);
  callback(null, '{"queued":1}'); await first;
  await run('missing.mjs'); assert.match(logs.at(-1), /tool missing/);
  const failed = run('sync-remote-archives.mjs'); callback(new Error('offline'), ''); await failed;
  assert.match(logs.at(-1), /failed=offline/);
});
