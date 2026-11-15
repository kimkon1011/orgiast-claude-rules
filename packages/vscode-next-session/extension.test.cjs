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
    Uri: { parse: (value) => ({ value }) },
    env: { async openExternal() { return true; } },
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
  // worktree ウィンドウの openedTabs は空（自分で開いていない）なので何も閉じない
  assert.equal(tabs.length, 2);
  assert.equal(tabs[0].label, 'Claude Code');
  assert.equal(tabs[1].label, '仕事中');
  // /mobile URI が届いても補充コマンドは実行せず、状態ファイルも書かない（リーズを使わない）
  await handler.handleUri({ path: '/mobile', query: 'count=3' });
  assert.deepEqual(commands, []);
  assert.deepEqual(snapshots, []);
  assert.equal(tabs.length, 2);
});

test('URI concurrency and tab title events replenish one without interactive rename', async () => {
  const tabs = [];
  const commands = [];
  let handler, changed;
  class TabInputWebview { viewType = 'claudeVSCodePanel'; }
  const vscode = {
    TabInputWebview,
    Uri: { parse: (value) => ({ value }) },
    env: { async openExternal(uri) { commands.push(uri.value); tabs.push({ input: new TabInputWebview(), label: 'Claude Code' }); return true; } },
    window: {
      tabGroups: { all: [{ tabs }], onDidChangeTabs(fn) { changed = fn; return { dispose() {} }; } },
      createOutputChannel() { return { appendLine() {} }; },
      registerUriHandler(value) { handler = value; return { dispose() {} }; },
      showErrorMessage(message) { assert.fail(message); },
    },
    workspace: { getConfiguration() { return { get(key) { return key === 'mobileTabs' ? 0 : undefined; } }; } },
    commands: { async executeCommand(command) { commands.push(command); } },
  };
  const module = { exports: {} };
  const snapshots = [];
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'extension.js'), 'utf8'), {
    module, process, URLSearchParams, console, clearInterval, clearTimeout, setTimeout, Date,
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
  // externalUri 1回だけ（直列化により重複しない）
  assert.equal(commands.length, 1);
  assert.equal(commands[0], 'vscode://Anthropic.claude-code/open');
  tabs[0].label = 'ユーザーの作業';
  changed();
  await new Promise((resolve) => setTimeout(resolve, 250));
  // 再度 externalUri を呼ぶ（lastGoodMethod による切り替えは無く、常に externalUri）
  assert.equal(commands.length, 2);
  assert.equal(commands[1], 'vscode://Anthropic.claude-code/open');
  assert.equal(snapshots.at(-1).waiting, 1);
  assert.equal(tabs[0].label, 'ユーザーの作業');
  for (const disposable of context.subscriptions) disposable.dispose();
});

function loadExtension({ onCommand, onExternal, clock = Date }) {
  const tabs = [];
  const logs = [];
  const snapshots = [];
  const closed = [];
  let handler;
  class TabInputWebview { viewType = 'claudeVSCodePanel'; }
  const vscode = {
    TabInputWebview,
    Uri: { parse: (value) => ({ value }) },
    env: { async openExternal(uri) { return onExternal(uri, tabs, TabInputWebview); } },
    window: {
      tabGroups: { all: [{ tabs }], onDidChangeTabs() { return { dispose() {} }; }, async close(tab) { closed.push(tab); tabs.splice(tabs.indexOf(tab), 1); return true; } },
      createOutputChannel() { return { appendLine(line) { logs.push(line); } }; },
      registerUriHandler(value) { handler = value; return { dispose() {} }; },
      showErrorMessage(message) { assert.fail(message); },
    },
    workspace: { getConfiguration() { return { get(key) { return key === 'mobileTabs' ? 0 : undefined; } }; } },
    commands: { async executeCommand(command) { return onCommand(command, tabs, TabInputWebview); } },
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'extension.js'), 'utf8'), {
    module, process, URLSearchParams, console, clearInterval, clearTimeout, setTimeout, Date: clock,
    setInterval(fn, ms) { return ms === 5000 ? null : setInterval(fn, ms); },
    require(name) {
      if (name === 'vscode') return vscode;
      if (name === 'node:fs') return { mkdirSync() {}, writeFileSync(_file, data) { snapshots.push(data); } };
      if (name === './mobile-pool') return { ...require('./mobile-pool'), createOwnershipLease: () => ({ acquire: async () => true, release() {} }) };
      return require(name);
    },
  });
  module.exports.setOpenWaitMs(60);
  module.exports.activate({ subscriptions: [] });
  return { handler, tabs, logs, snapshots, closed, Input: TabInputWebview, ensure: module.exports.ensureMobileTabs };
}

test('creation uses only externalUri (safe method), logs labels', async () => {
  const calls = [];
  const { handler, tabs, logs } = loadExtension({
    onCommand(command) { calls.push(command); },
    onExternal(uri, list, Input) { calls.push(uri.value); list.push({ input: new Input(), label: 'Claude Code' }); return true; },
  });
  await handler.handleUri({ path: '/mobile', query: 'count=1' });
  // externalUri だけを試す
  assert.deepEqual(calls, ['vscode://Anthropic.claude-code/open']);
  assert.equal(tabs.length, 1);
  const attempts = logs.filter((line) => line.includes('mobile open method='));
  assert.equal(attempts.length, 1);
  assert.match(attempts[0], /method=externalUri before=0 after=1 ok=true newLabels=\["Claude Code"\]/);
  // タブを使い切ったら再度 externalUri を試す（lastGoodMethod に左右されない）
  tabs.length = 0;
  calls.length = 0;
  await handler.handleUri({ path: '/mobile', query: 'count=1' });
  assert.deepEqual(calls, ['vscode://Anthropic.claude-code/open']);
});

test('externalUri failing is logged once', async () => {
  const { handler, logs } = loadExtension({ onCommand() {}, onExternal() { return true; } });
  await handler.handleUri({ path: '/mobile', query: 'count=1' });
  // externalUri は成功（return true）するがタブが増えないので ok=false
  assert.equal(logs.filter((line) => line.includes('ok=false')).length, 1);
  assert.equal(logs.filter((line) => line.includes('ok=true')).length, 0);
  assert.equal(logs.filter((line) => line.includes('mobile tabs: waiting=0 target=1')).length, 1);
});

for (const throws of [false, true]) {
  test(`tab decrease permanently stops ensure (throws=${throws})`, async () => {
    let calls = 0;
    const { handler, tabs, logs, snapshots, Input, ensure } = loadExtension({
      onCommand() { assert.fail('unsafe command'); },
      onExternal(_uri, list) {
        calls++;
        list.pop();
        if (throws) throw new Error('open failed after closing tab');
        return true;
      },
    });
    tabs.push({ input: new Input(), label: '作業中' }, { input: new Input(), label: '別の作業' });
    await handler.handleUri({ path: '/mobile', query: 'count=3' });
    assert.equal(calls, 1);
    assert.equal(tabs.length, 1);
    assert.equal(logs.filter(line => line.includes('mobile open ABORT: Claude タブが減少 before=2 after=1')).length, 1);
    const writes = snapshots.length;
    await ensure({ count: 3 });
    await handler.handleUri({ path: '/mobile', query: 'count=3&refresh=1' });
    assert.equal(calls, 1);
    assert.equal(snapshots.length, writes);
  });
}

test('refresh closes only an owned unchanged tab, one even with concurrent requests', async () => {
  let now = Date.now();
  class Clock extends Date { static now() { return now; } }
  const { handler, tabs, closed, Input } = loadExtension({
    clock: Clock,
    onCommand() { assert.fail('unsafe command'); },
    onExternal(_uri, list, Input) { list.push({ input: new Input(), label: 'Claude Code' }); return true; },
  });
  const existing = { input: new Input(), label: 'Claude Code' };
  tabs.push(existing);
  await handler.handleUri({ path: '/mobile', query: 'count=4' });
  assert.equal(tabs.length, 4);
  const owned = tabs.slice(1);
  // First refresh records appearance times, too young to close.
  await handler.handleUri({ path: '/mobile', query: 'count=4&refresh=1' });
  assert.deepEqual(closed, []);
  now += 11 * 60000;
  owned[0].label = '作業中';
  await Promise.all([
    handler.handleUri({ path: '/mobile', query: 'count=1&refresh=1' }),
    handler.handleUri({ path: '/mobile', query: 'count=1&refresh=1' }),
  ]);
  assert.deepEqual(closed, [owned[1]]);
  assert(tabs.includes(existing));
  assert(tabs.includes(owned[0]));
});
