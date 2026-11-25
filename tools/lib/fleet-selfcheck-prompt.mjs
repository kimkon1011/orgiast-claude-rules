// Exact, versioned allowlist: mentioning selfcheck anywhere in arbitrary prose
// must never bypass the fleet-mail configuration-distribution guard.
export const SELFCHECK_PROMPT = [
  '[読み取り専用自己点検 v2]',
  'node tools/fleet-selfcheck.mjs を実行し、標準出力のMarkdown表をそのまま返信してください。',
  '確認対象: .claude.json のアカウント、hostname、REPORTER_LABEL、配布物、case-handoff、Gmail・Drive・Discord・LINE（Gmail・Drive・LINEは鍵なしのenroll APIを含む）。',
  '設定変更・インストール・ファイル書き込み・各連絡手段での送信は行わないでください。',
  'コマンドが無い場合はそのエラーを返信し、通常の setup --converge による配布を待ってください。',
].join('\n');

export const READONLY_PROMPT_ALLOWLIST = Object.freeze([Object.freeze({
  id: 'fleet-selfcheck-v2',
  reason: '固定の fleet-selfcheck はローカル読取とリモートGETのみ。OAuthトークン取得以外のPOST・保存・設定変更・送信を行わない。',
  body: SELFCHECK_PROMPT,
})]);

export function allowedReadonlyPrompt(body) {
  const normalized = String(body ?? '').replace(/\r\n/g, '\n').trim();
  return READONLY_PROMPT_ALLOWLIST.find(entry => entry.body === normalized) ?? null;
}
