'use strict';

function tabMatchesSession(tab, sessionId) {
  if (!sessionId || !String(tab?.input?.viewType || '').includes('claudeVSCode')) return false;
  // Never match an eight-character prefix: multiple sessions can share it.
  return [tab.label, tab.input.viewType].some(value =>
    String(value || '').split(/[^a-zA-Z0-9_-]+/).includes(sessionId));
}

function findSessionTabs(tabs, sessionId, mementoTabs = []) {
  if (!sessionId) return [];
  const claude = tabs.filter(tab => String(tab?.input?.viewType || '').includes('claudeVSCode'));
  return claude.filter(tab => {
    if (tabMatchesSession(tab, sessionId)) return true;
    // Actual 2.1.319 tabs have a shared viewType and a title, not a session ID.
    // Serialized webview state contains sessionID. Only an exact, unique title
    // on both sides can map that persisted ID back to a live Tab object.
    const title = String(tab.label || '');
    if (!title || title === 'Claude Code') return false;
    const saved = mementoTabs.filter(item => item.isClaude && item.title === title);
    return saved.length === 1 && saved[0].sessionId === sessionId
      && claude.filter(other => other.label === title).length === 1;
  });
}

async function reopenSession({ sessionId, tabs, mementoTabs, close, open }) {
  const targets = findSessionTabs(tabs(), sessionId, mementoTabs);
  if (targets.length && !await close(targets)) throw new Error('reopen: 対象タブを閉じられませんでした');
  if (!await open(`vscode://anthropic.claude-code/open?session=${encodeURIComponent(sessionId)}`)) {
    throw new Error('reopen: 公式拡張 URI を開けませんでした');
  }
  return { closed: targets.length };
}

module.exports = { tabMatchesSession, findSessionTabs, reopenSession };
