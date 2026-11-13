const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPool, createOwnershipLease, readConfig, readSnapshot, isWorktreeFolder, decideRefresh, decideWorktreeCleanup, REFRESH_MIN_AGE_MS } = require('./mobile-pool');

// git worktree を模した一時フォルダ（.git ファイルが gitdir: .../worktrees/... を指す）
function makeWorktree(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-worktree-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const mainDir = path.join(root, 'repo-main');
  const wtDir = path.join(root, '.claude', 'worktrees', 'mail-approval-gate-fix');
  fs.mkdirSync(wtDir, { recursive: true });
  fs.writeFileSync(path.join(wtDir, '.git'),
    `gitdir: ${path.join(mainDir, '.git', 'worktrees', 'mail-approval-gate-fix').replace(/\\/g, '/')}\n`, 'utf8');
  return { root, mainDir, wtDir };
}

test('isWorktreeFolder: \\.claude\\worktrees\\ パス・.git ファイル・祖先遡りで worktree を検出し、通常フォルダは false', (t) => {
  const { root, mainDir, wtDir } = makeWorktree(t);
  // 正規化パスの worktrees 検出（実ファイル不要）
  assert.equal(isWorktreeFolder('C:\\Users\\uers\\.claude\\worktrees\\mail-approval-gate-fix'), true);
  // .git ファイルの gitdir 検出
  assert.equal(isWorktreeFolder(wtDir), true);
  // worktree のサブディレクトリ（祖先を遡る）
  const sub = path.join(wtDir, 'src', 'deep');
  fs.mkdirSync(sub, { recursive: true });
  assert.equal(isWorktreeFolder(sub), true);
  // メイン checkout（.git ディレクトリ）と通常フォルダは false
  fs.mkdirSync(path.join(mainDir, '.git'), { recursive: true });
  assert.equal(isWorktreeFolder(mainDir), false);
  assert.equal(isWorktreeFolder(path.join(root, 'plain')), false);
  assert.equal(isWorktreeFolder(''), false);
  // fsImpl 差し替え: .git が出てこないフォルダは worktree 扱いしない
  const fakeFs = { statSync: () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); } };
  assert.equal(isWorktreeFolder(path.join(root, 'fake', 'deep', 'child'), fakeFs), false);
});

test('decideWorktreeCleanup: 起動時は未使用待機タブを古さ不問で 1 本閉じる', () => {
  const now = 1000000;
  const tabs = [
    { tab: {}, label: 'Claude Code', appearedAt: now - 60000, isActive: false, id: 'unused' },
    { tab: {}, label: 'Claude Code', appearedAt: now - 500000, isActive: false, id: 'other' },
    { label: '作業中', appearedAt: now - 999999, isActive: false, id: 'used' },
  ];
  const decision = decideWorktreeCleanup({ tabs, now, openedTabs: new Set(tabs.map(t => t.tab)), startup: true });
  // 最古の待機タブを選ぶ（作業中タブは対象外）
  assert.equal(decision.id, 'other');
});

test('decideWorktreeCleanup: 定期は 10 分未満・アクティブ・会話中タブは閉じない', () => {
  const now = 1000000;
  const tabs = [
    { tab: {}, label: 'Claude Code', appearedAt: now - 5 * 60000, isActive: false, id: 'young' },
    { tab: {}, label: 'Claude Code', appearedAt: now - 300 * 60000, isActive: true, id: 'active' },
    { label: '実際の仕事', appearedAt: now - 999 * 60000, isActive: false, id: 'conversation' },
  ];
  assert.equal(decideWorktreeCleanup({ tabs, now, openedTabs: new Set(tabs.map(t => t.tab)), startup: false }), null);
  // 10 分以上・非アクティブな待機タブがあれば選ぶ
  tabs.push({ tab: {}, label: 'Claude Code', appearedAt: now - 11 * 60000, isActive: false, id: 'old' });
  assert.equal(decideWorktreeCleanup({ tabs, now, openedTabs: new Set(tabs.map(t => t.tab)), startup: false }).id, 'old');
  assert.equal(REFRESH_MIN_AGE_MS, 10 * 60000);
});

test('concurrent refill opens one; first prompt title change replenishes one', async () => {
  const tabs = [];
  let opens = 0;
  const states = [];
  const pool = createPool({ tabs: () => tabs, publish: (...args) => states.push(args), async open() {
    opens++;
    await new Promise((resolve) => setImmediate(resolve));
    tabs.push({ label: 'Claude Code' }); return true;
  } });
  await Promise.all([pool.ensure(1), pool.ensure(1), pool.ensure(1)]);
  assert.equal(opens, 1);
  tabs[0].label = '実際の仕事';
  await pool.ensure(1);
  assert.equal(opens, 2);
  await pool.ensure(1);
  assert.equal(opens, 2);
  assert.deepEqual(states.at(-1), [1, 1]);
});
test('excess tabs and used tabs are preserved; failure does not spawn in a loop', async () => {
  const tabs = [{ label: 'Claude Code' }, { label: 'Claude Code' }];
  let opens = 0;
  const pool = createPool({ tabs: () => tabs, publish() {}, async open() { opens++; return false; } });
  await pool.ensure(1);
  assert.equal(opens, 0);
  tabs.length = 0;
  await pool.ensure(1);
  assert.equal(opens, 1);
});
test('unacknowledged creation stops; non-owner never opens', async () => {
  let opens = 0;
  for (const owner of [false, true]) {
    const pool = createPool({ tabs: () => [], own: async () => owner, publish() {}, async open() { opens++; return true; } });
    await pool.ensure(3);
    assert.equal(opens, owner ? 1 : 0);
  }
});
test('socket ownership serializes windows and releases on close', async (t) => {
  const first = createOwnershipLease(0);
  t.after(() => first.release());
  assert.equal(await first.acquire(), true);
  const other = createOwnershipLease(first.port());
  t.after(() => other.release());
  assert.equal(await other.acquire(), false);
  first.release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await other.acquire(), true);
});
test('JSON/env configuration and stale snapshot are validated', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-config-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, '.claude'));
  assert.equal(readConfig(home, {}), 3);
  fs.writeFileSync(path.join(home, '.claude', 'mobile-sessions.json'), '{"count":2}');
  assert.equal(readConfig(home, {}), 2);
  assert.equal(readConfig(home, { CLAUDE_MOBILE_STANDBY: '3' }), 3);
  assert.throws(() => readConfig(home, { CLAUDE_MOBILE_STANDBY: '1junk' }));
  const file = path.join(home, '.claude', 'mobile-sessions-state.json');
  fs.writeFileSync(file, '{"waiting":1,"updatedAt":1000}');
  assert.equal(readSnapshot(home, 1001).waiting, 1);
  assert.equal(readSnapshot(home, 32000), null);
});

// The CLI is distributed as tools/ only; the extension must also be standalone.
test('CLI and VSIX state readers are byte-identical', () => {
  assert.equal(fs.readFileSync(path.join(__dirname, 'mobile-state.cjs'), 'utf8'),
    fs.readFileSync(path.join(__dirname, '../../tools/lib/mobile-state.cjs'), 'utf8'));
});

test('failure is retried only after the 30s cooldown (no permanent jam)', async () => {
  let opens = 0, now = 1000000;
  const pool = createPool({ tabs: () => [], publish() {}, now: () => now, async open() { opens++; return false; } });
  await pool.ensure(1);
  assert.equal(opens, 1);
  now += 29000;
  await pool.ensure(1);
  assert.equal(opens, 1);
  now += 1000;
  await pool.ensure(1);
  assert.equal(opens, 2);
});
test('five consecutive failures pause retries for 10 minutes', async () => {
  let opens = 0, now = 1000000;
  const pool = createPool({ tabs: () => [], publish() {}, now: () => now, async open() { opens++; return false; } });
  for (let i = 0; i < 5; i++) { await pool.ensure(1); now += 30000; }
  assert.equal(opens, 5);
  await pool.ensure(1);
  assert.equal(opens, 5);
  now += 600000;
  await pool.ensure(1);
  assert.equal(opens, 6);
});
test('at most 20 attempts per hour even when each one succeeds', async () => {
  let opens = 0, now = 1000000;
  const tabs = [];
  const pool = createPool({ tabs: () => tabs, publish() {}, now: () => now, async open() { opens++; tabs.push({ label: 'Claude Code' }); return true; } });
  for (let i = 0; i < 25; i++) { tabs.length = 0; await pool.ensure(1); now += 1000; }
  assert.equal(opens, 20);
  now += 3600000;
  tabs.length = 0;
  await pool.ensure(1);
  assert.equal(opens, 21);
});
test('config order: env > JSON > fallback (VS Code setting) > 3', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-order-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  assert.equal(readConfig(home, {}), 3);
  assert.equal(readConfig(home, {}, 4), 4);
  fs.mkdirSync(path.join(home, '.claude'));
  fs.writeFileSync(path.join(home, '.claude', 'mobile-sessions.json'), '{"count":2}');
  assert.equal(readConfig(home, {}, 4), 2);
  assert.equal(readConfig(home, { CLAUDE_MOBILE_STANDBY: '3' }, 4), 3);
});

// --- 自タブ（openedTabs）フィルタのテスト ---
const MIN = 60000;
const REFRESH_NOW = 1_000_000_000_000;
function refreshTab(ageMin, extra = {}) {
  return { label: 'Claude Code', appearedAt: REFRESH_NOW - ageMin * MIN, isActive: false, tab: extra.tab || {}, ...extra };
}

test('decideRefresh は openedTabs のタブだけ候補にする', () => {
  const selfTab = {};
  const otherTab = {};
  const base = { now: REFRESH_NOW, minutes: 60, hoursOk: true, lastRefreshAt: null, target: 1 };
  // 自分で開いたタブだけ候補になる
  const result1 = decideRefresh({
    ...base,
    tabs: [refreshTab(100, { tab: selfTab }), refreshTab(200, { tab: otherTab })],
    openedTabs: new Set([selfTab]),
  });
  assert.equal(result1.refresh, true);
  assert.equal(result1.tab.tab, selfTab);
  // 自分のタブが無ければ no-candidate
  const result2 = decideRefresh({
    ...base,
    tabs: [refreshTab(100, { tab: otherTab })],
    openedTabs: new Set([selfTab]),
  });
  assert.equal(result2.refresh, false);
  assert.equal(result2.reason, 'no-candidate');
});

test('decideWorktreeCleanup は openedTabs のタブだけ候補にする', () => {
  const selfTab = { id: 'self' };
  const otherTab = { id: 'other' };
  const tabs = [
    { label: 'Claude Code', appearedAt: REFRESH_NOW - 300 * MIN, isActive: false, tab: selfTab },
    { label: 'Claude Code', appearedAt: REFRESH_NOW - 200 * MIN, isActive: false, tab: otherTab },
  ];
  // 自分のタブだけが候補
  const result1 = decideWorktreeCleanup({
    tabs, now: REFRESH_NOW, startup: true,
    openedTabs: new Set([selfTab]),
  });
  assert(result1 !== null);
  assert.equal(result1.tab, selfTab);
  // 自分のタブが無ければ null
  const result2 = decideWorktreeCleanup({
    tabs, now: REFRESH_NOW, startup: true,
    openedTabs: new Set([]),
  });
  assert.equal(result2, null);
});

test('decideRefresh は openedTabs 無指定なら閉鎖しない', () => {
  const result = decideRefresh({
    now: REFRESH_NOW, minutes: 60, hoursOk: true, lastRefreshAt: null, target: 1,
    tabs: [refreshTab(100)],
  });
  assert.equal(result.refresh, false);
});

test('decideWorktreeCleanup は openedTabs 無指定なら閉鎖しない', () => {
  const result = decideWorktreeCleanup({
    tabs: [{ label: 'Claude Code', appearedAt: REFRESH_NOW - 300 * MIN, isActive: false, tab: {} }],
    now: REFRESH_NOW, startup: true,
  });
  assert.equal(result, null);
});
