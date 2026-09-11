const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const path = require('node:path');
function harness(labels = [], live = 0) {
  class TabInputWebview { constructor() { this.viewType = 'claudeVSCode'; } }
  const tabs = labels.map((label) => ({ label, input: new TabInputWebview() }));
  const group = { tabs, activeTab: tabs[0] };
  const commands = [], logs = [], timers = new Map();
  let clock = 1_000_000, timerId = 0, queries = 0, focus, uriHandler;
  let response = JSON.stringify(Array.from({ length: live }, () => ({ kind: 'interactive' })));
  let queryError = null, blockQuery;
  const vscode = {
    TabInputWebview,
    window: {
      tabGroups: { all: [group], activeTabGroup: group, async close(tab) { group.tabs.splice(group.tabs.indexOf(tab), 1); return true; } },
      createOutputChannel: () => ({ appendLine: (line) => logs.push(line), dispose() {} }),
      registerUriHandler: (handler) => { uriHandler = handler; return { dispose() {} }; },
      onDidChangeWindowState: (listener) => { focus = listener; return { dispose() {} }; },
      showErrorMessage: (message) => { throw new Error(message); },
    },
    workspace: { getConfiguration: () => ({ get: (key, fallback) => key === 'mobileTabs' ? 3 : fallback }) },
    extensions: { getExtension: () => ({ activate: async () => {} }) },
    commands: {
      getCommands: async () => ['claude-vscode.newConversation'],
      async executeCommand(command, arg) {
        commands.push([command, arg]);
        if (['claude-vscode.newConversation', 'claude-vscode.editor.openLast'].includes(command)) {
          const tab = { label: 'new', input: new TabInputWebview() };
          group.tabs.push(tab); group.activeTab = tab;
        } else if (command === 'claude-vscode.renameSessionTab') group.activeTab.label = arg;
        else if (command === 'workbench.action.firstEditorInGroup') group.activeTab = group.tabs[0];
        else if (command === 'workbench.action.nextEditorInGroup') group.activeTab = group.tabs[(group.tabs.indexOf(group.activeTab) + 1) % group.tabs.length];
        else if (command === 'workbench.action.closeActiveEditor') group.tabs.splice(group.tabs.indexOf(group.activeTab), 1);
      },
    },
  };
  const module = { exports: {} };
  const localRequire = createRequire(path.join(__dirname, 'extension.js'));
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'extension.js'), 'utf8'), {
    module, process, URLSearchParams,
    Date: class extends Date { static now() { return clock; } },
    require(name) {
      if (name === 'vscode') return vscode;
      if (name === 'node:child_process') return { execFile(cli, args, options, callback) {
        queries += 1;
        assert.deepEqual(Array.from(args), ['agents', '--json']);
        if (blockQuery) blockQuery(() => callback(queryError, response));
        else callback(queryError, response);
      } };
      return localRequire(name);
    },
    setInterval: (fn) => { queueMicrotask(fn); return 1; }, clearInterval() {},
    setTimeout: (fn, ms) => { const id = ++timerId; timers.set(id, { fn, ms }); return id; },
    clearTimeout: (id) => timers.delete(id),
  });
  return {
    ...module.exports, vscode, group, commands, logs, timers,
    get queries() { return queries; },
    set response(value) { response = value; }, set queryError(value) { queryError = value; },
    set blockQuery(value) { blockQuery = value; },
    focus() { focus({ focused: true }); },
    uri(query) { return uriHandler.handleUri({ path: '/mobile', query }); },
    advance(ms) { clock += ms; },
    fireTimer() { const [id, timer] = [...timers][0]; timers.delete(id); clock += timer.ms; timer.fn(); },
  };
}
const options = { count: 3, name: 'スマホ用セッション', recreate: true };
const labels = ['スマホ用セッション1', 'スマホ用セッション2', 'スマホ用セッション3'];
const settle = () => new Promise((resolve) => setImmediate(resolve));
test('recreate closes only the count deficit and recreates the same labels', async () => {
  const h = harness([...labels, 'work'], 1);
  await h.requestMobileTabs(options);
  assert.equal(h.queries, 1);
  assert.deepEqual(h.group.tabs.map((tab) => tab.label).sort(), [...labels, 'work'].sort());
  assert.equal(h.commands.filter(([cmd]) => cmd === 'claude-vscode.newConversation').length, 2);
});
test('without recreate existing labels are reused and agents is not invoked', async () => {
  const h = harness(labels, 0);
  await h.requestMobileTabs({ ...options, recreate: false });
  assert.equal(h.queries, 0); assert.equal(h.commands.length, 0);
});
test('zero live sessions creates new conversations even after the last tab closes', async () => {
  const h = harness([labels[0]], 0);
  await h.requestMobileTabs({ ...options, count: 1 });
  assert.deepEqual(h.commands.map(([cmd]) => cmd), ['claude-vscode.newConversation', 'claude-vscode.renameSessionTab']);
});
test('malformed, non-array and failed agents responses never close labelled tabs', async () => {
  for (const response of ['', '{}', 'broken']) {
    const h = harness(labels, 0); h.response = response;
    await h.requestMobileTabs(options);
    assert.equal(h.commands.length, 0); assert.equal(h.group.tabs.length, 3);
  }
  const h = harness(labels, 0); h.queryError = new Error('timeout');
  await h.requestMobileTabs(options); assert.equal(h.commands.length, 0);
});
test('fallback reveals and verifies tabs beyond index 9 before closing', async () => {
  const h = harness(Array.from({ length: 12 }, (_, i) => `tab${i}`));
  h.vscode.window.tabGroups.close = async () => false;
  assert.equal(await h.closeMobileTab(h.group.tabs[11]), true);
  assert.equal(h.group.tabs.length, 11); assert.equal(h.group.tabs[0].label, 'tab0');
});
test('fallback never closes the current editor when reveal fails', async () => {
  const h = harness(['work', labels[0]]);
  h.vscode.window.tabGroups.close = async () => false;
  h.vscode.commands.executeCommand = async (command) => h.commands.push([command]);
  assert.equal(await h.closeMobileTab(h.group.tabs[1]), false);
  assert.equal(h.commands.some(([cmd]) => cmd === 'workbench.action.closeActiveEditor'), false);
});
test('URI calls share a lock with health checks, avoiding duplicate creation', async () => {
  const h = harness(labels, 0);
  let release; h.blockQuery = (done) => { release = done; };
  const first = h.requestMobileTabs(options);
  const second = h.requestMobileTabs(options);
  await settle(); assert.equal(h.queries, 1); assert.equal(h.commands.length, 0);
  release(); await Promise.all([first, second]); assert.equal(h.group.tabs.length, 3);
});
test('activation waits 90s, focus debounces and respects 10 minutes; disposal cancels timers', async () => {
  const h = harness(labels, 3);
  h.activate({ subscriptions: [] }); await settle();
  assert.equal(h.queries, 0); assert.equal([...h.timers.values()][0].ms, 90000);
  h.focus(); assert.equal([...h.timers.values()][0].ms, 90000);
  h.fireTimer(); await settle(); assert.equal(h.queries, 1);
  h.focus(); assert.equal(h.timers.size, 0);
  h.advance(10 * 60 * 1000); h.focus(); h.focus(); assert.equal(h.timers.size, 1);
  h.fireTimer(); await settle(); assert.equal(h.queries, 2);
  h.advance(10 * 60 * 1000); h.focus(); h.deactivate(); assert.equal(h.timers.size, 0);
});
test('mobile URI propagates recreate into the shared recovery operation', async () => {
  const h = harness(labels, 0);
  h.activate({ subscriptions: [] }); await settle();
  await h.uri('count=3&recreate=1'); assert.equal(h.queries, 1);
  assert.equal(h.commands.filter(([cmd]) => cmd === 'claude-vscode.newConversation').length, 3);
  h.deactivate();
});
