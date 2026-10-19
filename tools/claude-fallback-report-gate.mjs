export const GATE_CONTRACT = {"name":"claude-fallback-report-gate","remedies":[{"kind":"command","ref":"他AIのキー登録・デプロイ・入金依頼までその場で直すか、全他AIが不可である実測を示して [CLAUDE-FALLBACK-OK] <理由> を書く"}]};

const BLOCK_REASON = 'Claude への誘導を報告で残している（§2.8.0 6〜7）。他AIのキー登録・デプロイ・入金依頼までその場で直すか、全他AIが不可である実測を示して [CLAUDE-FALLBACK-OK] <理由> を書く';
const claudeFallback = /当面は\s*Claude|Claude(?:\s*\((?:Haiku|Sonnet|Opus)\)|\s+(?:Haiku|Sonnet|Opus))?\s*で動きます|Claude\s*にフォールバック|Claude\s*で代替|Claude\s*のまま|Claude\s*に戻(?:す|し)|(?:for now|temporarily)\s+(?:use|run on)\s+Claude|fallback to Claude|use Claude as (?:a )?(?:fallback|substitute)|stay on Claude|(?:return|revert|switch back) to Claude/i;
const otherAiNoPayment = /(?:Kimi|Moonshot|Gemini|DeepSeek|Groq|OpenRouter|Perplexity|Grok|xAI|Mistral|GLM|Codex).{0,30}(?:(?:入金|チャージ|残高|追加).{0,20}(?:必須では(?:ない|ありません)|不要|任意|しなくて(?:よい|いい|も)|判断(?:する|して)?)|(?:deposit|top[ -]?up|balance).{0,10}(?:not required|unnecessary|optional|no need))/i;

function withoutQuotes(text) {
  let fenced = false;
  return String(text || '').split(/\r?\n/).map(line => {
    if (/^\s*```/.test(line)) { fenced = !fenced; return ''; }
    if (fenced || /^\s*>/.test(line)) return '';
    return line.replace(/「[^」]*」/g, '');
  }).join('\n');
}

export function evaluateClaudeFallbackReport(text) {
  const source = String(text || '');
  const ok = source.match(/\[CLAUDE-FALLBACK-OK\]([^\r\n]*)/);
  if (ok && ok[1].trim().length >= 10) return { decision: 'pass' };
  const inspect = withoutQuotes(source);
  if (claudeFallback.test(inspect) || otherAiNoPayment.test(inspect)) {
    return { decision: 'block', code: 'CLAUDE-FALLBACK', reason: BLOCK_REASON };
  }
  return { decision: 'pass' };
}
