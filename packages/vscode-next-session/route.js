// URI のパスから実行内容を決めるだけの純粋関数。vscode モジュールに依存しない
// (単体テストで vscode 無しでも呼べるようにするため)。
//
// - /reload      : ウィンドウ再読み込み（dry=1 なら実際には再読み込みしない）
// - /mobile      : スマホ用の Claude Code タブを指定数まで補充
// - /start, その他: 既存動作（ターミナルでセッション開始）を変えない
function decideAction({ path, query }) {
  const normalizedPath = String(path || '');
  const params = query instanceof URLSearchParams ? query : new URLSearchParams(query || '');
  if (normalizedPath === '/reload') {
    const dry = params.get('dry') === '1';
    return { kind: 'reload', dry };
  }
  if (normalizedPath === '/mobile') {
    const parsedCount = Number.parseInt(params.get('count') || '3', 10);
    const count = Math.min(10, Math.max(1, Number.isFinite(parsedCount) ? parsedCount : 3));
    return { kind: 'mobile', count, name: params.get('name') || 'スマホ用セッション', recreate: params.get('recreate') === '1' };
  }
  return { kind: 'start' };
}

function deadMobileTabCount(labelledTabCount, interactiveSessionCount) {
  const labelled = Math.max(0, Number.parseInt(labelledTabCount, 10) || 0);
  const interactive = Math.max(0, Number.parseInt(interactiveSessionCount, 10) || 0);
  return Math.max(0, labelled - interactive);
}

function shouldRetryMobileTab(failedAttempts, attempts) {
  return failedAttempts < attempts;
}

function mobileTabOpenCommand(claudeTabCount) {
  return claudeTabCount === 0
    ? 'claude-vscode.editor.openLast'
    : 'claude-vscode.newConversation';
}

module.exports = { decideAction, shouldRetryMobileTab, mobileTabOpenCommand, deadMobileTabCount };
