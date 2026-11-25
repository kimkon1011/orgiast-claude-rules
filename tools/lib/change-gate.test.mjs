import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { commit, fingerprint, gate, loadCursor, recordRun, saveCursor } from './change-gate.mjs';

test('cursorをatomic保存し安定fingerprintで無変化を止める', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'change-gate-'));
  process.env.CHANGE_GATE_DIR = dir;
  assert.equal(fingerprint({ b: 2, a: 1 }), fingerprint({ a: 1, b: 2 }));
  assert.deepEqual(gate('job', { items: [] }), { changed: false, reason: 'empty' });
  saveCursor('job', { fingerprint: 'abc', cursor: 1 });
  assert.equal(loadCursor('job').cursor, 1);
  assert.deepEqual(gate('job', { fingerprint: 'abc', items: [1] }), { changed: false, reason: 'same-fingerprint' });
  commit('job', { fingerprint: 'def', cursor: 'id-2' });
  assert.equal(loadCursor('job').cursor, 'id-2');
  recordRun('job', { changed: true, llmInvoked: true, items: 1 });
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'runs.jsonl'), 'utf8')).job, 'job');
  delete process.env.CHANGE_GATE_DIR;
});
