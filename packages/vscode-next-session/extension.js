const vscode = require('vscode');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  readConfig, createOwnershipLease, createPool, isWaitingTab, decideRefresh,
  readRefreshConfig, readLastRefreshAt, inRefreshHours, isWorktreeFolder, decideWorktreeCleanup,
  decideTrimExcess,
} = require('./mobile-pool');
const { resolveClaudeShellPath } = require('./shell-path');
const { decideAction, orderMobileOpenMethods } = require('./route');

const { readRows, createToolRunner, createArchiveWatcher } = require('./archive-tabs');
const { parseEditorMemento, selectTabsToClose, planClose } = require('./tab-sessions.cjs');
const { titleMatches } = require('./archive-tab-match');
const { execFile } = require('node:child_process');

const PROBE_TEXT = 'ORGIAST_NEXT_SESSION_PROBE_OK';

// 遅延生成する出力チャンネル（dry run の記録用）。
let outputChannel;
function getOutputChannel() {
  if (!outputChannel) {
    outputChannel = vscode.window.createOutputChannel('Orgiast Next Session');
  }
  return outputChannel;
}

function probeTerminalOptions(cwd) {
  if (process.platform === 'win32') {
    return {
      name: 'Orgiast next session probe',
      shellPath: process.env.ComSpec || 'cmd.exe',
      shellArgs: ['/d', '/s', '/c', `echo ${PROBE_TEXT}`],
      cwd,
    };
  }
  return {
    name: 'Orgiast next session probe',
    shellPath: '/bin/sh',
    shellArgs: ['-c', `printf '%s\\n' '${PROBE_TEXT}'`],
    cwd,
  };
}

function claudeTabs() {
  return vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .filter((tab) => tab.input instanceof vscode.TabInputWebview
      && String(tab.input.viewType).includes('claudeVSCode'));
}

let openWaitMs = 5000;
function waitForNewClaudeTab(previousCount, timeoutMs = openWaitMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (claudeTabs().length < previousCount) {
        clearInterval(timer);
        resolve(false);
      } else if (claudeTabs().length > previousCount) {
        clearInterval(timer);
        resolve(true);
      } else if (Date.now() - started >= timeoutMs) {
        clearInterval(timer);
        resolve(false);
      }
    }, 200);
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForCommand(command, timeoutMs = 60000, intervalMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if ((await vscode.commands.getCommands(true)).includes(command)) return true;
    await delay(intervalMs);
  }
  return false;
}

const mobileHome = process.env.ORGIAST_HOME || os.homedir();
const mobileLease = createOwnershipLease();
let mobileTarget = 1;
let mobileEnabled = false;
let worktreeWindow = false; // workspaceFolders が全て git worktree のウィンドウ（待機タブを担わない）
let lastLoggedState = '';
/** @type {Set<import('vscode').Tab>} この exthost が開いたタブ。閉じてよいタブの識別に使う。 */
const openedTabs = new Set();
/** 安全装置: どの方式でもタブ総数が減ったら二度と開かない */
let mobileAborted = false;
const EXTERNAL_OPEN_URI = 'vscode://Anthropic.claude-code/open';
function log(message) { getOutputChannel().appendLine(`${new Date().toISOString()} ${message}`); }
let lastRefreshAt = null;
try { lastRefreshAt = readLastRefreshAt(mobileHome); } catch { lastRefreshAt = null; }
// --- アーカイブ済み・クローズ済みタブ自動クローズ ---
function matchMementoTitle(vscodeLabel, mementoTtitle) {
  return titleMatches(vscodeLabel, mementoTtitle);
}

function runReadTabState(workspaceStorageDir, globalStorageDir, homeDir) {
  return new Promise((resolve) => {
    const script = path.join(path.dirname(__filename), 'read-tab-state.mjs');
    execFile('node', [script, workspaceStorageDir, globalStorageDir, homeDir], {
      windowsHide: true, timeout: 15000, maxBuffer: 512 * 1024,
    }, (error, stdout) => {
      if (error) { log(`read-tab-state failed: ${error.message}`); resolve(null); return; }
      try { resolve(JSON.parse(stdout)); } catch (e) { log(`read-tab-state parse error: ${e.message}`); resolve(null); }
    });
  });
}

function isClaudeTab(tab) {
  return tab.input instanceof vscode.TabInputWebview && String(tab.input.viewType).includes('claudeVSCode');
}

async function closeArchivedTabs(context) {
  if (worktreeWindow) return;
  const config = vscode.workspace.getConfiguration('orgiast.nextSession');
  if (!config.get('closeArchivedTabs', true)) return;
  const apData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const globalStorageDir = path.join(apData, 'Code', 'User', 'globalStorage');
  let workspaceStorageDir = null;
  if (context.storageUri) {
    workspaceStorageDir = path.dirname(context.storageUri.fsPath);
  }
  if (!workspaceStorageDir) { log('closeArchivedTabs: no workspace storage URI, skipping'); return; }
  const state = await runReadTabState(workspaceStorageDir, globalStorageDir, mobileHome);
  if (!state) return;
  const { tabs, hiddenSessionIds, closedSessionIds } = state;
  if (!tabs.length && !hiddenSessionIds.length && !closedSessionIds.length) return;

  const keepEmpty = typeof config.get('mobileTabs') === 'number' && config.get('mobileTabs') >= 0
    ? config.get('mobileTabs') : 3;
  const liveTabsByGroup = vscode.window.tabGroups.all.map(g => g.tabs || []);
  const plan = planClose({
    mementoTabs: tabs,
    liveTabsByGroup,
    hiddenIds: hiddenSessionIds,
    closedIds: closedSessionIds,
    keepEmpty,
    openedTabs,
  });

  if (plan.toClose.length > 0) {
    await vscode.window.tabGroups.close(plan.toClose);
  }
  const parts = [];
  if (plan.hidden > 0) parts.push(`hidden=${plan.hidden}`);
  if (plan.closed > 0) parts.push(`closed=${plan.closed}`);
  if (plan.emptyExtra > 0) parts.push(`empty-extra=${plan.emptyExtra}`);
  if (plan.skipped > 0) parts.push(`skipped=${plan.skipped}`);
  if (parts.length) log(`closeArchivedTabs: ${parts.join(' ')}`);
}

function vscodeRefreshConfig() {
  const config = vscode.workspace.getConfiguration('orgiast.nextSession');
  return { minutes: config.get('mobileRefreshMinutes'), hours: config.get('mobileRefreshHours') };
}
// タブ出現時刻のマップ。Tab オブジェクトは拡張ホスト内で同一タブに対し同一インスタンスが
// 使い回される前提でオブジェクト自体をキーにする。同一性が崩れた場合は「新規出現」扱い
// （出現時刻=現在）になり、age が短く見えるだけで誤って古いタブを閉じることは無い（安全側）。
// 閉じたタブは sync で削除する。起動時に既存のタブは activate 時刻で初期化する。
const tabAppearedAt = new Map();
function syncTabTimes(now = Date.now()) {
  const current = claudeTabs();
  for (const tab of current) if (!tabAppearedAt.has(tab)) tabAppearedAt.set(tab, now);
  for (const tab of openedTabs) if (!current.includes(tab) || !isWaitingTab(tab)) openedTabs.delete(tab);
  for (const tab of [...tabAppearedAt.keys()]) if (!current.includes(tab)) tabAppearedAt.delete(tab);
  return current;
}
function hasUserMessageInProjects(home, sessionId) {
  if (!sessionId) return undefined;
  const projectsDir = path.join(home, '.claude', 'projects');
  try {
    const dirs = fs.readdirSync(projectsDir, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('_'));
    for (const d of dirs) {
      const file = path.join(projectsDir, d.name, `${sessionId}.jsonl`);
      if (fs.existsSync(file)) {
        const text = fs.readFileSync(file, 'utf8');
        return text.includes('"type":"user"');
      }
    }
  } catch { /* ignored */ }
  return undefined;
}

let trimRunning = false;
async function trimWaitingExcess(context) {
  if (worktreeWindow || mobileAborted || trimRunning) return false;
  if (!mobileEnabled || !await mobileLease.acquire()) return false;
  const now = Date.now();
  const current = syncTabTimes(now);
  const waiting = current.filter(isWaitingTab);
  if (waiting.length <= mobileTarget) return false;

  trimRunning = true;
  try {
    const apData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    const globalStorageDir = path.join(apData, 'Code', 'User', 'globalStorage');
    let workspaceStorageDir = null;
    if (context?.storageUri) {
      workspaceStorageDir = path.dirname(context.storageUri.fsPath);
    }
    const state = workspaceStorageDir ? await runReadTabState(workspaceStorageDir, globalStorageDir, mobileHome) : null;
    const mementoTabs = state?.tabs || [];

    const tabMap = new Map();
    const liveGroups = vscode.window.tabGroups.all;
    for (let g = 0; g < liveGroups.length; g++) {
      const gTabs = liveGroups[g].tabs || [];
      for (let i = 0; i < gTabs.length; i++) {
        const liveTab = gTabs[i];
        const m = mementoTabs.find(t => t.group === g && t.index === i);
        tabMap.set(liveTab, m?.sessionId ?? null);
      }
    }

    const candidateItems = current.map((tab) => {
      const sessionId = tabMap.get(tab);
      const hasUserMessage = sessionId ? hasUserMessageInProjects(mobileHome, sessionId) : undefined;
      return {
        label: String(tab.label),
        appearedAt: tabAppearedAt.get(tab),
        isActive: Boolean(tab.isActive),
        hasUserMessage,
        tab,
      };
    });

    const toClose = decideTrimExcess({ tabs: candidateItems, target: mobileTarget, now });
    if (!toClose.length) return false;

    let closedAny = false;
    for (const item of toClose) {
      if (mobileAborted || item.tab.isActive) continue;
      const ageMinutes = Math.floor((now - (item.appearedAt ?? now)) / 60000);
      log(`mobile trim closed=${item.label} age=${ageMinutes} waitingBefore=${waiting.length}`);
      const closed = await vscode.window.tabGroups.close(item.tab);
      if (closed) closedAny = true;
    }
    return closedAny;
  } catch (error) {
    log(`mobile trim failed: ${error.message}`);
    return false;
  } finally {
    trimRunning = false;
  }
}

// リフレッシュ判定（ownership lease を持つウィンドウだけ）。force=true は URI の refresh=1。
let refreshRunning = false;
async function refreshWaitingTab(options = {}) {
  if (mobileAborted || refreshRunning) return false;
  refreshRunning = true;
  try { return await performRefresh(options); }
  finally { refreshRunning = false; }
}
async function performRefresh({ force = false } = {}) {
  if (worktreeWindow) return false; // worktree ウィンドウはリーズを取らない
  if (!mobileEnabled || !await mobileLease.acquire()) return false;
  const now = Date.now();
  const current = syncTabTimes(now);
  let config;
  try { config = readRefreshConfig(mobileHome, process.env, vscodeRefreshConfig()); }
  catch (error) { log(`mobile refresh config error: ${error.message}`); return false; }
  const decision = decideRefresh({
    now,
    minutes: config.minutes,
    hoursOk: inRefreshHours(new Date(now), config.hours),
    lastRefreshAt,
    target: mobileTarget,
    force,
    tabs: current.map((tab) => ({
      label: String(tab.label),
      appearedAt: tabAppearedAt.get(tab),
      isActive: Boolean(tab.isActive),
      rcConnected: false, // Placeholder — RC 拡張 API が提供する予定
      rcLastActivityAt: null, // Placeholder
      tab,
    })),
    openedTabs,
  });
  if (!decision.refresh) return false;
  const target = decision.tab;
  if (mobileAborted || !openedTabs.has(target.tab) || !isWaitingTab(target.tab) || target.tab.isActive) return false; // 閉じる直前に再確認（kim が触っている可能性）
  log(`mobile refresh closed=${target.label} age=${decision.ageMinutes} waitingBefore=${decision.waiting}`);
  lastRefreshAt = now;
  const closed = await vscode.window.tabGroups.close(target.tab);
  if (!closed) log('mobile refresh: タブを閉じられませんでした');
  await pool.ensure(mobileTarget); // 補充は 5 秒タイマーでも動くが、ここで即時に回す
  return closed;
}
function vscodeMobileTabs() {
  const value = vscode.workspace.getConfiguration('orgiast.nextSession').get('mobileTabs');
  return Number.isInteger(value) && value >= 1 ? value : 3;
}
const OPEN_METHODS = {
  externalUri: () => vscode.env.openExternal(vscode.Uri.parse(EXTERNAL_OPEN_URI)),
};
// 1 回の試行: 手段を順に試し、Claude タブ総数が増えた時点で成功（各手段 openWaitMs 待つ）。
async function openMobileTab() {
  if (mobileAborted) return false;
  // externalUri だけを使う（editorOpen / newConversation は危険: 2026-11-13 実害）。
  // 常に 1 手段だけなのでループは実質 1 回だが、安全装置（タブ減少検出）を共有するため構造を維持。
  const order = orderMobileOpenMethods();
  for (const method of order) {
    const beforeTabs = new Set(claudeTabs());
    const before = beforeTabs.size;
    let error;
    try { await OPEN_METHODS[method](); } catch (e) { error = e instanceof Error ? e.message : String(e); }
    const created = error ? false : await waitForNewClaudeTab(before);
    const after = claudeTabs();
    if (after.length < before) {
      // タブが減った → この拡張の生存中は補充停止
      mobileAborted = true;
      log(`mobile open ABORT: Claude タブが減少 before=${before} after=${after.length}`);
      return false;
    }
    const newLabels = after.filter((tab) => !beforeTabs.has(tab)).map((tab) => String(tab.label));
    log(`mobile open method=${method} before=${before} after=${after.length} ok=${created} newLabels=${JSON.stringify(newLabels)}${error ? ` error=${error}` : ''}`);
    if (created) {
      // 新しく出現したタブを追跡（この exthost の閉鎖対象として記録）
      for (const tab of after) {
        if (!beforeTabs.has(tab) && isWaitingTab(tab)) openedTabs.add(tab);
      }
      return true;
    }
  }
  return false;
}
const pool = createPool({
  tabs: claudeTabs,
  stopped: () => mobileAborted,
  own: () => mobileLease.acquire(),
  publish(waiting, target) {
    fs.mkdirSync(path.join(mobileHome, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(mobileHome, '.claude', 'mobile-sessions-state.json'),
      JSON.stringify({ waiting, target, updatedAt: Date.now(), pid: process.pid, ...(lastRefreshAt ? { lastRefreshAt } : {}) }));
    const state = `${waiting}/${target}`;
    if (state !== lastLoggedState) { lastLoggedState = state; log(`mobile tabs: waiting=${waiting} target=${target}`); }
  },
  open: openMobileTab,
});
async function ensureMobileTabs({ count = readConfig(mobileHome, process.env, vscodeMobileTabs()) } = {}) {
  if (mobileAborted) return;
  if (worktreeWindow) return; // worktree ウィンドウは補充しない（通常ウィンドウの 5 秒タイマーが担う）
  mobileTarget = count;
  mobileEnabled = true;
  return pool.ensure(count);
}

function activate(context) {
  const handler = vscode.window.registerUriHandler({
    async handleUri(uri) {
      try {
        const params = new URLSearchParams(uri.query);
        const action = decideAction({ path: uri.path, query: params });
        if (action.kind === 'reload') {
          if (action.dry) {
            const channel = getOutputChannel();
            channel.appendLine(`${new Date().toISOString()} dry reload requested (再読み込みは実行しません)`);
            await vscode.window.showInformationMessage('Dry reload: 記録のみ（再読み込みはしません）');
            return;
          }
          await vscode.commands.executeCommand('workbench.action.reloadWindow');
          return;
        }
        if (action.kind === 'mobile') {
          await ensureMobileTabs(action);
          if (action.refresh) await refreshWaitingTab({ force: true });
          return;
        }
        const cwd = params.get('cwd') || undefined;
        const probe = params.get('probe') === '1';
        const resolved = probe ? null : resolveClaudeShellPath(params.get('claude'));
        if (resolved?.ignored) {
          await vscode.window.showWarningMessage('指定された実行ファイルを無視しました。PATH 上の claude を使用します。');
        }
        const options = probe
          ? probeTerminalOptions(cwd)
          : {
              name: 'Claude (next session)',
              shellPath: resolved.shellPath,
              shellArgs: [params.get('prompt') || '/session-start'],
              cwd,
            };
        const terminal = vscode.window.createTerminal(options);
        terminal.show();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await vscode.window.showErrorMessage(`Orgiast next session の起動に失敗しました: ${message}`);
      }
    },
  });
  context.subscriptions.push(handler);

  const archiveWatcher = createArchiveWatcher({
    tabs: claudeTabs, close: tab => vscode.window.tabGroups.close(tab),
    read: () => readRows(path.join(mobileHome, '.claude')),
    run: createToolRunner(mobileHome, log), log,
  });
  const archiveTimer = setInterval(() => void archiveWatcher.check(), 30000);
  archiveTimer?.unref?.();
  context.subscriptions.push({ dispose() { clearInterval(archiveTimer); archiveWatcher.dispose(); } });
  const folders = vscode.workspace.workspaceFolders || [];
  worktreeWindow = folders.length > 0 && folders.every((folder) => isWorktreeFolder(folder.uri?.fsPath));
  if (worktreeWindow) {
    // git worktree 専用ウィンドウは待機タブのリーズ・補充を担わない。過去にこのウィンドウが
    // 作った未使用待機タブ（ラベル 'Claude Code' で非アクティブ）は閉じて通常ウィンドウに任せる。
    // 会話が始まったタブ（ラベルが変わった・アクティブ）は絶対に閉じない。
    syncTabTimes();
    const cleanup = (startup) => {
      if (!vscode.window.tabGroups.close) return;
      const current = syncTabTimes();
      const decision = decideWorktreeCleanup({
        tabs: current.map((tab) => ({
          label: String(tab.label),
          appearedAt: tabAppearedAt.get(tab),
          isActive: Boolean(tab.isActive),
          rcConnected: false, // Placeholder — RC 拡張 API が提供する予定
          rcLastActivityAt: null, // Placeholder
          tab,
        })),
        startup,
        openedTabs,
      });
      if (!decision) return;
      log(`mobile worktree cleanup closed=${decision.tab.label} startup=${startup}`);
      vscode.window.tabGroups.close(decision.tab).catch((error) => log(`mobile worktree cleanup failed: ${error instanceof Error ? error.message : String(error)}`));
    };
    cleanup(true);
    const cleanupTimer = setInterval(() => cleanup(false), 60000);
    cleanupTimer?.unref?.();
    context.subscriptions.push(vscode.window.tabGroups.onDidChangeTabs(event => { archiveWatcher.change(event); syncTabTimes(); }));
    context.subscriptions.push({ dispose() { clearInterval(cleanupTimer); } });
    return;
  }
  const refill = () => {
    if (mobileEnabled) {
      pool.ensure(mobileTarget).catch((error) => log(`mobile refill failed: ${error.message}`));
      trimWaitingExcess(context).catch((error) => log(`mobile trim failed: ${error.message}`));
    }
  };
  context.subscriptions.push(vscode.window.tabGroups.onDidChangeTabs(event => { archiveWatcher.change(event); syncTabTimes(); refill(); }));
  const timer = setInterval(refill, 5000);
  // 起動時に既存タブの出現時刻を初期化し、以後 opened は onDidChangeTabs 経由の sync で記録する。
  syncTabTimes();
  trimWaitingExcess(context).catch((error) => log(`mobile trim startup failed: ${error.message}`));
  const refreshTimer = setInterval(
    () => {
      refreshWaitingTab().catch((error) => log(`mobile refresh failed: ${error.message}`));
      trimWaitingExcess(context).catch((error) => log(`mobile trim failed: ${error.message}`));
    }, 60000);
  refreshTimer?.unref?.();
  context.subscriptions.push({ dispose() { clearInterval(timer); clearInterval(refreshTimer); mobileLease.release(); } });
  const configuredTabs = vscode.workspace.getConfiguration('orgiast.nextSession').get('mobileTabs');
  const mobileTabs = configuredTabs === 0 ? 0 : readConfig(mobileHome, process.env, vscodeMobileTabs());
  if (mobileTabs > 0) {
    const name = vscode.workspace.getConfiguration('orgiast.nextSession').get('mobileTabName', 'スマホ用セッション');
    const claudeExtension = vscode.extensions.getExtension('Anthropic.claude-code');
    if (!claudeExtension) {
      getOutputChannel().appendLine(`${new Date().toISOString()} mobile tabs: Anthropic.claude-code が未導入のため補充しません`);
    } else {
      claudeExtension.activate()
        .then(async () => {
          await ensureMobileTabs({ count: mobileTabs, name, attempts: 12 });
        })
        .catch((error) => getOutputChannel().appendLine(`${new Date().toISOString()} mobile tabs activation failed: ${error instanceof Error ? error.message : String(error)}`));
    }
  }
  // アーカイブ済み・クローズ済みタブの自動クローズ（起動 15 秒後、以後 5 分ごと）
  const closeTimerStart = setTimeout(() => {
    closeArchivedTabs(context).catch((error) => log(`closeArchivedTabs startup: ${error.message}`));
  }, 15000);
  closeTimerStart?.unref?.();
  const closeTimerInterval = setInterval(() => {
    closeArchivedTabs(context).catch((error) => log(`closeArchivedTabs interval: ${error.message}`));
  }, 300000);
  closeTimerInterval?.unref?.();
  context.subscriptions.push({ dispose() { clearTimeout(closeTimerStart); clearInterval(closeTimerInterval); } });
}

function deactivate() { mobileLease.release(); }

module.exports = { activate, deactivate, ensureMobileTabs, setOpenWaitMs(ms) { openWaitMs = ms; } };