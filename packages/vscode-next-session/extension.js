const vscode = require('vscode');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  readConfig, createOwnershipLease, createPool, isWaitingTab, decideRefresh,
  readRefreshConfig, readLastRefreshAt, inRefreshHours,
} = require('./mobile-pool');
const { resolveClaudeShellPath } = require('./shell-path');
const { decideAction, orderMobileOpenMethods } = require('./route');

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
      if (claudeTabs().length > previousCount) {
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
let lastGoodMethod;
let lastLoggedState = '';
const EXTERNAL_OPEN_URI = 'vscode://Anthropic.claude-code/open';
function log(message) { getOutputChannel().appendLine(`${new Date().toISOString()} ${message}`); }
let lastRefreshAt = null;
try { lastRefreshAt = readLastRefreshAt(mobileHome); } catch { lastRefreshAt = null; }
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
  for (const tab of [...tabAppearedAt.keys()]) if (!current.includes(tab)) tabAppearedAt.delete(tab);
  return current;
}
// リフレッシュ判定（ownership lease を持つウィンドウだけ）。force=true は URI の refresh=1。
async function refreshWaitingTab({ force = false } = {}) {
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
    tabs: current.map((tab) => ({ label: String(tab.label), appearedAt: tabAppearedAt.get(tab), isActive: Boolean(tab.isActive), tab })),
  });
  if (!decision.refresh) return false;
  const target = decision.tab;
  if (target.tab.isActive) return false; // 閉じる直前に再確認（kim が触っている可能性）
  log(`mobile refresh closed=${target.label} age=${decision.ageMinutes} waitingBefore=${decision.waiting}`);
  lastRefreshAt = now;
  const closed = await vscode.window.tabGroups.close(target.tab);
  if (!closed) log('mobile refresh: タブを閉じられませんでした');
  await pool.ensure(mobileTarget); // 補充は 5 秒タイマーでも動くが、ここで即時に回す
  return closed;
}
function vscodeMobileTabs() {
  const value = vscode.workspace.getConfiguration('orgiast.nextSession').get('mobileTabs');
  return Number.isInteger(value) && value >= 1 ? value : 1;
}
const OPEN_METHODS = {
  newConversation: () => vscode.commands.executeCommand('claude-vscode.newConversation'),
  editorOpen: () => vscode.commands.executeCommand('claude-vscode.editor.open'),
  externalUri: () => vscode.env.openExternal(vscode.Uri.parse(EXTERNAL_OPEN_URI)),
};
// 1 回の試行: 手段を順に試し、Claude タブ総数が増えた時点で成功（各手段 openWaitMs 待つ）。
async function openMobileTab() {
  // タブが 0 本のとき newConversation は使用済み会話を開き直し得るので editor.open を先にする。
  const order = orderMobileOpenMethods(claudeTabs().length === 0 && !lastGoodMethod ? 'editorOpen' : lastGoodMethod);
  for (const method of order) {
    const beforeTabs = new Set(claudeTabs());
    const before = beforeTabs.size;
    let error;
    try { await OPEN_METHODS[method](); } catch (e) { error = e instanceof Error ? e.message : String(e); }
    const created = error ? false : await waitForNewClaudeTab(before);
    const after = claudeTabs();
    const newLabels = after.filter((tab) => !beforeTabs.has(tab)).map((tab) => String(tab.label));
    log(`mobile open method=${method} before=${before} after=${after.length} ok=${created} newLabels=${JSON.stringify(newLabels)}${error ? ` error=${error}` : ''}`);
    if (created) { lastGoodMethod = method; return true; }
  }
  return false;
}
const pool = createPool({
  tabs: claudeTabs,
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

  const refill = () => {
    if (mobileEnabled) pool.ensure(mobileTarget).catch((error) => log(`mobile refill failed: ${error.message}`));
  };
  context.subscriptions.push(vscode.window.tabGroups.onDidChangeTabs(() => { syncTabTimes(); refill(); }));
  const timer = setInterval(refill, 5000);
  // 起動時に既存タブの出現時刻を初期化し、以後 opened は onDidChangeTabs 経由の sync で記録する。
  syncTabTimes();
  const refreshTimer = setInterval(
    () => refreshWaitingTab().catch((error) => log(`mobile refresh failed: ${error.message}`)), 60000);
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
          if (!await waitForCommand('claude-vscode.newConversation')) {
            getOutputChannel().appendLine(`${new Date().toISOString()} mobile tabs: claude-vscode.newConversation が 60 秒以内に登録されなかったため補充しません`);
            return;
          }
          await ensureMobileTabs({ count: mobileTabs, name, attempts: 12 });
        })
        .catch((error) => getOutputChannel().appendLine(`${new Date().toISOString()} mobile tabs activation failed: ${error instanceof Error ? error.message : String(error)}`));
    }
  }
}

function deactivate() { mobileLease.release(); }

module.exports = { activate, deactivate, ensureMobileTabs, setOpenWaitMs(ms) { openWaitMs = ms; } };
