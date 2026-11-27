#!/usr/bin/env node
export const GATE_CONTRACT = {"name": "handoff-action-gate", "remedies": [{"kind": "repo-file", "ref": "tools/gate-remedies.md", "section": "handoff-action-gate"}]};
// 手渡しの「書式」ではなく「行動＋証拠」を検証する。判定の実体は handoff-action-evidence.mjs。
import { isEntry } from './is-entry.mjs';
import { readTranscriptContext } from './lib/assistant-text.mjs';
import { findUnbackedExternalHandoff, formatHandoffActionReason } from './handoff-action-evidence.mjs';
import { checkTema, formatTemaFindings } from './lib/tema-check.mjs';

import { missingCardNotice, CARD_NOTICE } from './lib/approval-cards.mjs';

export function evaluateHandoffAction({ text, raw, home, now, cards }) {
  if (missingCardNotice(text, { home, now, cards, raw })) return { decision: 'block', code: 'CARD_NOTICE_REQUIRED', reason: `同じ件の承認カードが表示されています。送信報告に「${CARD_NOTICE}」を入れてください。` };
  const tema = checkTema(text, { kind: 'proposal' });
  const hard = tema.findings.filter((f) => f.code === 'TEMA_PAPER_NO_REASON' || f.code.startsWith('SIGNIN_'));
  if (hard.length) return { decision: 'block', reason: formatTemaFindings(hard), code: hard[0].code };
  const violation = findUnbackedExternalHandoff(text, raw);
  const base = violation
    ? { decision: 'block', reason: formatHandoffActionReason(), code: 'HANDOFF-ACTION' }
    : { decision: 'pass' };
  if (base.decision === 'pass' && tema.findings.length) return { decision: 'pass', warning: formatTemaFindings(tema.findings), code: 'TEMA_WARN' };
  return base;
}

export function evaluateHandoffActionFromRaw({ text, transcriptRaw, ...options }) {
  return evaluateHandoffAction({ text, raw: transcriptRaw, ...options });
}

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  try {
    if (!raw.trim()) return;
    const input = JSON.parse(raw);
    const context = readTranscriptContext(input?.transcript_path);
    const text = input?.assistant_text || context.assistantText;
    if (!text) return;
    const transcriptRaw = input?.transcript_raw || context.raw;
    const result = evaluateHandoffActionFromRaw({ text, transcriptRaw, ...options });
    if (result.decision === 'block') console.log(JSON.stringify({ decision: 'block', reason: result.reason }));
    else if (result.warning) console.log(JSON.stringify({ systemMessage: result.warning }));
  } catch {
    // 想定外エラーは他ゲートと同じく fail-open。
  }
}

if (isEntry(import.meta.url)) await main();
