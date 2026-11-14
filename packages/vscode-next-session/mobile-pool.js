const { targetCount, readConfig, readSnapshot, readRefreshConfig, readLastRefreshAt, inRefreshHours } = require('./mobile-state.cjs');
const { newRetryState, canAttemptMobileOpen, recordMobileOpenAttempt } = require('./route');
const fs = require('node:fs');
const path = require('node:path');

// git worktree 判定（tools/reopen-lost-sessions.mjs の resolveReopenFolder と同じ基準。
// 拡張ホストでは git を呼ばず fs だけで判定する）。フォルダ自身か祖先に `.git` ファイルが
// あり内容の gitdir: が `...worktrees/...` を含む、または正規化パスが `\.claude\worktrees\`
// を含む場合に worktree。`.git` ディレクトリ（メイン checkout）に到達したら打ち切って false。
function isWorktreeFolder(folder, fsImpl = fs) {
  if (typeof folder !== 'string' || !folder) return false;
  const norm = folder.replace(/\//g, '\\').toLowerCase();
  if (norm.includes('\\.claude\\worktrees\\')) return true;
  let dir = path.resolve(folder);
  while (true) {
    const gitPath = path.join(dir, '.git');
    try {
      const stat = fsImpl.statSync(gitPath);
      if (stat.isFile()) {
        const content = fsImpl.readFileSync(gitPath, 'utf8');
        if (/gitdir\s*:\s*[^\r\n]*worktrees/i.test(content)) return true;
        return false; // 通常の gitdir ファイル（サブモジュール等）は worktree ではない
      }
      if (stat.isDirectory()) return false; // メイン checkout 配下。worktree ではない
    } catch { /* この階層に .git は無い: 親へ */ }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return false;
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
function createPool({ tabs, open, publish, own = () => true, stopped = () => false, now = Date.now }) {
  let running;
  let retry = newRetryState();
  return {
    ensure(count) {
      if (stopped()) return Promise.resolve();
      if (running) return running;
      running = (async () => {
        if (!await own() || stopped()) return;
        let waiting = tabs().filter(isWaitingTab).length;
        publish(waiting, count);
        while (!stopped() && waiting < count) {
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
const RC_IN_USE_THRESHOLD_MS = 30 * 60000; // RC 最終操作から 30 分未満は使用中とみなす
// tabs: [{ label, appearedAt, isActive, rcConnected, rcLastActivityAt, tab }]。force=true（URI の refresh=1）は時間帯・間隔・無効設定を無視する。
// 不足中（待機数 < target）は常に no。補充を優先する。
// openedTabs: この exthost が openMobileTab() で開いたタブの Set。自分で開いていないタブは閉じない。
function decideRefresh({ now, minutes, hoursOk, lastRefreshAt, target, tabs, force = false, openedTabs }) {
  const waiting = tabs.filter(isWaitingTab);
  if (waiting.length < target) return { refresh: false, reason: 'shortage', waiting: waiting.length };
  if (!force) {
    if (!(minutes > 0)) return { refresh: false, reason: 'disabled', waiting: waiting.length };
    if (!hoursOk) return { refresh: false, reason: 'outside-hours', waiting: waiting.length };
    if (lastRefreshAt && now - lastRefreshAt < minutes * 60000) return { refresh: false, reason: 'interval', waiting: waiting.length };
  }
  const candidates = waiting.filter((tab) => {
    // 所有記録がない場合も閉じない（安全側）。
    if (!tab.tab || !openedTabs?.has(tab.tab)) return false;
    if (tab.isActive) return false;
    if (now - tab.appearedAt < REFRESH_MIN_AGE_MS) return false;
    // RC で使用中のタブはリフレッシュ対象外
    if (tab.rcConnected) return false;
    if (tab.rcLastActivityAt && now - tab.rcLastActivityAt < RC_IN_USE_THRESHOLD_MS) return false;
    return true;
  });
  if (candidates.length === 0) return { refresh: false, reason: 'no-candidate', waiting: waiting.length };
  const tab = candidates.reduce((oldest, current) => (current.appearedAt < oldest.appearedAt ? current : oldest));
  return { refresh: true, reason: 'ok', tab, waiting: waiting.length, ageMinutes: Math.floor((now - tab.appearedAt) / 60000) };
}
// --- worktree ウィンドウの待機タブ掃除（純粋関数） ---
// git worktree 専用ウィンドウは待機タブの補充を担わないが、過去にリーズを取って作った
// 未使用待機タブは閉じて通常ウィンドウの補充に任せる。閉じるのは待機タブ（ラベル 'Claude Code'）
// かつ非アクティブなものだけ。会話が始まったタブ（ラベルが変わった・アクティブ）は絶対に閉じない。
// startup=true（ウィンドウ起動直後）は古さ不問で 1 本。それ以外は decideRefresh と同じ 10 分以上。
// tabs: [{ label, appearedAt, isActive, tab }]。閉じるタブが無ければ null。
function decideWorktreeCleanup({ tabs, now = Date.now(), startup = false, openedTabs }) {
  const waiting = tabs.filter(isWaitingTab);
  const candidates = waiting.filter((tab) => {
    // 所有記録がない場合も閉じない（安全側）。
    if (!tab.tab || !openedTabs?.has(tab.tab)) return false;
    return !tab.isActive && (startup || now - (tab.appearedAt ?? 0) >= REFRESH_MIN_AGE_MS);
  });
  if (!candidates.length) return null;
  return candidates.reduce((oldest, current) => ((current.appearedAt ?? 0) < (oldest.appearedAt ?? 0) ? current : oldest));
}
module.exports = {
  targetCount, readConfig, readSnapshot, createOwnershipLease, isWaitingTab, createPool,
  REFRESH_MIN_AGE_MS, RC_IN_USE_THRESHOLD_MS, decideRefresh, readRefreshConfig, readLastRefreshAt, inRefreshHours,
  isWorktreeFolder, decideWorktreeCleanup,
};
