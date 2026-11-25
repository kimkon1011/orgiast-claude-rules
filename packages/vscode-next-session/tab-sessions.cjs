/**
 * Pure functions for parsing VS Code editor state memento, selecting tabs to close,
 * and planning which live tabs to close (all no VS Code API dependency).
 */
'use strict';

/**
 * Simple label comparison for group-matching.
 * Unlike titleMatches() from archive-tab-match.js, this allows "Claude Code" === "Claude Code".
 */
function labelsMatch(liveLabel, memoTitle) {
  const a = String(liveLabel ?? '').trim();
  const b = String(memoTitle ?? '').trim();
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.endsWith('…')) {
    const prefix = a.slice(0, -1).trimEnd();
    return Boolean(prefix) && b.startsWith(prefix);
  }
  return false;
}

/**
 * Parse the VS Code editor state memento.
 *
 * The real VS Code memento stores data under a single key "editorpart.state"
 * (the key name contains a literal dot).  For backward compatibility with tests
 * that use the nested { editorpart: { state: ... } } form, this function
 * checks both paths.
 *
 * Branch nodes in the real grid store their children in `node.data` (an array),
 * not `node.children`.  Both forms are handled.
 *
 * @param {string|object} json  JSON string or parsed object
 * @returns {Array<{group:number, index:number, title:string, sessionId:string|null, isClaude:boolean}>}
 */
function parseEditorMemento(json) {
  if (json === null || json === undefined || json === '') return [];
  const data = typeof json === 'string' ? JSON.parse(json) : json;
  const state = data?.['editorpart.state'] ?? data?.editorpart?.state;
  const grid = state?.serializedGrid;
  if (!grid?.root) return [];
  const result = [];
  let groupIndex = 0;
  (function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'leaf' && Array.isArray(node.data?.editors)) {
      for (const editor of node.data.editors) {
        if (!editor || typeof editor.value !== 'string') continue;
        let parsed;
        try { parsed = JSON.parse(editor.value); } catch { continue; }
        const viewType = String(parsed.viewType || '');
        const title = String(parsed.title || '');
        let sessionId = null;
        if (parsed.state) {
          try {
            const st = typeof parsed.state === 'string' ? JSON.parse(parsed.state) : parsed.state;
            if (st && typeof st.sessionID === 'string' && st.sessionID) {
              sessionId = st.sessionID;
            }
          } catch { /* unparseable state — treat as empty tab */ }
        }
        result.push({
          group: groupIndex,
          index: result.filter(t => t.group === groupIndex).length,
          title,
          sessionId,
          isClaude: viewType.includes('claudeVSCode'),
        });
      }
      groupIndex++;
    }
    if (node.type === 'branch') {
      const children = Array.isArray(node.data) ? node.data :
                       Array.isArray(node.children) ? node.children : [];
      children.forEach(child => walk(child));
    }
  })(grid.root);
  return result;
}

/**
 * Derive active viewlet keys from the memento grid root.
 * @param {string|object} json
 * @returns {string[]}
 */
function activeViewletKeys(json) {
  const data = typeof json === 'string' ? JSON.parse(json) : json;
  const state = data?.['editorpart.state'] ?? data?.editorpart?.state;
  const root = state?.serializedGrid?.root;
  if (!root || typeof root.activeViewlet !== 'string') return [];
  return [root.activeViewlet];
}

/**
 * Select tabs that should be closed.
 *
 * Criteria (all must hold):
 * - Tab is a Claude tab (isClaude === true)
 * - sessionId is in hiddenIds or closedIds, OR
 *   sessionId is null and empty-tab count exceeds keepEmpty
 *
 * Active, pinned, and dirty tabs are NOT checked here — those checks belong
 * in the caller against live vscode Tab objects.
 *
 * @param {object} options
 * @param {Array<{group:number,index:number,title:string,sessionId:string|null,isClaude:boolean}>} options.tabs
 * @param {string[]} options.hiddenIds   Archived session IDs (VS Code global state)
 * @param {string[]} options.closedIds   Closed session IDs (~/.claude/closed-sessions.json)
 * @param {Set<string>} [options.activeKeys]  Keys of active (focused) viewlets
 * @param {number} [options.keepEmpty=3]  Max empty Claude tabs to keep
 * @returns {Array<{group:number,index:number,title:string,sessionId:string|null,reason:'hidden'|'closed'|'empty-extra'}>}
 */
function selectTabsToClose({ tabs, hiddenIds, closedIds, activeKeys, keepEmpty = 3 }) {
  if (!Array.isArray(tabs)) return [];
  const hidden = new Set(hiddenIds || []);
  const closed = new Set(closedIds || []);
  const active = new Set(activeKeys || []);
  const toClose = [];
  const emptyClaude = [];
  for (const tab of tabs) {
    if (!tab.isClaude) continue;
    const tabKey = `${tab.group}:${tab.index}`;
    // Skip active (focused) tabs — derived from memento activeViewlet
    if (tab.sessionId && active.has(tab.sessionId)) continue;
    if (active.has(tabKey)) continue;
    if (active.has(tab.title)) continue;
    if (tab.sessionId) {
      if (hidden.has(tab.sessionId)) {
        toClose.push({ group: tab.group, index: tab.index, title: tab.title, sessionId: tab.sessionId, reason: 'hidden' });
      } else if (closed.has(tab.sessionId)) {
        toClose.push({ group: tab.group, index: tab.index, title: tab.title, sessionId: tab.sessionId, reason: 'closed' });
      }
    } else {
      emptyClaude.push(tab);
    }
  }
  // Keep at most keepEmpty empty Claude tabs; close the earliest extras
  const excess = emptyClaude.length - keepEmpty;
  for (let i = 0; i < Math.max(0, excess); i++) {
    const tab = emptyClaude[i];
    toClose.push({ group: tab.group, index: tab.index, title: tab.title, sessionId: null, reason: 'empty-extra' });
  }
  return toClose;
}

/**
 * Plan which live tabs to close based on memento analysis.
 *
 * Pure function — no VS Code API dependency.  Live Tab objects are inspected
 * by duck-typing (label, isActive, isPinned, isDirty, input.viewType).
 *
 * Steps:
 * 1. Group count must match exactly (memento vs live); skip all if differs.
 * 2. Per group: total tab count AND per-position label must match.
 *    Skip mismatched groups individually.
 * 3. Collect archive/close decisions for non-skipped groups via selectTabsToClose.
 * 4. Map decisions to live Tab references, re-checking active/pinned/dirty.
 *
 * @param {object} options
 * @param {Array} options.mementoTabs          Output of parseEditorMemento
 * @param {Array<Array<object>>} options.liveTabsByGroup  liveGroups.map(g => g.tabs || [])
 * @param {string[]} options.hiddenIds         Archived session IDs
 * @param {string[]} options.closedIds         Closed session IDs
 * @param {number}  [options.keepEmpty=3]      Max empty Claude tabs to keep
 * @returns {{ toClose: object[], hidden: number, closed: number, emptyExtra: number, skipped: number, reason?: string }}
 */
function planClose({ mementoTabs, liveTabsByGroup, hiddenIds, closedIds, keepEmpty = 3, openedTabs }) {
  const result = { toClose: [], hidden: 0, closed: 0, emptyExtra: 0, skipped: 0 };
  if (!Array.isArray(mementoTabs) || mementoTabs.length === 0) return result;
  if (!Array.isArray(liveTabsByGroup) || liveTabsByGroup.length === 0) return result;

  // Step 1: group count must match
  const memoGroupCount = mementoTabs.reduce((max, t) => Math.max(max, t.group + 1), 0);
  if (memoGroupCount !== liveTabsByGroup.length) {
    result.skipped = liveTabsByGroup.length;
    result.reason = `group-count-mismatch (memento=${memoGroupCount} live=${liveTabsByGroup.length})`;
    return result;
  }

  // Step 2: per-group total tab count AND per-position label matching
  const skippedGroups = new Set();
  for (let gi = 0; gi < memoGroupCount; gi++) {
    const memoGroup = mementoTabs.filter(t => t.group === gi);
    const liveGroup = liveTabsByGroup[gi];
    if (!liveGroup || memoGroup.length !== liveGroup.length) {
      skippedGroups.add(gi);
      continue;
    }
    for (let i = 0; i < memoGroup.length; i++) {
      if (!labelsMatch(String(liveGroup[i].label ?? ''), memoGroup[i].title)) {
        skippedGroups.add(gi);
        break;
      }
    }
  }

  result.skipped = skippedGroups.size;
  if (skippedGroups.size === memoGroupCount) {
    result.reason = 'all-groups-skipped';
    return result;
  }

  // Step 3: collect archive decisions for eligible groups
  const eligibleTabs = mementoTabs.filter(t => !skippedGroups.has(t.group));
  const decisions = selectTabsToClose({ tabs: eligibleTabs, hiddenIds, closedIds, keepEmpty });

  // Step 4: map to live Tab references, re-checking active/pinned/dirty
  for (const dec of decisions) {
    const liveGroup = liveTabsByGroup[dec.group];
    if (!liveGroup || dec.index >= liveGroup.length) continue;
    const tab = liveGroup[dec.index];
    // Re-check live tab state — task says to use tab.isDirty, not input.isDirty
    if (tab.isActive) continue;
    if (tab.isPinned) continue;
    if (tab.isDirty) continue;
    // Verify this is still a Claude tab
    if (!tab.input || !String(tab.input.viewType).includes('claudeVSCode')) continue;

    if (dec.reason === 'empty-extra') {
      if (!openedTabs?.has(tab) || tab.label !== 'Claude Code' || result.emptyExtra >= 1) continue;
    }
    result.toClose.push(tab);
    if (dec.reason === 'hidden') result.hidden++;
    else if (dec.reason === 'closed') result.closed++;
    else if (dec.reason === 'empty-extra') result.emptyExtra++;
  }

  return result;
}

module.exports = { parseEditorMemento, activeViewletKeys, selectTabsToClose, planClose };