import { findUnbackedExternalHandoff, formatHandoffActionReason } from '../handoff-action-evidence.mjs';

export function checkHandoffActionEvidence(transcriptRaw, text = '') {
  if (!transcriptRaw || typeof transcriptRaw !== 'string' || !transcriptRaw.trim()) {
    return { decision: 'pass' };
  }
  const violation = findUnbackedExternalHandoff(text, transcriptRaw);
  if (violation) {
    return {
      decision: 'block',
      actionBlock: true,
      code: 'HANDOFF-ACTION',
      reason: formatHandoffActionReason()
    };
  }
  return { decision: 'pass' };
}
