const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

test('URI concurrency and tab title events replenish one without interactive rename', async () => {
  const tabs = [];
  const commands = [];
  let handler, changed;
  class TabInputWebview { viewType = 'claudeVSCodePanel'; }
  const vscode = {
    TabInputWebview,
    window: {
      tabGroups: { all: [{ tabs }], onDidChangeTabs(fn) { changed = fn; return { dispose() {} }; } },
      createOutputChannel() { return { appendLine() {} }; },
      registerUriHandler(value) { handler = value; return { dispose() {} }; },
      showErrorMessage(message) { assert.fail(message); },
    },
    workspace: { getConfiguration() { return { get(key) { return key === 'mobileTabs' ? 0 : undefined; } }; } },
    commands: { async executeCommand(command) {
      commands.push(command);
      tabs.push({ input: new TabInputWebview(), label: 'Claude Code' });
      changed();
    } },
  };
  const module = { exports: {} };
  const snapshots = [];
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'extension.js'), 'utf8'), {
    module, process, URLSearchParams, console, clearInterval, setTimeout,
    setInterval(fn, ms) { return ms === 5000 ? null : setInterval(fn, ms); },
    require(name) {
      if (name === 'vscode') return vscode;
      if (name === 'node:fs') return { mkdirSync() {}, writeFileSync(_file, data) { snapshots.push(JSON.parse(data)); } };
      if (name === './mobile-pool') return { ...require('./mobile-pool'), createOwnershipLease: () => ({ acquire: async () => true, release() {} }) };
      return require(name);
    },
  });
  const context = { subscriptions: [] };
  module.exports.activate(context);
  await Promise.all([handler.handleUri({ path: '/mobile', query: '' }), handler.handleUri({ path: '/mobile', query: '' })]);
  assert.equal(commands.length, 1);
  assert.equal(commands[0], 'claude-vscode.editor.open');
  tabs[0].label = 'ユーザーの作業';
  changed();
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.deepEqual(commands, ['claude-vscode.editor.open', 'claude-vscode.newConversation']);
  assert.equal(snapshots.at(-1).waiting, 1);
  assert.equal(tabs[0].label, 'ユーザーの作業');
  for (const disposable of context.subscriptions) disposable.dispose();
});
