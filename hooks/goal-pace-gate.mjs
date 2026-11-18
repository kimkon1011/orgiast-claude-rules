#!/usr/bin/env node
export const GATE_CONTRACT = {"name":"goal-pace-gate","remedies":[{"kind":"repo-file","ref":"docs/case-goals.md"}]};
import { isEntry } from '../tools/is-entry.mjs';
import { latestAssistantText } from '../tools/lib/assistant-text.mjs';
import { readStdinWithTimeout } from '../tools/lib/hook-stdin.mjs';
import { contextGoals, remainingDays, goalHome } from '../tools/lib/case-goals.mjs';

const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function judge(input, { home = goalHome(), now = Date.now() } = {}) {
  try {
    const goals = contextGoals({ home, sessionId: input.session_id, text: '' }).filter(g => remainingDays(g.deadline, now) >= 0);
    if (!goals.length) return { decision: 'pass' };
    const text = String(input.last_assistant_message ?? input.assistant_text ?? input.text ?? latestAssistantText(input.transcript_path)).normalize('NFKC').replace(/```[\s\S]*?```/g, '');
    for (const g of goals) {
      const re = new RegExp(`【目標進捗】${escape(g.metric.normalize('NFKC'))}:\\s*目標\\s+${g.target}\\s*/\\s*現状\\s+${g.current}\\s*/\\s*期日\\s+${g.deadline}\\s*/\\s*必要ペース\\s+([^\\n]+)`);
      const match = re.exec(text);
      const block = detail => ({ decision: 'block', code: 'GOAL-PACE', reason: `[GOAL-PACE] ${g.caseId} ${g.metric}: ${detail}。台帳は node tools/case-goals.mjs show ${g.caseId} で確認。最終本文に「【目標進捗】${g.metric}: 目標 ${g.target} / 現状 ${g.current} / 期日 ${g.deadline} / 必要ペース 数/日」を記載し、残り7日以内で未達なら同じ節に「遅れ」と具体的な送信数または別経路の打ち手を書く。` });
      if (!match || !/\d/.test(match[1]) || /^(?:未定|不明|…|\.\.\.)/.test(match[1].trim())) return block('台帳と一致する進捗行・数値ペースがありません');
      // One goal's paragraph ends at a blank line, heading, or next progress row.
      const section = text.slice(match.index).split(/\n\s*\n|\n\s*#{1,6}\s|\n(?=.*【目標進捗】)/)[0];
      if (g.current < g.target && remainingDays(g.deadline, now) <= 7 && (!/遅れ/.test(section)
        || !/(?:送信[^\n。]{0,24}\d+\s*(?:社|件|通)|\d+\s*(?:社|件|通)[^\n。]{0,24}送信|別経路\s*[:：でとしては]*\s*(?:LINE|Beeper|メール|電話|紹介|訪問|フォーム|Discord))/iu.test(section))) return block('遅れと打ち手が同じ節にありません');
    }
    return { decision: 'pass' };
  } catch (e) { return { decision: 'block', code: 'GOAL-PACE', reason: `[GOAL-PACE] 目標台帳を確認できません: ${e.message}` }; }
}
export async function main() {
  try { const result = judge(JSON.parse(await readStdinWithTimeout())); if (result.decision === 'block') console.log(JSON.stringify(result)); }
  catch (e) { console.log(JSON.stringify({ decision: 'block', reason: `[GOAL-PACE] hook入力を確認できません: ${e.message}` })); }
}
if (isEntry(import.meta.url)) await main();
