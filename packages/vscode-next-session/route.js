// URI のパスから実行内容を決めるだけの純粋関数。vscode モジュールに依存しない
// (単体テストで vscode 無しでも呼べるようにするため)。
//
// - /reload      : ウィンドウ再読み込み（dry=1 なら実際には再読み込みしない）
// - /start, その他: 既存動作（ターミナルでセッション開始）を変えない
function decideAction({ path, query }) {
  const normalizedPath = String(path || '');
  if (normalizedPath === '/reload') {
    const params = query instanceof URLSearchParams ? query : new URLSearchParams(query || '');
    const dry = params.get('dry') === '1';
    return { kind: 'reload', dry };
  }
  return { kind: 'start' };
}

module.exports = { decideAction };
