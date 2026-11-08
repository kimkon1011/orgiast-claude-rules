import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Evidence, collectTestEvidence, collectLogEvidence, collectCommitEvidence, collectAllEvidence, EVIDENCE_TYPES } from './evidence-collector.mjs';

test('Evidence constructor creates valid record', () => {
  const ev = new Evidence({ type: 'test-pass', description: 'unit tests passed', passed: true });
  assert.equal(ev.type, 'test-pass');
  assert.equal(ev.description, 'unit tests passed');
  assert.equal(ev.passed, true);
  assert.ok(ev.timestamp > 0);
});

test('Evidence defaults to manual type', () => {
  const ev = new Evidence({});
  assert.equal(ev.type, 'manual');
  assert.equal(ev.passed, false);
});

test('collectTestEvidence with failing command', () => {
  // This will fail in most environments; we just check the structure
  const ev = collectTestEvidence('nonexistent-command-that-fails', { cwd: tmpdir(), timeout: 5000 });
  assert.equal(ev.type, 'test-fail');
  assert.equal(ev.passed, false);
  assert.ok(ev.detail);
});

test('collectLogEvidence returns found/not-found', () => {
  const tmpLog = path.join(tmpdir(), 'test.log');
  try {
    fs.writeFileSync(tmpLog, 'Hello world\nThis is a test log\nError: something happened\n', 'utf8');
    const found = collectLogEvidence(tmpLog, 'Error', { description: 'check errors' });
    assert.ok(found.passed);
    assert.equal(found.type, 'log-match');
    const notFound = collectLogEvidence(tmpLog, 'CRITICAL', { description: 'check critical' });
    assert.ok(!notFound.passed);
  } finally {
    try { fs.rmSync(tmpLog); } catch {}
  }
});

test('collectLogEvidence handles missing file', () => {
  const ev = collectLogEvidence('/nonexistent/path.log', 'test');
  assert.ok(!ev.passed);
  assert.ok(ev.detail.includes('not found'));
});

test('collectCommitEvidence with invalid sha', () => {
  const ev = collectCommitEvidence('0000000000000000000000000000000000000000', { cwd: tmpdir() });
  assert.ok(!ev.passed);
});

test('collectAllEvidence returns evidence array', () => {
  const results = collectAllEvidence({});
  assert.ok(Array.isArray(results));
});

test('EVIDENCE_TYPES are defined', () => {
  assert.ok(EVIDENCE_TYPES.TEST_PASS);
  assert.ok(EVIDENCE_TYPES.TEST_FAIL);
  assert.ok(EVIDENCE_TYPES.TYPE_CHECK);
  assert.ok(EVIDENCE_TYPES.COMMIT);
  assert.ok(EVIDENCE_TYPES.MANUAL);
});