import test from 'node:test';
import assert from 'node:assert/strict';
import { OutcomeContract } from './task-outcome-contract.mjs';
import { validateContract, validateContracts, isContractSatisfied, formatValidationReport, VERDICT_PASS, VERDICT_FAIL, VERDICT_PENDING } from './contract-validator.mjs';

test('validateContract passes with matching evidence', () => {
  const contract = new OutcomeContract({ id: 'test-pass', title: 'Test', deliverable: 'x', criteria: ['works'], evidence: ['test-pass'] });
  const evidence = [{ type: 'test-pass', description: 'unit tests', passed: true }];
  const result = validateContract(contract, evidence);
  assert.equal(result.verdict, VERDICT_PASS);
  assert.equal(result.contractId, 'test-pass');
});

test('validateContract returns pending with no evidence', () => {
  const contract = new OutcomeContract({ id: 'test-pending', title: 'Test', deliverable: 'x', criteria: ['works'], evidence: ['test-pass'] });
  const result = validateContract(contract, []);
  assert.equal(result.verdict, VERDICT_PENDING);
});

test('validateContract returns error for null contract', () => {
  const result = validateContract(null, []);
  assert.equal(result.verdict, 'error');
  assert.ok(result.summary);
});

test('validateContract fails when evidence fails', () => {
  const contract = new OutcomeContract({ id: 'test-fail', title: 'Test', deliverable: 'x', criteria: ['validates input'], evidence: ['test-pass'] });
  const evidence = [{ type: 'test-pass', description: 'unit tests', passed: false }];
  const result = validateContract(contract, evidence);
  assert.equal(result.verdict, VERDICT_FAIL);
});

test('validateContracts batch validates', () => {
  const contracts = [
    new OutcomeContract({ id: 'c1', title: 'C1', deliverable: 'x', criteria: ['a'], evidence: ['test-pass'] }),
    new OutcomeContract({ id: 'c2', title: 'C2', deliverable: 'x', criteria: ['b'], evidence: ['test-pass'] }),
  ];
  const evidence = [{ type: 'test-pass', description: 'tests', passed: true }];
  const results = validateContracts(contracts, evidence);
  assert.equal(results.length, 2);
  assert.ok(results.every(r => r.verdict === VERDICT_PASS));
});

test('isContractSatisfied checks verdict', () => {
  assert.ok(isContractSatisfied({ verdict: VERDICT_PASS }));
  assert.ok(!isContractSatisfied({ verdict: VERDICT_FAIL }));
  assert.ok(!isContractSatisfied({ verdict: VERDICT_PENDING }));
  assert.ok(!isContractSatisfied(null));
});

test('formatValidationReport produces readable output', () => {
  const contract = new OutcomeContract({ id: 'report-test', title: 'Report', deliverable: 'x', criteria: ['criterion one'], evidence: ['test-pass'] });
  const evidence = [{ type: 'test-pass', description: 'passing test', passed: true }];
  const result = validateContract(contract, evidence);
  const report = formatValidationReport(result);
  assert.ok(report.includes('report-test'));
  assert.ok(report.includes('pass'));
  assert.equal(formatValidationReport(null), 'No validation result');
});

test('criteria-free contract validates from evidence types', () => {
  const contract = new OutcomeContract({ id: 'ev-only', title: 'Evidence only', deliverable: 'x', evidence: ['test-pass'] });
  const evidence = [{ type: 'test-pass', description: 'found tests', passed: true }];
  const result = validateContract(contract, evidence, { requiredEvidence: ['test-pass'] });
  assert.equal(result.verdict, VERDICT_PASS);
});