const { targetCount, readConfig, readSnapshot, readRefreshConfig, readLastRefreshAt, inRefreshHours } = require('./mobile-state.cjs');
const { newRetryState, canAttemptMobileOpen, recordMobileOpenAttempt } = require('./route');

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
function createPool({ tabs, open, publish, own = () => true, now = Date.now }) {
  let running;
  let retry = newRetryState();
  return {
    ensure(count) {
      if (running) return running;
      running = (async () => {
        if (!await own()) return;
        let waiting = tabs().filter(isWaitingTab).length;
        publish(waiting, count);
        while (waiting < count) {
          if (!canAttemptMobileOpen(retry, now())) break;
          const opened = await open();
          retry = recordMobileOpenAttempt(retry, now(), opened);
          if (!opened) break;
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
// --- 定期リフレッシュ判定（純粋関数） ---
// 待機タブのうち最古の 1 本を閉じ、補充で新セッションとして作り直す（スマホ一覧の上に出すため）。
const REFRESH_MIN_AGE_MS = 10 * 60000; // 出現から 10 分未満は対象外（レース回避）
// tabs: [{ label, appearedAt, isActive }]。force=true（URI の refresh=1）は時間帯・間隔・無効設定を無視する。
// 不足中（待機数 < target）は常に no。補充を優先する。
function decideRefresh({ now, minutes, hoursOk, lastRefreshAt, target, tabs, force = false }) {
  const waiting = tabs.filter(isWaitingTab);
  if (waiting.length < target) return { refresh: false, reason: 'shortage', waiting: waiting.length };
  if (!force) {
    if (!(minutes > 0)) return { refresh: false, reason: 'disabled', waiting: waiting.length };
    if (!hoursOk) return { refresh: false, reason: 'outside-hours', waiting: waiting.length };
    if (lastRefreshAt && now - lastRefreshAt < minutes * 60000) return { refresh: false, reason: 'interval', waiting: waiting.length };
  }
  const candidates = waiting.filter((tab) => !tab.isActive && now - tab.appearedAt >= REFRESH_MIN_AGE_MS);
  if (candidates.length === 0) return { refresh: false, reason: 'no-candidate', waiting: waiting.length };
  const tab = candidates.reduce((oldest, current) => (current.appearedAt < oldest.appearedAt ? current : oldest));
  return { refresh: true, reason: 'ok', tab, waiting: waiting.length, ageMinutes: Math.floor((now - tab.appearedAt) / 60000) };
}
module.exports = {
  targetCount, readConfig, readSnapshot, createOwnershipLease, isWaitingTab, createPool,
  REFRESH_MIN_AGE_MS, decideRefresh, readRefreshConfig, readLastRefreshAt, inRefreshHours,
};
