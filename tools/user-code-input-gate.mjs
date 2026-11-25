export const GATE_CONTRACT = {"name":"user-code-input-gate","remedies":[{"kind":"repo-file","ref":"playbooks/codex-delegate.md","section":"再ログイン"}]};

// Ignore Markdown examples, including unclosed fences. Inline code remains prose:
// users are commonly asked to enter a code formatted with backticks.
export function codeInputProse(text) {
  let fence = null;
  return String(text || '').split(/\r?\n/).filter(line => {
    if (/^\s*>/.test(line)) return false;
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
      return false;
    }
    if (marker) { fence = marker[1]; return false; }
    return !/^(?: {4}|\t)/.test(line);
  }).join('\n');
}

export function judgeUserCodeInput(text) {
  const prose = codeInputProse(text);
  const exemption = [...prose.matchAll(/\[CODE-INPUT-UNAVOIDABLE:[ \t]*([^\]\r\n]*)\]/g)]
    .some(([, reason]) => [...reason.trim()].length >= 10);
  const url = /\b(?:auth\.openai\.com\/codex\/device|github\.com\/login\/device|microsoft\.com\/devicelogin|google\.com\/device)(?=$|[\s/?#)\]<>"'`。])/i;
  const code = /\b[A-Z0-9]{4}-[A-Z0-9]{4,5}\b/;
  const triggered = url.test(prose) || (code.test(prose) && /入力|\bEnter\b/i.test(prose));
  if (!triggered || exemption) return { decision: 'pass' };
  return {
    decision: 'block', code: 'USER-CODE-INPUT',
    reason: 'AI で回避できるコード入力を user に頼んでいます。先に①生きている認証情報の複製（auth.json・keyserve・GH_TOKEN）②ブラウザ自動起動型ログイン（Windows の codex login 等）を Claude が起動してください。どちらも実測で不可の時だけ [CODE-INPUT-UNAVOIDABLE: 試した経路と結果] を書き、コードは発行直後に提示し、期限切れなら自動で再発行してください。',
  };
}
