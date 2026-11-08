// 画像のみの質問も人間のターン。hook の擬似 user 発言は除く。
const MACHINE_PREFIXES = ['<local-command', '<command-name', '<command-message', '<command-args', '<task-notification', '<system-reminder', '<local-command-stdout', 'Stop hook feedback:'];
export function entryText(entry) {
  const content = entry?.message?.content;
  return Array.isArray(content) ? content.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n') : typeof content === 'string' ? content : '';
}
export function isHumanEntry(entry) {
  if (entry?.isSidechain === true || entry?.type !== 'user') return false;
  const content = entry.message?.content;
  if (Array.isArray(content) && content.some(b => b?.type === 'tool_result')) return false;
  const text = entryText(entry).trimStart();
  return !MACHINE_PREFIXES.some(p => text.startsWith(p)) && (Boolean(text) || (Array.isArray(content) && content.some(b => b?.type === 'image')));
}
export function transcriptEntries(raw) {
  return String(raw || '').split(/\r?\n/).flatMap(line => { try { const entry = JSON.parse(line); return entry && entry.isSidechain !== true ? [entry] : []; } catch { return []; } });
}
