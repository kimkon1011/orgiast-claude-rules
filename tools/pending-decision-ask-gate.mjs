export const GATE_CONTRACT = { name: 'pending-decision-ask-gate', remedies: [{ kind: 'repo-file', ref: 'tools/gate-remedies.md', section: 'pending-decision-ask-gate' }] };
import { stripInboxSection } from './lib/inbox-section-filter.mjs';

const PENDING = /(?:(?:kim|キム|社長|金さん)(?:さん)?の?)?判断待ち/i;
const STOPWORDS = /^(?:どちらも|止めたまま|社長|kim|キム|金さん|判断待ち|確認|状態|対応)$/i;

export function subjectOf(line) {
  const cells = line.split('|').map(s => s.trim()).filter(Boolean);
  let head = cells.length >= 2 ? cells[0] : line.split(/[：:|]/, 1)[0];
  head = head.replace(/^[-*#\s]+/, '').trim();
  const candidates = head.match(/[A-Za-z][A-Za-z0-9・+＆&／/ _-]{2,}|[一-龠ァ-ヶー]{3,}/g) || [];
  return candidates.map(s => s.trim()).find(s => s.length >= 3 && !STOPWORDS.test(s)) || '';
}

export function evaluatePendingDecision(text) {
  const body = stripInboxSection(String(text || ''));
  const lines = body.split(/\r?\n/);
  const sectionIndex = lines.findIndex(line => /【kim 確認用の全文】|次に kim がすること/i.test(line));
  const confirmation = sectionIndex >= 0 ? lines.slice(sectionIndex).join('\n') : '';
  for (let i = 0; i < (sectionIndex >= 0 ? sectionIndex : lines.length); i++) {
    if (!PENDING.test(lines[i])) continue;
    const subject = subjectOf(lines[i]);
    if (!subject || !confirmation.toLowerCase().includes(subject.toLowerCase())) {
      const shown = subject || lines[i].replace(/\|/g, ' ').trim().slice(0, 40);
      return { decision: 'block', code: 'PENDING-DECISION-NOT-ASKED', reason: `「判断待ち」と書いた ${shown} を kim に聞いていない。【kim 確認用の全文】に選択肢と推奨を付けて入れるか、Claude が決めて進める` };
    }
  }
  return { decision: 'pass' };
}
