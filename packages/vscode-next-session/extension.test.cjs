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
  // 成功した手段（editor.open）を記憶して次回も最初に試す。
  assert.deepEqual(commands, ['claude-vscode.editor.open', 'claude-vscode.editor.open']);
  assert.equal(snapshots.at(-1).waiting, 1);
  assert.equal(tabs[0].label, 'ユーザーの作業');
  for (const disposable of context.subscriptions) disposable.dispose();
});

function loadExtension({ onCommand, onExternal }) {
  const tabs = [];
  const logs = [];
  let handler;
  class TabInputWebview { viewType = 'claudeVSCodePanel'; }
  const vscode = {
    TabInputWebview,
    Uri: { parse: (value) => ({ value }) },
    env: { async openExternal(uri) { return onExternal(uri, tabs, TabInputWebview); } },
    window: {
      tabGroups: { all: [{ tabs }], onDidChangeTabs() { return { dispose() {} }; } },
      createOutputChannel() { return { appendLine(line) { logs.push(line); } }; },
      registerUriHandler(value) { handler = value; return { dispose() {} }; },
      showErrorMessage(message) { assert.fail(message); },
    },
    workspace: { getConfiguration() { return { get(key) { return key === 'mobileTabs' ? 0 : undefined; } }; } },
    commands: { async executeCommand(command) { return onCommand(command, tabs, TabInputWebview); } },
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'extension.js'), 'utf8'), {
    module, process, URLSearchParams, console, clearInterval, setTimeout, Date,
    setInterval(fn, ms) { return ms === 5000 ? null : setInterval(fn, ms); },
    require(name) {
      if (name === 'vscode') return vscode;
      if (name === 'node:fs') return { mkdirSync() {}, writeFileSync() {} };
      if (name === './mobile-pool') return { ...require('./mobile-pool'), createOwnershipLease: () => ({ acquire: async () => true, release() {} }) };
      return require(name);
    },
  });
  module.exports.setOpenWaitMs(60);
  module.exports.activate({ subscriptions: [] });
  return { handler, tabs, logs };
}

test('creation falls back through methods, logs labels, and remembers the working one', async () => {
  const calls = [];
  const { handler, tabs, logs } = loadExtension({
    onCommand(command) { calls.push(command); },
    onExternal(uri, list, Input) { calls.push(uri.value); list.push({ input: new Input(), label: 'Claude Code' }); return true; },
  });
  await handler.handleUri({ path: '/mobile', query: 'count=1' });
  assert.deepEqual(calls, ['claude-vscode.editor.open', 'claude-vscode.newConversation', 'vscode://Anthropic.claude-code/open']);
  assert.equal(tabs.length, 1);
  const attempts = logs.filter((line) => line.includes('mobile open method='));
  assert.equal(attempts.length, 3);
  assert.match(attempts[0], /^\d{4}-\d\d-\d\dT.*method=editorOpen before=0 after=0 ok=false newLabels=\[\]/);
  assert.match(attempts[2], /method=externalUri before=0 after=1 ok=true newLabels=\["Claude Code"\]/);
  tabs.length = 0; // 使用済みになって補充が必要になった場合、成功した手段を最初に試す
  calls.length = 0;
  await handler.handleUri({ path: '/mobile', query: 'count=1' });
  assert.deepEqual(calls, ['vscode://Anthropic.claude-code/open']);
});

test('all methods failing is logged per attempt and unchanged state only once', async () => {
  const { handler, logs } = loadExtension({ onCommand() {}, onExternal() { return true; } });
  await handler.handleUri({ path: '/mobile', query: 'count=1' });
  assert.equal(logs.filter((line) => line.includes('ok=false')).length, 3);
  assert.equal(logs.filter((line) => line.includes('ok=true')).length, 0);
  assert.equal(logs.filter((line) => line.includes('mobile tabs: waiting=0 target=1')).length, 1);
});
