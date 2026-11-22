import { isRealHumanEntry } from './lib/assistant-text.mjs';

export const GATE_CONTRACT = {"name":"no-response-gate","remedies":[{"kind":"repo-file","ref":"tools/gate-remedies.md","section":"no-response-gate"}]};

const NO_RESPONSE = 'No response requested.';
const FEEDBACK = 'Stop hook feedback:';
const CODE = 'NO-RESPONSE';

function messageText(content) {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content.filter(block => block?.type === 'text').map(block => block.text || '').join('\n').trim();
}

export function evaluateNoResponse({ transcriptRaw, stopHookActive, lastAssistantMessage }) {
  const pass = { decision: 'pass' };
  const supplied = typeof lastAssistantMessage === 'string' ? lastAssistantMessage.trim() : undefined;
  if (supplied && supplied !== NO_RESPONSE) return pass;
  const lines = (transcriptRaw || '').split(/\r?\n/);
  let sawAssistant = false;
  let interrupted = false;
  let feedback;
  for (let index = lines.length - 1; index >= 0; index--) {
    let entry;
    try { entry = JSON.parse(lines[index]); } catch { continue; }
    if (!entry || entry.isSidechain === true) continue;
    const role = entry.message?.role || entry.type;
    const content = entry.message?.content;
    const text = messageText(content);

    if (role === 'assistant') {
      if (!sawAssistant && !feedback && !interrupted) {
        if (text && text !== NO_RESPONSE) return pass;
        sawAssistant = true;
      } else if (interrupted && (entry.message?.stop_reason === 'end_turn' || text === NO_RESPONSE)) {
        return pass;
      }
      continue;
    }
    if (role !== 'user') continue;
    if (!sawAssistant && supplied === undefined) return pass;
    if (Array.isArray(content) && content.some(block => block?.type === 'tool_result')) {
      // A refusal ends the check. An interrupted call can still belong to a pending human turn.
      if (feedback) break;
      if (!content.some(block => block?.type === 'tool_result' && /Tool call interrupted/.test(messageText(block.content)))) return pass;
      interrupted = true;
      continue;
    }
    if (text.includes('<task-notification>')) {
      if (feedback) break;
      return pass;
    }
    if (text.startsWith(FEEDBACK)) {
      if (stopHookActive === true && /(?:^|\n)\[NO-RESPONSE\] kim の入力（/.test(text.slice(FEEDBACK.length).trimStart())) return pass;
      feedback ??= text;
      if (interrupted) return pass;
      continue;
    }
    if (!feedback && !isRealHumanEntry(entry)) return pass;
    if (!feedback) {
      feedback = text;
      break;
    }
    break;
  }

  if (!feedback) return pass;
  const preview = [...feedback.split('<system-reminder>')[0].replace(/\s+/g, ' ').trim()].slice(0, 40).join('');
  return {
    decision: 'block',
    code: CODE,
    reason: `[${CODE}] kim の入力（${preview}）に答えていません。依頼として扱い、作業を進めて応答してください`,
  };
}
