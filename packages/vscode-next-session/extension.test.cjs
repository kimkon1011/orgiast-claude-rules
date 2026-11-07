const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const vm = require('node:vm');
const path = require('node:path');

test('worktree ウィンドウ: 補充せず、起動時に未使用待機タブだけ閉じる（使用中は残す）', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-wt-win-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const wtDir = path.join(root, '.claude', 'worktrees', 'mail-approval-gate-fix');
  fs.mkdirSync(wtDir, { recursive: true });
  fs.writeFileSync(path.join(wtDir, '.git'), 'gitdir: C:/x/.git/worktrees/mail-approval-gate-fix\n', 'utf8');

  const tabs = [];
  const commands = [];
  const snapshots = [];
  let handler;
  class TabInputWebview { viewType = 'claudeVSCodePanel'; }
  tabs.push(
    { input: new TabInputWebview(), label: 'Claude Code', isActive: false },
    { input: new TabInputWebview(), label: '仕事中', isActive: false },
  );
  const vscode = {
    TabInputWebview,
    window: {
      tabGroups: {
        all: [{ tabs }],
        onDidChangeTabs() { return { dispose() {} }; },
        async close(tab) { const i = tabs.indexOf(tab); if (i >= 0) tabs.splice(i, 1); return true; },
      },
      createOutputChannel() { return { appendLine() {} }; },
      registerUriHandler(value) { handler = value; return { dispose() {} }; },
      showErrorMessage(message) { assert.fail(message); },
    },
    workspace: {
      getConfiguration() { return { get() { return 0; } }; },
      workspaceFolders: [{ uri: { fsPath: wtDir } }],
    },
    commands: { async executeCommand(command) { commands.push(command); } },
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'extension.js'), 'utf8'), {
    module, process, URLSearchParams, console, clearInterval, clearTimeout, setTimeout,
    setInterval(fn, ms) { return ms === 5000 ? null : setInterval(fn, ms); },
    require(name) {
      if (name === 'vscode') return vscode;
      if (name === 'node:fs') return { mkdirSync() {}, writeFileSync(_file, data) { snapshots.push(JSON.parse(data)); } };
      if (name === './mobile-pool') return { ...require('./mobile-pool'), createOwnershipLease: () => ({ acquire: async () => true, release() {} }) };
      return require(name);
    },
  });
  module.exports.activate({ subscriptions: [] });
  // 起動時 cleanup: 未使用待機タブ（Claude Code）だけ閉じ、会話中タブは残す
  assert.equal(tabs.length, 1);
  assert.equal(tabs[0].label, '仕事中');
  // /mobile URI が届いても補充コマンドは実行せず、状態ファイルも書かない（リーズを使わない）
  await handler.handleUri({ path: '/mobile', query: 'count=3' });
  assert.deepEqual(commands, []);
  assert.deepEqual(snapshots, []);
  assert.equal(tabs.length, 1);
});

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
    module, process, URLSearchParams, console, clearInterval, clearTimeout, setTimeout,
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
    module, process, URLSearchParams, console, clearInterval, clearTimeout, setTimeout, Date,
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
