const vscode = require('vscode');
const { resolveClaudeShellPath } = require('./shell-path');
const { decideAction } = require('./route');

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
      && String(tab.input.viewType).includes('claudeVSCodePanel'));
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

async function ensureMobileTabs({ count, name }) {
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
    const before = claudeTabs().length;
    await vscode.commands.executeCommand('claude-vscode.newConversation');
    if (!await waitForNewClaudeTab(before)) {
      channel.appendLine(`${new Date().toISOString()} mobile tabs: newConversation 後 5 秒以内にタブが増えなかったため、残り ${missing} 件を打ち切りました`);
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
        .then(() => ensureMobileTabs({ count: mobileTabs, name }))
        .catch((error) => getOutputChannel().appendLine(`${new Date().toISOString()} mobile tabs activation failed: ${error instanceof Error ? error.message : String(error)}`));
    }
  }
}

function deactivate() {}

module.exports = { activate, deactivate, ensureMobileTabs };
