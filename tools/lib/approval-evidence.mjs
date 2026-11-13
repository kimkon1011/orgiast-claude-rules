import fs from 'node:fs';

export function readEvidence(input) {
  const rows = input.transcript ?? fs.readFileSync(input.transcript_path, 'utf8').split(/\r?\n/).filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } });
  return rows.filter(e => e && !e.isSidechain && !e.isMeta && !e.isCompactSummary && (!input.session_id || !e.sessionId || e.sessionId === input.session_id));
}
export const contentOf = e => e.message?.content ?? e.content;
export const roleOf = e => e.message?.role ?? e.type;
export function textOf(e) {
  const c = contentOf(e);
  return typeof c === 'string' ? c : (c ?? []).filter(b => b.type === 'text').map(b => b.text).join('\n');
}
export function human(e) {
  return roleOf(e) === 'user' && !(Array.isArray(contentOf(e)) && contentOf(e).some(b => b.type === 'tool_result')) && !/^\s*<(?:system-reminder|task-notification|local-command|command-name)/.test(textOf(e));
}
export function approved(text, kind) {
  const s = text.trim();
  if (/送らないで|送信しないで|消さないで|削除しないで|まだ送らない|待って|やめて|取り消し|取消|禁止|不可|ダメ|駄目|\bNG\b|(?:よい|いい)か(?:[?？]?$|確認)|ません|(?:OK|はい|承認)(?:では|じゃ)?ない|\b(?:not|no|don't|stop)\b/i.test(s)) return false;
  if (kind === 'mail' && /おくらないで|まだおくらない/.test(s)) return false;
  // Reaffirming a send instruction may be a question; revocations above still win.
  if (kind === 'mail' && /(?:送って|おくって|送信して)(?:と|って)(?:言|い)っ(?:た|ている|てる)(?:のに|よね|でしょ|じゃん|はず|んだけど|んですが|けど|[、。！]|？?$)/.test(s)) return true;
  if (/[?？]$/.test(s)) return false;
  if (/(?:^|[^a-z])OK\s*(?:です)?[!！。\s]*$/i.test(s) || /^(?:はい|YES|承認します)[!！。\s]*$/i.test(s)) return true;
  return kind === 'mail' ? /(?:送って|おくって|送っといて|おくっといて|送信して)(?:よい|いい|ください|下さい)?|送信を許可/.test(s)
    : /削除して(?:よい|いい|ください|下さい)?|消して(?:よい|いい|ください|下さい)?|削除を許可/.test(s);
}
export function approvedAfter(rows, matches, kind) {
  // The latest human turn controls consent; tool results never count as consent/revocation.
  let u = -1;
  for (let i = 0; i < rows.length; i++) if (human(rows[i])) u = i;
  if (u < 0 || !approved(textOf(rows[u]), kind)) return false;
  for (let i = u - 1; i >= 0; i--) {
    if (human(rows[i])) break;
    if (roleOf(rows[i]) === 'assistant' && matches(textOf(rows[i]))) return true;
  }
  return false;
}
// Keep Windows path separators; never execute shell text while inspecting it.
export function shellTokens(command) {
  return (String(command).match(/"[^"\n]*"|'[^'\n]*'|[^\s"';&|]+|[;&|\n]+/g) ?? []).map(t => t.replace(/^(["'])([\s\S]*)\1$/, '$2'));
}
export function shellSegments(command) {
  const segments = [[]];
  for (const t of shellTokens(command)) { if (/^[;&|\n]+$/.test(t)) segments.push([]); else segments.at(-1).push(t); }
  return segments.filter(s => s.length).flatMap(args => {
    const exe = args[0].split(/[\\/]/).at(-1).replace(/\.exe$/i, '').toLowerCase();
    if (['bash', 'sh', 'zsh', 'powershell', 'pwsh', 'cmd'].includes(exe)) {
      const i = args.findIndex(t => /^(?:-[lc]*c|-Command|\/c)$/i.test(t));
      if (i >= 0 && args[i + 1]) return shellSegments(args.slice(i + 1).join(' '));
    }
    return [args];
  });
}
export function option(tokens, name) {
  const i = tokens.indexOf(name);
  return i >= 0 ? tokens[i + 1] : tokens.find(t => t.startsWith(`${name}=`))?.slice(name.length + 1);
}
export function outputDecision(result) {
  if (result.decision === 'block') console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: result.reason } }));
}
