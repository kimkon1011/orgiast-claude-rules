// cheap-code / codex-do 共通: unrecognized_model 空振りレーン判定。
// import のみで副作用を持たない（ファイル I/O・spawn・環境変数書き込みなし）。

export const MODEL_WARNING_LINE = /^\s*\[claude-code:unrecognized_model\]/;
export const CHEAP_CODE_BANNER = /^\[(?:openrouter|glm):[^\]\r\n]+\]$/;

export function modelWarningRemainder(output, stderr) {
  // cheap-code は回答の有無にかかわらず provider と model を stderr に出す。
  const stdoutLines = String(output || '').split(/\r?\n/);
  const stderrLines = String(stderr || '').split(/\r?\n/).filter(line => !CHEAP_CODE_BANNER.test(line));
  return [...stdoutLines, ...stderrLines].filter(line => !MODEL_WARNING_LINE.test(line)).join('\n').trim();
}

export function hasModelWarning(text) {
  return String(text || '').split(/\r?\n/).some(line => MODEL_WARNING_LINE.test(line));
}

export function isLaneIncompatible(output, stderr, status) {
  return (hasModelWarning(output) || hasModelWarning(stderr)) && (status !== 0 || !modelWarningRemainder(output, stderr));
}
