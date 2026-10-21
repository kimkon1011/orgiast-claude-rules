export const GATE_CONTRACT = {"name":"claude-fallback-report-gate","remedies":[{"kind":"command","ref":"他AIのキー登録・デプロイ・入金依頼までその場で直すか、全他AIが不可である実測を示して [CLAUDE-FALLBACK-OK] <理由> を書く"}]};

const BLOCK_REASON = 'Claude への誘導を報告で残している（§2.8.0 6〜7）。他AIのキー登録・デプロイ・入金依頼までその場で直すか、全他AIが不可である実測を示して [CLAUDE-FALLBACK-OK] <理由> を書く';
const claudeFallback = /当面は\s*Claude|Claude(?:\s*\((?:Haiku|Sonnet|Opus)(?:\s+\d+(?:\.\d+)?)?\)|\s+(?:Haiku|Sonnet|Opus)(?:\s+\d+(?:\.\d+)?)?)?\s*で動きます|Claude\s*にフォールバック|Claude\s*で代替|Claude\s*のまま|Claude\s*に戻(?:す|し)|(?:for now|temporarily)\s+(?:use|run on)\s+Claude|fallback to Claude|use Claude as (?:a )?(?:fallback|substitute)|stay on Claude|(?:return|revert|switch back) to Claude/i;
const negatedContext = /ない|ません|なく|ではなく|削除|やめ|禁止|避け|不要|unnecessary/i;
const otherAiNoPayment = /(?:Kimi|Moonshot|Gemini|DeepSeek|Groq|OpenRouter|Perplexity|Grok|xAI|Mistral|GLM|Codex).{0,30}(?:(?:入金|チャージ|残高|追加).{0,20}(?:必須では(?:ない|ありません)|不要|任意|しなくて(?:よい|いい|も)|判断(?:する|して)?)|(?:deposit|top[ -]?up|balance).{0,10}(?:not required|unnecessary|optional|no need))/i;

function withoutQuotes(text) {
  const lines = String(text || '').split(/\r?\n/);
  const fences = lines.map((line, index) => /^\s*```/.test(line) ? index : -1).filter(index => index >= 0);
  const hidden = new Set();
  for (let i = 0; i + 1 < fences.length; i += 2) {
    for (let line = fences[i]; line <= fences[i + 1]; line++) hidden.add(line);
  }
  return lines.map((line, index) => hidden.has(index) || /^\s*>/.test(line) ? '' : line.replace(/「[^」]*」/g, '')).join('\n');
}

export function evaluateClaudeFallbackReport(text) {
  const inspect = withoutQuotes(text);
  if (/^\[CLAUDE-FALLBACK-OK\][ \t]+\S.{9,}$/m.test(inspect)) return { decision: 'pass' };
  const sentences = inspect.split(/[。.!！?？\r\n]+/).map(sentence => sentence.trim()).filter(Boolean);
  if (inspect.includes(BLOCK_REASON) || sentences.some(sentence => claudeFallback.test(sentence) && !negatedContext.test(sentence)) || otherAiNoPayment.test(inspect)) {
    return { decision: 'block', code: 'CLAUDE-FALLBACK', reason: BLOCK_REASON };
  }
  return { decision: 'pass' };
}
