// X-0021: Match collected evidence against contract conditions.
// Evaluates whether evidence satisfies each contract requirement.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateContract } from './contract-validator.mjs';

export const toolsDir = path.dirname(fileURLToPath(import.meta.url));
export const repoDir = path.dirname(toolsDir);

// Verification filters to map evidence to contract criteria.
// Returns the matched evidence entries for a given criterion.
export function matchEvidenceToCriterion(criterion, evidenceList) {
  const keywords = extractKeywords(criterion);
  return evidenceList.filter(ev => {
    const text = `${ev.type} ${ev.description} ${ev.detail}`.toLowerCase();
    // All keywords must appear (AND logic)
    return keywords.length === 0 || keywords.every(k => text.includes(k));
  });
}

// Extract significant keywords from a criterion string.
function extractKeywords(text) {
  const words = text.toLowerCase()
    .replace(/[^a-z0-9　-〿぀-ゟ゠-ヿ一-鿿_-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2);
  // Remove common stopwords
  const stopwords = new Set(['the', 'and', 'for', 'that', 'this', 'with', 'from', 'should', 'must', 'will', 'have', 'been', 'are', 'not']);
  return words.filter(w => !stopwords.has(w));
}

// Verify a contract against collected evidence with detailed matching.
// Returns enhanced validation with match-level details.
export function verifyContract(contract, evidenceList, options = {}) {
  const validation = validateContract(contract, evidenceList, options);

  // Enhance each result with matched evidence details
  for (const result of validation.results || []) {
    result.matchedEvidence = matchEvidenceToCriterion(result.criterion, evidenceList);
    result.matchScore = result.matchedEvidence.length > 0
      ? result.matchedEvidence.filter(e => e.passed).length / result.matchedEvidence.length
      : 0;
  }

  return validation;
}

// Verify multiple contracts in batch.
export function verifyContracts(contracts, evidenceList, options = {}) {
  return contracts.map(c => verifyContract(c, evidenceList, options));
}

// Check if all evidence types required by a contract are present.
export function checkRequiredEvidenceCoverage(contract, evidenceList) {
  const required = (contract.evidence || []);
  if (!required.length) return { covered: true, missing: [] };

  const present = new Set(evidenceList.map(e => e.type));
  const missing = required.filter(t => !present.has(t));

  return { covered: missing.length === 0, missing };
}

// Generate a verification report.
export function formatVerificationReport(verification, contract) {
  const lines = [
    '=== Evidence Verification Report ===',
    `Contract: ${contract?.title || contract?.id || 'unknown'}`,
    `Verdict: ${verification.verdict}`,
    `Summary: ${verification.summary}`,
    `Verified at: ${new Date(verification.validatedAt).toISOString()}`,
    '',
    'Criteria Details:',
  ];

  for (const result of verification.results || []) {
    const icon = result.verdict === 'pass' ? '✅' : result.verdict === 'fail' ? '❌' : '⏳';
    lines.push(`  ${icon} "${result.criterion}"`);
    lines.push(`    Verdict: ${result.verdict}`);
    lines.push(`    Match score: ${(result.matchScore || 0) * 100}%`);

    if (result.matchedEvidence?.length) {
      for (const ev of result.matchedEvidence) {
        lines.push(`    ${ev.passed ? '✓' : '✗'} ${ev.type}: ${ev.description}`);
      }
    }
    if (result.evidenceUsed?.length && !result.matchedEvidence?.length) {
      for (const ev of result.evidenceUsed) {
        lines.push(`    ${ev.passed ? '✓' : '✗'} ${ev.type}: ${ev.description}`);
      }
    }
  }

  return lines.join('\n');
}

// Run full verification pipeline: collect evidence → verify contract.
export async function fullVerify(contract, evidenceCollector, options = {}) {
  const evidence = typeof evidenceCollector === 'function' ? await evidenceCollector() : evidenceCollector;
  return verifyContract(contract, evidence, options);
}