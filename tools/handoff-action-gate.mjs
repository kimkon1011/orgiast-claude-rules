#!/usr/bin/env node
export const GATE_CONTRACT = {"name": "handoff-action-gate", "remedies": [{"kind": "repo-file", "ref": "tools/gate-remedies.md", "section": "handoff-action-gate"}]};
// 手渡しの「書式」ではなく「行動＋証拠」を検証する。判定の実体は handoff-action-evidence.mjs。
import { isEntry } from './is-entry.mjs';
import { readTranscriptContext } from './lib/assistant-text.mjs';
import { findUnbackedExternalHandoff, formatHandoffActionReason } from './handoff-action-evidence.mjs';

export function evaluateHandoffAction({ text, raw }) {
  const violation = findUnbackedExternalHandoff(text, raw);
  return violation
    ? { decision: 'block', reason: formatHandoffActionReason(), code: 'HANDOFF-ACTION' }
    : { decision: 'pass' };
}

export function evaluateHandoffActionFromRaw({ text, transcriptRaw }) {
  return evaluateHandoffAction({ text, raw: transcriptRaw });
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
    const result = evaluateHandoffActionFromRaw({ text, transcriptRaw });
    if (result.decision === 'block') console.log(JSON.stringify({ decision: 'block', reason: result.reason }));
  } catch {
    // 想定外エラーは他ゲートと同じく fail-open。
  }
}

if (isEntry(import.meta.url)) await main();
