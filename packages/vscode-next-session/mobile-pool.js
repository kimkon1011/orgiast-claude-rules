const fs = require('node:fs');
const path = require('node:path');

function targetCount(value = 1) {
  const count = Number(value);
  if (!Number.isInteger(count) || count < 1 || count > 10) throw new Error('待機数は 1..10 の整数で指定してください');
  return count;
}
function readConfig(home, env = process.env) {
  let config = {};
  try { config = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'mobile-sessions.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return targetCount(env.CLAUDE_MOBILE_STANDBY ?? config.count ?? 1);
}
function readSnapshot(home, now = Date.now()) {
  try {
    const state = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'mobile-sessions-state.json'), 'utf8'));
    if (now - state.updatedAt > 30000 || now < state.updatedAt || !Number.isInteger(state.waiting) || state.waiting < 0) return null;
    return state;
  } catch { return null; }
}
// A loopback socket is an OS-owned mutex shared by all VS Code windows. A dead
// host releases it automatically; there is no stale-file deletion race.
function createOwnershipLease(port = 39741) {
  const net = require('node:net');
  let server, pending;
  return {
    async acquire() {
      if (server?.listening) return true;
      if (pending) return pending;
      pending = new Promise((resolve, reject) => {
        const candidate = net.createServer((socket) => socket.destroy());
        candidate.once('error', (error) => {
          if (error.code === 'EADDRINUSE') resolve(false);
          else reject(error);
        });
        candidate.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
          server = candidate;
          server.unref();
          resolve(true);
        });
      }).finally(() => { pending = null; });
      return pending;
    },
    port() { return server?.address()?.port; },
    release() { if (server) server.close(); server = undefined; },
  };
}

// No custom title: Claude changes its natural title after the first prompt. Custom
// names suppress that signal and renameSessionTab now opens an interactive dialog.
function isWaitingTab(tab) { return String(tab.label) === 'Claude Code'; }
function createPool({ tabs, open, publish, own = () => true }) {
  let running;
  return {
    ensure(count) {
      if (running) return running;
      running = (async () => {
        if (!await own()) return;
        let waiting = tabs().filter(isWaitingTab).length;
        publish(waiting, count);
        while (waiting < count) {
          if (!await open()) break;
          const next = tabs().filter(isWaitingTab).length;
          if (next <= waiting) break; // No acknowledged empty tab: don't blindly retry.
          waiting = next;
          publish(waiting, count);
        }
      })().finally(() => { running = null; });
      return running;
    }
  };
}
module.exports = { targetCount, readConfig, readSnapshot, createOwnershipLease, isWaitingTab, createPool };
