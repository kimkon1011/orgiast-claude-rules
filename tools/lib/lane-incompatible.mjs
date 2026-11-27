// cheap-code / codex-do 共通: unrecognized_model 空振りレーン判定。
// import のみで副作用を持たない（ファイル I/O・spawn・環境変数書き込みなし）。

export const MODEL_WARNING_LINE = /^\s*\[claude-code:unrecognized_model\]/;
export const CHEAP_CODE_BANNER = /^\[(?:openrouter|glm):[^\]\r\n]+\]$/;
// 作業前の環境ノイズ（未 trust ワークスペースで permissions.allow を無視する警告）。
// Ignoring 行に続きのヒントが同梱される場合と、行が分かれる場合の両方を落とす。
// 実データは "1 ... entry"（単数・11/25-8）と "114 ... entries"（複数・11/27-8）の両方がある。
export const TRUST_WARNING_LINE = /^\s*Ignoring \d+ permissions\.allow entr(?:y|ies) from .*\bthis workspace has not been trusted\b/;
export const TRUST_DIALOG_HINT_LINE = /^\s*Run Claude Code interactively here once and accept the trust dialog/;

function isEnvironmentNoiseLine(line) {
  return MODEL_WARNING_LINE.test(line)
    || TRUST_WARNING_LINE.test(line)
    || TRUST_DIALOG_HINT_LINE.test(line);
}

export function modelWarningRemainder(output, stderr) {
  // cheap-code は回答の有無にかかわらず provider と model を stderr に出す。
  const stdoutLines = String(output || '').split(/\r?\n/);
  const stderrLines = String(stderr || '').split(/\r?\n/).filter(line => !CHEAP_CODE_BANNER.test(line));
  return [...stdoutLines, ...stderrLines].filter(line => !isEnvironmentNoiseLine(line)).join('\n').trim();
}

export function hasModelWarning(text) {
  return String(text || '').split(/\r?\n/).some(line => MODEL_WARNING_LINE.test(line));
}

export function isLaneIncompatible(output, stderr, status) {
  return (hasModelWarning(output) || hasModelWarning(stderr)) && (status !== 0 || !modelWarningRemainder(output, stderr));
}
