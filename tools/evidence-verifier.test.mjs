import test from 'node:test';
import assert from 'node:assert/strict';
import { OutcomeContract } from './task-outcome-contract.mjs';
import { matchEvidenceToCriterion, verifyContract, verifyContracts, checkRequiredEvidenceCoverage, formatVerificationReport } from './evidence-verifier.mjs';

test('matchEvidenceToCriterion matches by keywords', () => {
  const evidence = [
    { type: 'test-pass', description: 'unit test results for login', passed: true, detail: 'login validation passed' },
    { type: 'log-match', description: 'error log scan', passed: false, detail: 'no errors found' },
  ];
  const matched = matchEvidenceToCriterion('login validation', evidence);
  assert.equal(matched.length, 1);
  assert.equal(matched[0].type, 'test-pass');
});

test('matchEvidenceToCriterion returns empty for no matches', () => {
  const evidence = [{ type: 'test-pass', description: 'unit tests', passed: true }];
  const matched = matchEvidenceToCriterion('database query optimization', evidence);
  assert.equal(matched.length, 0);
});

test('verifyContract produces detailed results', () => {
  const contract = new OutcomeContract({ id: 'verify-test', title: 'Verify', deliverable: 'x', criteria: ['login works', 'validation correct'], evidence: ['test-pass'] });
  const evidence = [
    { type: 'test-pass', description: 'login tests passed', passed: true, detail: 'all login tests green' },
    { type: 'test-pass', description: 'validation tests passed', passed: true, detail: 'input validation correct' },
  ];
  const result = verifyContract(contract, evidence);
  assert.ok(result.results.length >= 1);
  assert.ok(result.results[0].matchedEvidence !== undefined);
});

test('verifyContracts batch verifies', () => {
  const contracts = [
    new OutcomeContract({ id: 'v1', title: 'V1', deliverable: 'x', criteria: ['feature a'], evidence: ['test-pass'] }),
    new OutcomeContract({ id: 'v2', title: 'V2', deliverable: 'x', criteria: ['feature b'], evidence: ['test-pass'] }),
  ];
  const evidence = [{ type: 'test-pass', description: 'tests', passed: true }];
  const results = verifyContracts(contracts, evidence);
  assert.equal(results.length, 2);
});

test('checkRequiredEvidenceCoverage detects missing types', () => {
  const contract = new OutcomeContract({ id: 'coverage-test', title: 'Coverage', deliverable: 'x', evidence: ['test-pass', 'type-check', 'lint-pass'] });
  const evidence = [{ type: 'test-pass', description: 'tests', passed: true }];
  const result = checkRequiredEvidenceCoverage(contract, evidence);
  assert.ok(!result.covered);
  assert.ok(result.missing.includes('type-check'));
  assert.ok(result.missing.includes('lint-pass'));
});

test('formatVerificationReport produces readable output', () => {
  const contract = new OutcomeContract({ id: 'fmt-test', title: 'Format', deliverable: 'x', criteria: ['works'], evidence: ['test-pass'] });
  const evidence = [{ type: 'test-pass', description: 'tests pass', passed: true }];
  const result = verifyContract(contract, evidence);
  const report = formatVerificationReport(result, contract);
  assert.ok(report.includes('fmt-test') || report.includes('Format'));
  assert.ok(report.includes('pass') || report.includes('✅'));
});

test('all required coverage present passes', () => {
  const contract = new OutcomeContract({ id: 'full-cov', title: 'Full', deliverable: 'x', evidence: ['test-pass', 'commit'] });
  const evidence = [
    { type: 'test-pass', description: 'tests', passed: true },
    { type: 'commit', description: 'committed', passed: true },
  ];
  const result = checkRequiredEvidenceCoverage(contract, evidence);
  assert.ok(result.covered);
  assert.deepEqual(result.missing, []);
});