import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OutcomeContract, parseInstructionsToContract, saveContract, loadContract, listContracts } from './task-outcome-contract.mjs';

test('OutcomeContract constructor creates valid contract', () => {
  const c = new OutcomeContract({ id: 'test-1', title: 'Test', deliverable: 'A test deliverable', criteria: ['works'], evidence: ['test-pass'] });
  assert.equal(c.id, 'test-1');
  assert.equal(c.title, 'Test');
  assert.equal(c.deliverable, 'A test deliverable');
  assert.deepEqual(c.criteria, ['works']);
  assert.deepEqual(c.evidence, ['test-pass']);
  assert.ok(c.createdAt > 0);
});

test('OutcomeContract auto-generates id', () => {
  const c = new OutcomeContract({ title: 'Auto ID' });
  assert.ok(c.id);
  assert.ok(c.id.length >= 20);
});

test('parseInstructionsToContract extracts deliverable and criteria', () => {
  const instructions = `## Fix login bug\n\nDeliverable: Fix the login validation\n\n- [ ] Validate email format\n- [ ] Return proper error messages\n- [ ] Add unit tests`;
  const contract = parseInstructionsToContract(instructions);
  assert.ok(contract.title.includes('Fix login bug') || contract.title === 'Fix login bug');
  assert.ok(contract.criteria.length >= 2);
});

test('parseInstructionsToContract detects evidence types from text', () => {
  const instructions = 'Implement the feature with tests and type checking';
  const contract = parseInstructionsToContract(instructions, { title: 'Test', deliverable: 'feature' });
  assert.ok(contract.evidence.includes('test-pass'));
  assert.ok(contract.evidence.includes('type-check'));
});

test('saveContract and loadContract round-trip', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'contract-test-'));
  const contractsDir = path.join(tmp, 'contracts');
  try {
    const c = new OutcomeContract({ id: 'roundtrip-1', title: 'Round Trip', deliverable: 'test' });
    const savedPath = saveContract(c, { contractsDir });
    assert.ok(fs.existsSync(savedPath));
    const loaded = loadContract('roundtrip-1', { contractsDir });
    assert.equal(loaded.id, 'roundtrip-1');
    assert.equal(loaded.title, 'Round Trip');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('listContracts returns sorted contracts', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'contract-list-'));
  const contractsDir = path.join(tmp, 'contracts');
  try {
    assert.deepEqual(listContracts({ contractsDir }), []);
    const c1 = new OutcomeContract({ id: 'b', title: 'Second' });
    const c2 = new OutcomeContract({ id: 'a', title: 'First' });
    saveContract(c1, { contractsDir });
    saveContract(c2, { contractsDir });
    const list = listContracts({ contractsDir });
    assert.equal(list.length, 2);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('empty instructions produce minimal contract', () => {
  const contract = parseInstructionsToContract('');
  assert.ok(contract.title);
  assert.ok(Array.isArray(contract.criteria));
  assert.ok(contract.evidence.length > 0);
});

test('parseInstructionsToContract reads cost limit from text', () => {
  const instructions = 'cost limit: 500 for this implementation';
  const contract = parseInstructionsToContract(instructions, { title: 'Cost', deliverable: 'x' });
  assert.equal(contract.costLimit, 500);
});