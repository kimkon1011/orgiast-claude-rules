const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { WINDOW_MS, matchArchive } = require('./archive-tab-match');
function readRows(base) {
  const read = name => {
    try { return fs.readFileSync(path.join(base, name), 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
  };
  const ledger = JSON.parse(read('remote-archived-sessions.json') || '{}');
  const kept = new Set(ledger.kept || []);
  const rows = [...(ledger.ids || [])];
  for (const line of read('archived-sessions.jsonl').split('\n')) {
    if (!line.trim()) continue;
    // A partially appended audit line must not cause a false unique match.
    const row = JSON.parse(line);
    if (row.reason === 'remote-archived') rows.push(row);
  }
  return rows.filter(row => !kept.has(row.sessionId));
}
function createToolRunner(home, log) {
  const running = new Map();
  return function run(name, args = []) {
    if (running.has(name)) return running.get(name);
    const roots = [process.env.ORGIAST_NIGHTLY_REPO, process.env.ORGIAST_REPO,
      path.join(home, '.claude', 'nightly-repo'), path.join(home, 'orgiast-claude-rules'),
      path.join(home, 'Downloads', 'orgiast-claude-rules')].filter(Boolean);
    const script = roots.map(root => path.join(root, 'tools', name)).find(file => fs.existsSync(file));
    if (!script) { log(`remote archive tool missing: ${name}`); return Promise.resolve(); }
    // VSCode's process.execPath is Code.exe, not the standalone Node runtime.
    const promise = new Promise(resolve => {
      execFile('node', [script, ...args], { windowsHide: true, timeout: 70_000, maxBuffer: 256 * 1024 }, (error, stdout) => {
        log(`remote archive tool=${name} ${error ? `failed=${error.message}` : stdout.trim()}`);
        resolve();
      });
    }).finally(() => running.delete(name));
    running.set(name, promise);
    return promise;
  };
}
function createArchiveWatcher({ tabs, close, read, run, log, now = Date.now }) {
  const labels = new Map(tabs().map(tab => [tab, String(tab.label)]));
  const pending = new Map();
  let disposed = false, checking = false;
  async function check() {
    if (disposed || checking || !pending.size) return;
    checking = true;
    try {
      const rows = read();
      const current = tabs();
      for (const [tab, event] of pending) {
        if (disposed) break;
        if (!current.includes(tab)) { pending.delete(tab); continue; }
        const decision = matchArchive({ ...event, currentLabel: tab.label, now: now(), rows });
        log(`remote archive tab=${JSON.stringify(event.previousLabel)} action=${decision.reason}`);
        if (decision.reason === 'expired' || decision.reason === 'label-changed') { pending.delete(tab); continue; }
        if (decision.reason !== 'matched') continue;
        // One archive must not close two same-title tab transitions in this window.
        const competing = [...pending].filter(([other, e]) => current.includes(other)
          && matchArchive({ ...e, currentLabel: other.label, now: now(), rows: [decision.row] }).reason === 'matched');
        if (competing.length > 1) { log('remote archive tab not closed: ambiguous tab transitions'); continue; }
        if (tab.label !== 'Claude Code' || pending.get(tab) !== event) continue;
        pending.delete(tab);
        const closed = await close(tab);
        log(`remote archive tab=${JSON.stringify(event.previousLabel)} session=${decision.row.sessionId} closed=${closed}`);
        if (closed) void run('purge-sessions.mjs'); // Tool retains its five-minute cooldown.
      }
    } catch (error) { log(`remote archive tabs not closed: ${error.message}`); }
    finally {
      checking = false;
      for (const [tab, event] of pending) if (now() - event.changedAt > WINDOW_MS) {
        log(`remote archive tab=${JSON.stringify(event.previousLabel)} action=expired`); pending.delete(tab);
      }
    }
  }
  function change(event = {}) {
    if (disposed) return;
    const current = tabs();
    let transitioned = false;
    for (const tab of event.changed || []) {
      if (!current.includes(tab)) continue;
      const previousLabel = labels.get(tab);
      if (previousLabel && previousLabel !== 'Claude Code' && tab.label === 'Claude Code') {
        pending.set(tab, { previousLabel, changedAt: now() }); transitioned = true;
        log(`remote archive transition=${JSON.stringify(previousLabel)} -> Claude Code`);
      } else if (pending.has(tab) && tab.label !== 'Claude Code') {
        pending.delete(tab); log(`remote archive tab=${JSON.stringify(previousLabel)} action=label-changed`);
      }
    }
    for (const tab of current) labels.set(tab, String(tab.label));
    for (const tab of labels.keys()) if (!current.includes(tab)) { labels.delete(tab); pending.delete(tab); }
    if (transitioned) {
      void run('sync-remote-archives.mjs', ['--force']).then(check).catch(error => log(`remote archive sync failed: ${error.message}`));
      void check();
    }
  }
  return { change, check, dispose() { disposed = true; pending.clear(); labels.clear(); } };
}
module.exports = { readRows, createToolRunner, createArchiveWatcher };
