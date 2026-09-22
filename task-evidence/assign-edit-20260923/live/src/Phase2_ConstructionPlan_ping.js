/** Fable5 model id 疎通確認用 */
function Phase2_Fable5_ping() {
  const res = ClaudeClient_call({
    model: CLAUDE_MODEL_HQ,
    userMessage: 'JSON 一行で {"ok":true} とだけ返してください。',
    maxTokens: 50
  });
  return { text: res.text || '(empty)', usage: res.usage };
}
