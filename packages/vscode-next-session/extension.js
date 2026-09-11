const vscode = require('vscode');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveClaudeShellPath } = require('./shell-path');
const { decideAction, shouldRetryMobileTab, mobileTabOpenCommand, deadMobileTabCount } = require('./route');

const PROBE_TEXT = 'ORGIAST_NEXT_SESSION_PROBE_OK';

// 遅延生成する出力チャンネル（dry run の記録用）。
let outputChannel;
let healthCheckPromise;
let mobileOperation = Promise.resolve();
const pendingMobileRequests = new Map();
let disposed = false;
let lastHealthCheckAt = 0;
let focusDebounceTimer;
const HEALTH_CHECK_INTERVAL_MS = 10 * 60 * 1000;
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

function waitForNewClaudeTab(previousCount, timeoutMs = 5000) {
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

function interactiveSessionCount() {
  return new Promise((resolve, reject) => {
    const nativeCli = path.join(os.homedir(), '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude');
    const cli = fs.existsSync(nativeCli) ? nativeCli : 'claude';
    execFile(cli, ['agents', '--json'], { windowsHide: true, timeout: 10000 }, (error, stdout) => {
      if (error) return reject(error);
      try {
        const agents = JSON.parse(stdout);
        if (!Array.isArray(agents)) throw new Error('claude agents: expected an array');
        resolve(agents.filter((agent) => agent?.kind === 'interactive').length);
      } catch (parseError) { reject(parseError); }
    });
  });
}

async function closeMobileTab(tab) {
  try {
    if (await vscode.window.tabGroups.close(tab)) return true;
  } catch {}

  // Reveal by editor/group position, then verify identity before closing anything.
  try {
    const group = vscode.window.tabGroups.all.find((item) => item.tabs.includes(tab));
    if (!group) return true;
    await vscode.commands.executeCommand('workbench.action.focusFirstEditorGroup');
    for (let i = 0; vscode.window.tabGroups.activeTabGroup !== group && i < vscode.window.tabGroups.all.length; i += 1) {
      await vscode.commands.executeCommand('workbench.action.focusNextGroup');
    }
    if (vscode.window.tabGroups.activeTabGroup !== group) return false;
    await vscode.commands.executeCommand('workbench.action.firstEditorInGroup');
    for (let i = 0; group.activeTab !== tab && i < group.tabs.length; i += 1) {
      await vscode.commands.executeCommand('workbench.action.nextEditorInGroup');
    }
    if (vscode.window.tabGroups.activeTabGroup !== group || group.activeTab !== tab) return false;
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    return !vscode.window.tabGroups.all.some((item) => item.tabs.includes(tab));
  } catch { return false; }
}

async function recreateDeadMobileTabs({ name }) {
  const prefix = String(name || 'スマホ用セッション');
  let liveCount;
  try { liveCount = await interactiveSessionCount(); } catch (error) {
    getOutputChannel().appendLine(`${new Date().toISOString()} mobile health: claude agents failed: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  const labelled = claudeTabs().filter((tab) => String(tab.label).startsWith(prefix));
  const deadCount = deadMobileTabCount(labelled.length, liveCount);
  getOutputChannel().appendLine(`${new Date().toISOString()} mobile health: labelled=${labelled.length} interactive=${liveCount} dead=${deadCount}`);
  for (const tab of labelled.slice(labelled.length - deadCount)) {
    const label = String(tab.label);
    if (!await closeMobileTab(tab)) {
      getOutputChannel().appendLine(`${new Date().toISOString()} mobile health: could not close ${label}`);
      continue;
    }
    const before = claudeTabs().length;
    await vscode.commands.executeCommand('claude-vscode.newConversation');
    if (!await waitForNewClaudeTab(before)) {
      getOutputChannel().appendLine(`${new Date().toISOString()} mobile health: replacement did not open: ${label}`);
      break;
    }
    await vscode.commands.executeCommand('claude-vscode.renameSessionTab', label);
  }
}

// URI, startup and focus operations share one queue, including creation/rename.
function requestMobileTabs(options) {
  const key = JSON.stringify([options.count, options.name, Boolean(options.recreate)]);
  if (pendingMobileRequests.has(key)) return pendingMobileRequests.get(key);
  const operation = mobileOperation.then(async () => {
    if (disposed) return;
    if (options.recreate) {
      lastHealthCheckAt = Date.now();
      await recreateDeadMobileTabs(options);
    }
    await ensureMobileTabs(options);
  });
  const tracked = operation.finally(() => pendingMobileRequests.delete(key));
  pendingMobileRequests.set(key, tracked);
  mobileOperation = tracked.catch(() => {});
  return tracked;
}

function scheduleHealthCheck({ count, name, force = false, debounceMs = 2000 }) {
  if (disposed || healthCheckPromise) return;
  if (!force && Date.now() - lastHealthCheckAt < HEALTH_CHECK_INTERVAL_MS) return;
  if (focusDebounceTimer) clearTimeout(focusDebounceTimer);
  const scheduledAfter = lastHealthCheckAt;
  focusDebounceTimer = setTimeout(() => {
    focusDebounceTimer = undefined;
    if (disposed || healthCheckPromise) return;
    if (force && lastHealthCheckAt !== scheduledAfter) return;
    if (!force && Date.now() - lastHealthCheckAt < HEALTH_CHECK_INTERVAL_MS) return;
    healthCheckPromise = requestMobileTabs({ count, name, recreate: true, attempts: 12 })
      .catch((error) => getOutputChannel().appendLine(`${new Date().toISOString()} mobile health failed: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => { healthCheckPromise = undefined; });
  }, debounceMs);
}

async function waitForCommand(command, timeoutMs = 60000, intervalMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if ((await vscode.commands.getCommands(true)).includes(command)) return true;
    await delay(intervalMs);
  }
  return false;
}

async function ensureMobileTabs({ count, name, attempts = 1, retryDelayMs = 5000 }) {
  const channel = getOutputChannel();
  const targetCount = Math.min(10, Math.max(1, Number.parseInt(count, 10) || 3));
  const prefix = String(name || 'スマホ用セッション');
  const existing = claudeTabs().filter((tab) => String(tab.label).startsWith(prefix));
  const usedLabels = new Set(existing.map((tab) => String(tab.label)));
  let missing = targetCount - existing.length;
  channel.appendLine(`${new Date().toISOString()} mobile tabs: existing=${existing.length} target=${targetCount} name=${prefix}`);

  while (missing > 0) {
    let index = 1;
    while (usedLabels.has(`${prefix}${index}`)) index += 1;
    let created = false;
    let failedAttempts = 0;
    while (!created && shouldRetryMobileTab(failedAttempts, attempts)) {
      const before = claudeTabs().length;
      let openCommand = mobileTabOpenCommand(before);
      try {
        await vscode.commands.executeCommand(openCommand);
      } catch (error) {
        if (openCommand !== 'claude-vscode.editor.openLast') throw error;
        openCommand = 'claude-vscode.editor.open';
        await vscode.commands.executeCommand(openCommand);
      }
      created = await waitForNewClaudeTab(before);
      if (created) {
        if (before === 0) {
          channel.appendLine(`${new Date().toISOString()} mobile tabs: 最初のタブを ${openCommand} で開きました`);
        }
        break;
      }
      failedAttempts += 1;
      if (shouldRetryMobileTab(failedAttempts, attempts)) {
        channel.appendLine(`${new Date().toISOString()} mobile tabs: ${openCommand} を再試行します (${failedAttempts + 1}/${attempts})`);
        await delay(retryDelayMs);
      }
    }
    if (!created) {
      channel.appendLine(`${new Date().toISOString()} mobile tabs: コマンド実行後 5 秒以内にタブが増えなかったため、残り ${missing} 件を打ち切りました`);
      return;
    }
    // v2.1.263 のハンドラは第1引数を renameActiveSessionTab へそのまま渡す。
    await vscode.commands.executeCommand('claude-vscode.renameSessionTab', `${prefix}${index}`);
    usedLabels.add(`${prefix}${index}`);
    channel.appendLine(`${new Date().toISOString()} mobile tab created: ${prefix}${index}`);
    missing -= 1;
  }
}

function activate(context) {
  disposed = false;
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
          await requestMobileTabs(action);
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

  const mobileTabs = vscode.workspace.getConfiguration('orgiast.nextSession').get('mobileTabs', 0);
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
          await requestMobileTabs({ count: mobileTabs, name, attempts: 12 });
          // Restored/new subprocesses have a 60s initialization window.
          lastHealthCheckAt = Date.now();
          scheduleHealthCheck({ count: mobileTabs, name, force: true, debounceMs: 90000 });
        })
        .catch((error) => getOutputChannel().appendLine(`${new Date().toISOString()} mobile tabs activation failed: ${error instanceof Error ? error.message : String(error)}`));
    }
    context.subscriptions.push(vscode.window.onDidChangeWindowState((state) => {
      if (state.focused) scheduleHealthCheck({ count: mobileTabs, name, debounceMs: 2000 });
    }));
  }
}

function deactivate() {
  disposed = true;
  clearTimeout(focusDebounceTimer);
  focusDebounceTimer = undefined;
  outputChannel?.dispose();
  outputChannel = undefined;
}

module.exports = { activate, deactivate, ensureMobileTabs, requestMobileTabs, closeMobileTab };
