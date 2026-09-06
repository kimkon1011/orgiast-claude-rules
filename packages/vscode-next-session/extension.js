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
}

function deactivate() {}

module.exports = { activate, deactivate };
