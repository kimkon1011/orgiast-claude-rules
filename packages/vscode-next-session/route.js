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
    const parsedCount = Number.parseInt(params.get('count') || '1', 10);
    const count = Math.min(10, Math.max(1, Number.isFinite(parsedCount) ? parsedCount : 1));
    return { kind: 'mobile', count, name: params.get('name') || 'スマホ用セッション' };
  }
  return { kind: 'start' };
}

function shouldRetryMobileTab(failedAttempts, attempts) {
  return failedAttempts < attempts;
}

function mobileTabOpenCommand(claudeTabCount) {
  return claudeTabCount === 0
    ? 'claude-vscode.editor.openLast'
    : 'claude-vscode.newConversation';
}

// 作成手段の多段フォールバック。1 回の試行でこの順に試し、タブ総数が増えた時点で成功。
// 直近で成功した手段を先頭に寄せ、次回はそれを最初に試す。
const MOBILE_OPEN_METHODS = ['newConversation', 'editorOpen', 'externalUri'];

function orderMobileOpenMethods(lastGood) {
  if (!MOBILE_OPEN_METHODS.includes(lastGood)) return [...MOBILE_OPEN_METHODS];
  return [lastGood, ...MOBILE_OPEN_METHODS.filter((method) => method !== lastGood)];
}

// 失敗後の再試行ポリシー。状態は「最終試行時刻・連続失敗回数・直近1時間の試行時刻」。
// 失敗から 30 秒で再試行可、連続 5 失敗で 10 分休止、1 時間あたり最大 20 回。
const RETRY_COOLDOWN_MS = 30000;
const RETRY_PAUSE_AFTER = 5;
const RETRY_PAUSE_MS = 600000;
const RETRY_MAX_PER_HOUR = 20;
const HOUR_MS = 3600000;

function newRetryState() { return { lastAttemptAt: 0, consecutiveFailures: 0, attempts: [] }; }

function canAttemptMobileOpen(state, now) {
  const recent = state.attempts.filter((at) => now - at < HOUR_MS);
  if (recent.length >= RETRY_MAX_PER_HOUR) return false;
  if (state.consecutiveFailures >= RETRY_PAUSE_AFTER && now - state.lastAttemptAt < RETRY_PAUSE_MS) return false;
  if (state.consecutiveFailures > 0 && now - state.lastAttemptAt < RETRY_COOLDOWN_MS) return false;
  return true;
}

function recordMobileOpenAttempt(state, now, succeeded) {
  return {
    lastAttemptAt: now,
    consecutiveFailures: succeeded ? 0 : state.consecutiveFailures + 1,
    attempts: [...state.attempts.filter((at) => now - at < HOUR_MS), now],
  };
}

module.exports = {
  decideAction, shouldRetryMobileTab, mobileTabOpenCommand,
  MOBILE_OPEN_METHODS, orderMobileOpenMethods, newRetryState, canAttemptMobileOpen, recordMobileOpenAttempt,
};
