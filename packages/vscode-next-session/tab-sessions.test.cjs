const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseEditorMemento, activeViewletKeys, selectTabsToClose, planClose } = require('./tab-sessions.cjs');

// ─── Helpers ──────────────────────────────────────────────────────────
/** Leaf node: data is an object with editors array (matches real VS Code memento). */
function leaf(editors, activeViewlet) {
  return { type: 'leaf', data: { editors }, ...(activeViewlet ? { activeViewlet } : {}) };
}
/** Branch node: children are stored in `data` array (matches real VS Code memento). */
function branch(children) {
  return { type: 'branch', data: children };
}
function editor(viewType, title, sessionId) {
  const value = { viewType, title };
  if (sessionId !== undefined) value.state = JSON.stringify({ isFullEditor: true, sessionID: sessionId });
  return { value: JSON.stringify(value) };
}
function memento(root) {
  return JSON.stringify({ editorpart: { state: { serializedGrid: { root } } } });
}
/** Build a fake Tab-like object with the given label and overrides. */
function fakeTab(label, overrides = {}) {
  return { label, input: { viewType: 'claudeVSCodePanel' }, isActive: false, isPinned: false, isDirty: false, ...overrides };
}

// ─── parseEditorMemento ───────────────────────────────────────────────

test('parseEditorMemento empty/null input returns []', () => {
  assert.deepEqual(parseEditorMemento(null), []);
  assert.deepEqual(parseEditorMemento(''), []);
  assert.deepEqual(parseEditorMemento('{}'), []);
  assert.deepEqual(parseEditorMemento({}), []);
  assert.deepEqual(parseEditorMemento(JSON.stringify({ editorpart: {} })), []);
});

test('parseEditorMemento single leaf group with Claude tabs', () => {
  const json = memento(leaf([
    editor('mainThreadWebview-claudeVSCodePanel', 'Claude Code', 'uuid-1'),
    editor('mainThreadWebview-claudeVSCodePanel', '作業中', 'uuid-2'),
  ]));
  const result = parseEditorMemento(json);
  assert.equal(result.length, 2);
  assert.equal(result[0].group, 0); assert.equal(result[0].index, 0);
  assert.equal(result[0].title, 'Claude Code'); assert.equal(result[0].sessionId, 'uuid-1');
  assert.equal(result[0].isClaude, true);
  assert.equal(result[1].group, 0); assert.equal(result[1].index, 1);
  assert.equal(result[1].title, '作業中'); assert.equal(result[1].sessionId, 'uuid-2');
  assert.equal(result[1].isClaude, true);
});

test('parseEditorMemento multiple groups', () => {
  const json = memento(branch([
    leaf([editor('mainThreadWebview-claudeVSCodePanel', 'Claude Code', 'a')]),
    leaf([editor('some.other.panel', 'Terminal', null), editor('mainThreadWebview-claudeVSCodePanel', 'スマホ用', 'b')]),
  ]));
  const result = parseEditorMemento(json);
  assert.equal(result.length, 3);
  // group 0
  assert.equal(result[0].group, 0); assert.equal(result[0].index, 0); assert.equal(result[0].isClaude, true);
  assert.equal(result[0].sessionId, 'a');
  // group 1
  assert.equal(result[1].group, 1); assert.equal(result[1].index, 0); assert.equal(result[1].isClaude, false);
  assert.equal(result[2].group, 1); assert.equal(result[2].index, 1); assert.equal(result[2].isClaude, true);
  assert.equal(result[2].sessionId, 'b');
});

test('parseEditorMemento tab without sessionId (empty tab)', () => {
  const json = memento(leaf([
    editor('mainThreadWebview-claudeVSCodePanel', 'Claude Code', undefined),
  ]));
  const result = parseEditorMemento(json);
  assert.equal(result.length, 1);
  assert.equal(result[0].sessionId, null);
  assert.equal(result[0].isClaude, true);
});

test('parseEditorMemento tab with unparseable state string yields null sessionId', () => {
  const value = JSON.stringify({ viewType: 'mainThreadWebview-claudeVSCodePanel', title: 'Claude Code', state: '{bad}' });
  const json = memento(leaf([{ value }]));
  const result = parseEditorMemento(json);
  assert.equal(result.length, 1);
  assert.equal(result[0].sessionId, null);
});

test('parseEditorMemento non-Claude tabs are correctly flagged', () => {
  const json = memento(leaf([
    editor('textEditor', 'file.txt', null),
    editor('mainThreadWebview-claudeVSCodePanel', 'Claude Code', 'xyz'),
  ]));
  const result = parseEditorMemento(json);
  assert.equal(result[0].isClaude, false);
  assert.equal(result[1].isClaude, true);
});

test('parseEditorMemento deeply nested branch structure', () => {
  // Simulates VS Code split editor layout
  const json = memento(branch([
    leaf([editor('mainThreadWebview-claudeVSCodePanel', 'A', '1')]),
    branch([
      leaf([editor('mainThreadWebview-claudeVSCodePanel', 'B', '2')]),
      leaf([editor('mainThreadWebview-claudeVSCodePanel', 'C', '3')]),
    ]),
  ]));
  const result = parseEditorMemento(json);
  assert.equal(result.length, 3);
  assert.equal(result[0].group, 0); assert.equal(result[0].sessionId, '1');
  assert.equal(result[1].group, 1); assert.equal(result[1].sessionId, '2');
  assert.equal(result[2].group, 2); assert.equal(result[2].sessionId, '3');
});

test('parseEditorMemento invalid editor value is skipped', () => {
  const json = memento(leaf([
    { value: '{bad}' },
    editor('mainThreadWebview-claudeVSCodePanel', 'OK', 'ok'),
  ]));
  const result = parseEditorMemento(json);
  assert.equal(result.length, 1);
  assert.equal(result[0].sessionId, 'ok');
});

// ─── activeViewletKeys ────────────────────────────────────────────────

test('activeViewletKeys extracts from grid root', () => {
  const root = leaf([editor('text', 'x')], 'viewlet:editor:0:0:0');
  const json = JSON.stringify({ editorpart: { state: { serializedGrid: { root } } } });
  assert.deepEqual(activeViewletKeys(json), ['viewlet:editor:0:0:0']);
});

test('activeViewletKeys returns [] when not present', () => {
  assert.deepEqual(activeViewletKeys('{}'), []);
  assert.deepEqual(activeViewletKeys(null), []);
});

// ─── selectTabsToClose ────────────────────────────────────────────────

const claudeTab = (sessionId) => ({ group: 0, index: 0, title: 'Claude Code', sessionId, isClaude: true });
const emptyClaude = () => ({ group: 0, index: 0, title: 'Claude Code', sessionId: null, isClaude: true });

test('selectTabsToClose closes hidden (archived) session IDs', () => {
  const result = selectTabsToClose({ tabs: [claudeTab('archived-1')], hiddenIds: ['archived-1'], closedIds: [] });
  assert.equal(result.length, 1);
  assert.equal(result[0].reason, 'hidden');
  assert.equal(result[0].sessionId, 'archived-1');
});

test('selectTabsToClose closes closed session IDs', () => {
  const result = selectTabsToClose({ tabs: [claudeTab('closed-1')], hiddenIds: [], closedIds: ['closed-1'] });
  assert.equal(result.length, 1);
  assert.equal(result[0].reason, 'closed');
  assert.equal(result[0].sessionId, 'closed-1');
});

test('selectTabsToClose keeps tabs not in hidden or closed', () => {
  const result = selectTabsToClose({ tabs: [claudeTab('active-1')], hiddenIds: [], closedIds: [] });
  assert.equal(result.length, 0);
});

test('selectTabsToClose skips active (focused) tabs by sessionId', () => {
  const result = selectTabsToClose({
    tabs: [claudeTab('archived-1')],
    hiddenIds: ['archived-1'],
    closedIds: [],
    activeKeys: new Set(['archived-1']),
  });
  assert.equal(result.length, 0);
});

test('selectTabsToClose skips active tabs by group:index key', () => {
  const result = selectTabsToClose({
    tabs: [{ ...claudeTab('archived-1'), group: 1, index: 2 }],
    hiddenIds: ['archived-1'],
    closedIds: [],
    activeKeys: new Set(['1:2']),
  });
  assert.equal(result.length, 0);
});

test('selectTabsToClose keeps keepEmpty empty Claude tabs, closes excess', () => {
  // 5 empty Claude tabs, keepEmpty=3 → close 2
  const tabs = Array.from({ length: 5 }, (_, i) => ({
    group: 0, index: i, title: 'Claude Code', sessionId: null, isClaude: true,
  }));
  const result = selectTabsToClose({ tabs, hiddenIds: [], closedIds: [], keepEmpty: 3 });
  assert.equal(result.length, 2);
  for (const r of result) assert.equal(r.reason, 'empty-extra');
  // earliest excess = index 0 and 1
  assert.equal(result[0].index, 0);
  assert.equal(result[1].index, 1);
});

test('selectTabsToClose keeps all empty tabs when count <= keepEmpty', () => {
  const tabs = Array.from({ length: 3 }, (_, i) => ({
    group: 0, index: i, title: 'Claude Code', sessionId: null, isClaude: true,
  }));
  assert.equal(selectTabsToClose({ tabs, keepEmpty: 3 }).length, 0);
  assert.equal(selectTabsToClose({ tabs, keepEmpty: 5 }).length, 0);
});

test('selectTabsToClose non-Claude tabs are never closed', () => {
  const tab = { group: 0, index: 0, title: 'file.txt', sessionId: null, isClaude: false };
  assert.equal(selectTabsToClose({ tabs: [tab], hiddenIds: [], closedIds: [] }).length, 0);
});

test('selectTabsToClose null/undefined inputs return []', () => {
  assert.deepEqual(selectTabsToClose({ tabs: null }), []);
  assert.deepEqual(selectTabsToClose({ tabs: undefined }), []);
});

test('selectTabsToClose mixed scenario: hides + closed + empty + active', () => {
  const tabs = [
    { group: 0, index: 0, title: 'Claude Code', sessionId: 'hidden-1', isClaude: true },
    { group: 0, index: 1, title: 'Claude Code', sessionId: 'closed-1', isClaude: true },
    { group: 0, index: 2, title: 'Claude Code', sessionId: null, isClaude: true },
    { group: 0, index: 3, title: 'Claude Code', sessionId: null, isClaude: true },
    { group: 0, index: 4, title: 'Claude Code', sessionId: 'active-1', isClaude: true },
    { group: 0, index: 5, title: 'file.txt', sessionId: null, isClaude: false },
  ];
  const result = selectTabsToClose({
    tabs, hiddenIds: ['hidden-1'], closedIds: ['closed-1'],
    activeKeys: new Set(['hidden-1']), // hidden-1 is active → skip
    keepEmpty: 1, // only keep 1 empty tab, 2 empty tabs exist → close 1
  });
  // closed-1 → closed, empty-extra (one excess)
  assert.equal(result.length, 2);
  const reasons = result.map(r => r.reason).sort();
  assert.deepEqual(reasons, ['closed', 'empty-extra']);
});

// ─── Integration: parseEditorMemento then selectTabsToClose ──────────

test('integration: parse memento then select archived tabs', () => {
  const json = memento(branch([
    leaf([
      editor('mainThreadWebview-claudeVSCodePanel', 'Claude Code', 'archived-uuid'),
      editor('mainThreadWebview-claudeVSCodePanel', '作業中', 'active-uuid'),
    ]),
    leaf([
      editor('mainThreadWebview-claudeVSCodePanel', 'Claude Code', null),
      editor('mainThreadWebview-claudeVSCodePanel', 'Claude Code', null),
      editor('mainThreadWebview-claudeVSCodePanel', 'Claude Code', null),
    ]),
  ]));
  const tabs = parseEditorMemento(json);
  assert.equal(tabs.length, 5);
  const result = selectTabsToClose({
    tabs,
    hiddenIds: ['archived-uuid'],
    closedIds: [],
    keepEmpty: 2, // group 1 has 3 empty tabs → close 1
  });
  assert.equal(result.length, 2);
  assert.equal(result[0].reason, 'hidden');
  assert.equal(result[0].sessionId, 'archived-uuid');
  assert.equal(result[1].reason, 'empty-extra');
});

// ─── Fixture: parseEditorMemento with real VS Code memento structure ──

test('parseEditorMemento with real fixture — reads editorpart.state key and branch.data children', () => {
  const fixturePath = path.join(__dirname, 'fixtures-editor-memento.json');
  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  const result = parseEditorMemento(fixture);
  // Group 0 has 6 Claude tabs
  assert.ok(result.length >= 6, `expected >=6 tabs, got ${result.length}`);
  const group0 = result.filter(t => t.group === 0);
  assert.equal(group0.length, 6);
  for (const tab of group0) assert.equal(tab.isClaude, true);
  // At least one tab has a sessionId
  const withSession = result.filter(t => t.sessionId !== null);
  assert.ok(withSession.length >= 1, 'expected at least one tab with sessionId');
  // Verify known values from fixture
  assert.equal(group0[0].title, '会話タイトル1');
  assert.equal(group0[0].sessionId, '790fcfc6-f15b-42a1-8f3a-a41ba3f8900b');
  assert.equal(group0[2].title, 'Claude Code');
  assert.equal(group0[2].sessionId, '1c4d4177-122c-4fd0-8987-1b40a7d88309');
  // Group 1 is empty (no editors)
  const group1 = result.filter(t => t.group === 1);
  assert.equal(group1.length, 0);
});

// ─── planClose ────────────────────────────────────────────────────────

test('planClose: empty inputs return empty result', () => {
  assert.deepEqual(planClose({ mementoTabs: [], liveTabsByGroup: [] }), { toClose: [], hidden: 0, closed: 0, emptyExtra: 0, skipped: 0 });
  assert.deepEqual(planClose({ mementoTabs: null, liveTabsByGroup: [] }), { toClose: [], hidden: 0, closed: 0, emptyExtra: 0, skipped: 0 });
});

test('planClose: group count mismatch skips all', () => {
  const mt = [{ group: 0, index: 0, title: 'A', sessionId: 's1', isClaude: true }];
  const result = planClose({ mementoTabs: mt, liveTabsByGroup: [[], []], hiddenIds: ['s1'], closedIds: [] });
  assert.equal(result.toClose.length, 0);
  assert.equal(result.skipped, 2);
  assert.equal(result.reason, 'group-count-mismatch (memento=1 live=2)');
});

test('planClose: tab count mismatch skips that group', () => {
  const mt = [{ group: 0, index: 0, title: 'A', sessionId: 's1', isClaude: true }];
  const live = [[fakeTab('A'), fakeTab('B')]]; // 2 live vs 1 memento
  const result = planClose({ mementoTabs: mt, liveTabsByGroup: live, hiddenIds: ['s1'], closedIds: [] });
  assert.equal(result.toClose.length, 0);
  assert.equal(result.skipped, 1);
});

test('planClose: label mismatch skips that group', () => {
  const mt = [{ group: 0, index: 0, title: 'A', sessionId: 's1', isClaude: true }];
  const live = [[fakeTab('B')]]; // label B ≠ A
  const result = planClose({ mementoTabs: mt, liveTabsByGroup: live, hiddenIds: ['s1'], closedIds: [] });
  assert.equal(result.toClose.length, 0);
  assert.equal(result.skipped, 1);
});

test('planClose: label with ellipsis matches truncated title', () => {
  const mt = [{ group: 0, index: 0, title: 'Long conversation title', sessionId: 's1', isClaude: true }];
  const live = [[fakeTab('Long conversation…')]]; // VS Code truncates with …
  const result = planClose({ mementoTabs: mt, liveTabsByGroup: live, hiddenIds: ['s1'], closedIds: [] });
  assert.equal(result.toClose.length, 1);
  assert.equal(result.hidden, 1);
});

test('planClose: position shift prevented — judge all first then close', () => {
  // Two Claude tabs in same group: first is archived, second is active
  // Old code would close index 0 (archived), then index references shift
  // planClose never closes based on index after shift — it uses references
  const mt = [
    { group: 0, index: 0, title: 'archived-session', sessionId: 'archived-1', isClaude: true },
    { group: 0, index: 1, title: 'active-session', sessionId: 'active-1', isClaude: true },
  ];
  const live = [[
    fakeTab('archived-session'),
    fakeTab('active-session'),
  ]];
  const result = planClose({ mementoTabs: mt, liveTabsByGroup: live, hiddenIds: ['archived-1'], closedIds: [], keepEmpty: 0 });
  assert.equal(result.toClose.length, 1);
  assert.equal(result.hidden, 1);
  assert.equal(result.toClose[0].label, 'archived-session');
});

test('planClose: active tab not closed', () => {
  const mt = [{ group: 0, index: 0, title: 'A', sessionId: 's1', isClaude: true }];
  const live = [[fakeTab('A', { isActive: true })]];
  const result = planClose({ mementoTabs: mt, liveTabsByGroup: live, hiddenIds: ['s1'], closedIds: [] });
  assert.equal(result.toClose.length, 0);
});

test('planClose: pinned tab not closed', () => {
  const mt = [{ group: 0, index: 0, title: 'A', sessionId: 's1', isClaude: true }];
  const live = [[fakeTab('A', { isPinned: true })]];
  const result = planClose({ mementoTabs: mt, liveTabsByGroup: live, hiddenIds: ['s1'], closedIds: [] });
  assert.equal(result.toClose.length, 0);
});

test('planClose: dirty tab not closed (uses tab.isDirty, not input.isDirty)', () => {
  const mt = [{ group: 0, index: 0, title: 'A', sessionId: 's1', isClaude: true }];
  const live = [[fakeTab('A', { isDirty: true })]];
  const result = planClose({ mementoTabs: mt, liveTabsByGroup: live, hiddenIds: ['s1'], closedIds: [] });
  assert.equal(result.toClose.length, 0);
});

test('planClose: non-Claude live tab (different viewType) not closed even if memento says Claude', () => {
  const mt = [{ group: 0, index: 0, title: 'A', sessionId: 's1', isClaude: true }];
  const live = [[{ label: 'A', input: { viewType: 'textEditor' }, isActive: false, isPinned: false, isDirty: false }]];
  const result = planClose({ mementoTabs: mt, liveTabsByGroup: live, hiddenIds: ['s1'], closedIds: [] });
  assert.equal(result.toClose.length, 0);
});

test('planClose: keepEmpty preserves N empty tabs across groups', () => {
  // Two groups, each with 2 empty Claude tabs (total 4), keepEmpty=3 → close 1
  const mt = [
    { group: 0, index: 0, title: 'Claude Code', sessionId: null, isClaude: true },
    { group: 0, index: 1, title: 'Claude Code', sessionId: null, isClaude: true },
    { group: 1, index: 0, title: 'Claude Code', sessionId: null, isClaude: true },
    { group: 1, index: 1, title: 'Claude Code', sessionId: null, isClaude: true },
  ];
  const live = [
    [fakeTab('Claude Code'), fakeTab('Claude Code')],
    [fakeTab('Claude Code'), fakeTab('Claude Code')],
  ];
  const result = planClose({ mementoTabs: mt, liveTabsByGroup: live, hiddenIds: [], closedIds: [], keepEmpty: 3 });
  assert.equal(result.toClose.length, 1);
  assert.equal(result.emptyExtra, 1);
});

test('planClose: no excess empty tabs when count <= keepEmpty', () => {
  const mt = [
    { group: 0, index: 0, title: 'Claude Code', sessionId: null, isClaude: true },
    { group: 0, index: 1, title: 'Claude Code', sessionId: null, isClaude: true },
  ];
  const live = [[fakeTab('Claude Code'), fakeTab('Claude Code')]];
  assert.equal(planClose({ mementoTabs: mt, liveTabsByGroup: live, keepEmpty: 3 }).toClose.length, 0);
  assert.equal(planClose({ mementoTabs: mt, liveTabsByGroup: live, keepEmpty: 2 }).toClose.length, 0);
});

test('planClose: non-Claude memento tabs in group do not break matching', () => {
  const mt = [
    { group: 0, index: 0, title: 'file.txt', sessionId: null, isClaude: false },
    { group: 0, index: 1, title: 'Claude A', sessionId: 's1', isClaude: true },
  ];
  const live = [[
    { label: 'file.txt', input: { viewType: 'textEditor' }, isActive: false, isPinned: false, isDirty: false },
    fakeTab('Claude A'),
  ]];
  const result = planClose({ mementoTabs: mt, liveTabsByGroup: live, hiddenIds: ['s1'], closedIds: [], keepEmpty: 0 });
  assert.equal(result.toClose.length, 1);
  assert.equal(result.hidden, 1);
});

test('planClose: all groups skipped when every group has mismatch', () => {
  const mt = [{ group: 0, index: 0, title: 'A', sessionId: 's1', isClaude: true }];
  const live = [[fakeTab('X')]]; // mismatched label
  const result = planClose({ mementoTabs: mt, liveTabsByGroup: live, hiddenIds: ['s1'], closedIds: [] });
  assert.equal(result.toClose.length, 0);
  assert.equal(result.skipped, 1);
  assert.equal(result.reason, 'all-groups-skipped');
});

test('planClose: "Claude Code" label matching — same label passes group check', () => {
  const mt = [{ group: 0, index: 0, title: 'Claude Code', sessionId: 's1', isClaude: true }];
  const live = [[fakeTab('Claude Code')]];
  const result = planClose({ mementoTabs: mt, liveTabsByGroup: live, hiddenIds: ['s1'], closedIds: [] });
  // Label match passes because labelsMatch allows "Claude Code" === "Claude Code"
  assert.equal(result.toClose.length, 1);
  assert.equal(result.hidden, 1);
});

test('planClose: mixed scenario — hidden + closed + empty-extra + active/skip', () => {
  const mt = [
    { group: 0, index: 0, title: 'A (hidden)', sessionId: 'hid-1', isClaude: true },
    { group: 0, index: 1, title: 'B (closed)', sessionId: 'clo-1', isClaude: true },
    { group: 0, index: 2, title: 'C (active)', sessionId: 'act-1', isClaude: true },
    { group: 0, index: 3, title: 'Claude Code', sessionId: null, isClaude: true },
    { group: 0, index: 4, title: 'Claude Code', sessionId: null, isClaude: true },
    { group: 0, index: 5, title: 'file.txt', sessionId: null, isClaude: false },
  ];
  // group 1 has different count → skipped
  const mt2 = [...mt, { group: 1, index: 0, title: 'orphan', sessionId: 'x', isClaude: true }];
  const live = [
    [
      fakeTab('A (hidden)'),
      fakeTab('B (closed)'),
      fakeTab('C (active)'),
      fakeTab('Claude Code'),
      fakeTab('Claude Code'),
      { label: 'file.txt', input: { viewType: 'textEditor' }, isActive: false, isPinned: false, isDirty: false },
    ],
    [fakeTab('orphan')],
  ];
  const result = planClose({
    mementoTabs: mt2, liveTabsByGroup: live,
    hiddenIds: ['hid-1'], closedIds: ['clo-1'],
    keepEmpty: 1, // 2 empty → keep 1, close 1
  });
  // Expected: hid-1 (hidden), clo-1 (closed), one empty-extra
  // But C (active) is excluded by live tab isActive check
  assert.equal(result.toClose.length, 3);
  assert.equal(result.hidden, 1);
  assert.equal(result.closed, 1);
  assert.equal(result.emptyExtra, 1);
  assert.equal(result.skipped, 0); // group 0 matched, group 1 count matched too
});