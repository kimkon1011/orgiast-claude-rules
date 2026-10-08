#!/usr/bin/env node
import fs from 'node:fs';
import { isEntry } from './is-entry.mjs';
import { readStdinWithTimeout } from './lib/hook-stdin.mjs';
import { laneHome } from './lane-doctor.mjs';
import { turnEvents, resultText, exemptions, currentModel, appendCorrection, safeText } from './lane-abandonment-gate.mjs';

export function evaluateCourseCorrections(ctx, { home = laneHome(), rules = JSON.parse(fs.readFileSync(new URL('./course-corrections.json', import.meta.url), 'utf8')) } = {}) {
  const events = turnEvents(ctx.transcriptRaw || '');
  // 引用・コードブロックは user への現行の主張として扱わない。
  const text = String(ctx.assistantText || '').replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, '').replace(/^\s*>.*$/gm, '');
  const violations = [];
  for (const rule of rules) {
    const textPatterns = (rule.detectText || []).map(p => new RegExp(p, 'i'));
    const evidencePatterns = (rule.detectEvidence || []).map(p => new RegExp(p, 'i'));
    const textHit = textPatterns.some(p => p.test(text));
    const evidenceIndex = events.findIndex(e => e.type === 'tool_result' && evidencePatterns.some(p => p.test(resultText(e.content))));
    // 証跡だけの一致は台帳への警告に留め、放置の判定は lane-abandonment-gate に任せる。
    const hit = textHit || evidenceIndex >= 0;
    const exempt = rule.gate === 'lane-abandonment-gate' && (exemptions(ctx, events, evidenceIndex) || /sonnet|haiku/i.test(currentModel(ctx)));
    if (!hit || exempt) continue;
    const verdict = textHit && rule.severity === 'block' ? 'block' : 'warn';
    try { appendCorrection(home, { sessionId: ctx.sessionId || '', gate: 'course-correction', id: rule.id, verdict, signals: [rule.id], excerpt: text }); } catch {}
    if (verdict === 'block') violations.push(`[${rule.id}] ${rule.rule}。修復: ${rule.fix || '規則に従って修正し、再検証する。'}`);
  }
  return { decision: violations.length ? 'block' : 'pass', code: 'COURSE-CORRECTION', reason: safeText(violations.join('\n')) };
}
export async function main() {
  const input = JSON.parse(await readStdinWithTimeout());
  const transcriptRaw = input.transcriptRaw ?? (input.transcript_path ? fs.readFileSync(input.transcript_path, 'utf8') : '');
  const result = evaluateCourseCorrections({ ...input, input, transcriptRaw, assistantText: input.assistantText || input.assistant_text || '', sessionId: input.session_id });
  if (result.decision === 'block') console.log(JSON.stringify(result));
}
if (isEntry(import.meta.url)) await main();
