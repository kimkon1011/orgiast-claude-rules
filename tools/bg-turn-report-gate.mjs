export const GATE_CONTRACT = {"name": "bg-turn-report-gate", "remedies": [{"kind": "repo-file", "ref": "tools/gate-remedies.md", "section": "bg-turn-report-gate"}]};

import { isRealHumanEntry } from './lib/assistant-text.mjs';

const REASON = 'バックグラウンドの結果を報告せずに終わろうとしています。①結果（成功／失敗とその証拠）②次の自動進行 を書き、`node tools/notify-kim.mjs --kind info "<進捗報告>"` で kim-inbox に progress（info 種別）を積んでから終えること';
const contentText = content => typeof content === 'string' ? content : Array.isArray(content)
  ? content.filter(b => b?.type === 'text').map(b => b.text || '').join('\n') : '';

// Inspect only the latest notification response, never text/evidence from an earlier turn.
export function judgeBgTurnReport(raw, input = {}) {
  if (input.stop_hook_active) return { decision: 'pass' };
  let humanTime = NaN;
  let notified = false;
  let text = false;
  let delivered = false;
  const calls = new Set();
  for (const line of String(raw || '').split(/\r?\n/)) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (!entry || entry.isSidechain === true) continue;
    const role = entry.message?.role || entry.type;
    const content = entry.message?.content;
    const parts = Array.isArray(content) ? content : [];
    const notification = role === 'user' && !parts.some(b => b?.type === 'tool_result')
      && /^\s*<task-notification>/.test(contentText(content));
    if (isRealHumanEntry(entry) || notification) {
      if (!notification) humanTime = Date.parse(entry.timestamp);
      notified = notification;
      text = false;
      delivered = false;
      calls.clear();
    }
    if (!notified) continue;
    if (role === 'assistant') {
      if (contentText(content).trim()) text = true;
      for (const tool of parts) {
        if (tool?.type !== 'tool_use' || !/^(?:Bash|PowerShell)$/.test(tool.name || '')) continue;
        const cmd = String(tool.input?.command || tool.input?.script || '');
        if (/(?:^|[;&|\n])\s*(?:&\s*)?(?:node(?:\.exe)?|["'][^"'\r\n]*[\\/]node(?:\.exe)?["'])\s+["']?(?:[^\s"']*[\\/])?notify-kim\.mjs["']?\s+\S/i.test(cmd)
          && !/--(?:help|dry-run)\b/.test(cmd) && tool.id) calls.add(tool.id);
      }
    }
    if (role === 'user') for (const result of parts) {
      if (result?.type !== 'tool_result' || result.is_error || !calls.has(result.tool_use_id)) continue;
      for (const output of contentText(result.content).split(/\r?\n/)) {
        try {
          const receipt = JSON.parse(output);
          if (receipt?.delivered === 'session-inbox' && receipt.id && receipt.kind === 'info') delivered = true;
        } catch { /* Only the CLI's structured success receipt is evidence. */ }
      }
    }
  }
  if (!notified) return { decision: 'pass' };
  const age = (input.now ?? Date.now()) - humanTime;
  const present = Number.isFinite(age) && age >= 0 && age <= 10 * 60_000;
  if (!text || (!delivered && !present)) return { decision: 'block', code: 'BG-TURN-REPORT', reason: REASON };
  return { decision: 'pass' };
}
