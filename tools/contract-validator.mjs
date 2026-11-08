// X-0021: Validate outcome contract satisfaction status.
// Takes an OutcomeContract + evidence results → yields pass/fail per criterion.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const toolsDir = path.dirname(fileURLToPath(import.meta.url));
export const repoDir = path.dirname(toolsDir);

export const VERDICT_PASS = 'pass';
export const VERDICT_FAIL = 'fail';
export const VERDICT_PENDING = 'pending';
export const VERDICT_ERROR = 'error';

// Validate a contract against collected evidence.
// Returns { contractId, verdict, results[], summary }
export function validateContract(contract, evidenceResults = [], options = {}) {
  if (!contract || !contract.id) {
    return { verdict: VERDICT_ERROR, results: [], summary: 'No contract provided' };
  }

  const results = [];
  const criteria = contract.criteria || [];
  const evidence = contract.evidence || [];
  const requiredEvidence = options.requiredEvidence || evidence;

  for (const criterion of criteria) {
    const criterionResult = evaluateCriterion(criterion, evidenceResults, requiredEvidence);
    results.push(criterionResult);
  }

  // If no criteria defined, validate based on evidence presence alone
  if (criteria.length === 0) {
    for (const evType of requiredEvidence) {
      const matching = evidenceResults.filter(e => e.type === evType);
      const passed = matching.some(e => e.passed);
      results.push({
        criterion: `Evidence: ${evType}`,
        verdict: passed ? VERDICT_PASS : VERDICT_PENDING,
        evidenceUsed: matching,
      });
    }
  }

  const verdict = results.every(r => r.verdict === VERDICT_PASS) ? VERDICT_PASS
    : results.some(r => r.verdict === VERDICT_FAIL) ? VERDICT_FAIL
    : VERDICT_PENDING;

  return {
    contractId: contract.id,
    verdict,
    results,
    summary: `${results.filter(r => r.verdict === VERDICT_PASS).length}/${results.length} criteria passed`,
    validatedAt: Date.now(),
  };
}

function evaluateCriterion(criterion, evidenceResults, requiredEvidence) {
  const matchingEvidence = evidenceResults.filter(e => {
    const text = `${e.type || ''} ${e.description || ''} ${e.detail || ''}`.toLowerCase();
    const keywords = criterion.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    return keywords.length === 0 || keywords.some(k => text.includes(k));
  });

  const hasPassedEvidence = matchingEvidence.some(e => e.passed);
  const hasFailedEvidence = matchingEvidence.some(e => e.passed === false);
  const hasRelevantType = requiredEvidence.some(t => matchingEvidence.some(e => e.type === t));

  return {
    criterion,
    verdict: hasFailedEvidence ? VERDICT_FAIL
      : hasPassedEvidence && hasRelevantType ? VERDICT_PASS
      : hasPassedEvidence ? VERDICT_PASS
      : hasRelevantType ? VERDICT_PASS
      : VERDICT_PENDING,
    evidenceUsed: matchingEvidence,
  };
}

// Batch validate multiple contracts.
export function validateContracts(contracts, evidenceResults, options = {}) {
  return contracts.map(c => validateContract(c, evidenceResults, options));
}

// Quick check: did a contract pass?
export function isContractSatisfied(result) {
  return result?.verdict === VERDICT_PASS;
}

// Generate human-readable validation report.
export function formatValidationReport(result) {
  if (!result) return 'No validation result';
  const lines = [
    `Contract: ${result.contractId}`,
    `Verdict: ${result.verdict}`,
    `Summary: ${result.summary}`,
    `Time: ${new Date(result.validatedAt).toISOString()}`,
    '',
    'Results:',
  ];
  for (const r of result.results || []) {
    const icon = r.verdict === VERDICT_PASS ? '✅' : r.verdict === VERDICT_FAIL ? '❌' : '⏳';
    lines.push(`  ${icon} ${r.criterion} → ${r.verdict}`);
    for (const ev of r.evidenceUsed || []) {
      lines.push(`    Evidence: ${ev.type} = ${ev.passed ? 'pass' : 'fail'}`);
    }
  }
  return lines.join('\n');
}