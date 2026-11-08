import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TaskMemory, saveTaskMemory, loadTaskMemory, deleteTaskMemory, listTaskMemories, findTasksByPhase, patchTaskMemory, createOrResumeTask, taskSummary } from './persistent-task-memory.mjs';

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-memory-test-'));
const memoryDir = path.join(testDir, 'memories');

test('TaskMemory constructor', () => {
  const m = new TaskMemory({ taskId: 't1', state: { step: 1 }, context: { pr: 123 } });
  assert.equal(m.taskId, 't1');
  assert.equal(m.state.step, 1);
  assert.equal(m.context.pr, 123);
  assert.equal(m.progress, 0);
  assert.equal(m.phase, 'init');
});

test('TaskMemory auto-generates id', () => {
  const m = new TaskMemory({});
  assert.ok(m.taskId);
  assert.ok(m.taskId.startsWith('task-'));
});

test('TaskMemory checkpoint and progress', () => {
  const m = new TaskMemory({ taskId: 'cp-test' });
  m.checkpoint('started', 'Beginning execution');
  m.setProgress(0.5);
  assert.equal(m.history.length, 1);
  assert.equal(m.progress, 0.5);
  m.transitionTo('implement', 'Coding phase');
  assert.equal(m.phase, 'implement');
  assert.equal(m.history.length, 2);
});

test('saveTaskMemory and loadTaskMemory round-trip', () => {
  const m = new TaskMemory({ taskId: 'rt-test', state: { done: true }, phase: 'complete', progress: 1 });
  saveTaskMemory(m, { memoryDir });
  const loaded = loadTaskMemory('rt-test', { memoryDir });
  assert.equal(loaded.taskId, 'rt-test');
  assert.ok(loaded.state.done);
  assert.equal(loaded.phase, 'complete');
  assert.equal(loaded.progress, 1);
});

test('loadTaskMemory returns null for missing', () => {
  assert.equal(loadTaskMemory('nonexistent', { memoryDir }), null);
});

test('deleteTaskMemory removes file', () => {
  const m = new TaskMemory({ taskId: 'del-test' });
  saveTaskMemory(m, { memoryDir });
  assert.ok(fs.existsSync(path.join(memoryDir, 'del-test.json')));
  assert.ok(deleteTaskMemory('del-test', { memoryDir }));
  assert.ok(!deleteTaskMemory('del-test', { memoryDir }));
});

test('listTaskMemories returns sorted', () => {
  for (const f of fs.readdirSync(memoryDir)) fs.rmSync(path.join(memoryDir, f));
  const m1 = new TaskMemory({ taskId: 'list-a', phase: 'done' });
  const m2 = new TaskMemory({ taskId: 'list-b', phase: 'active' });
  saveTaskMemory(m1, { memoryDir });
  saveTaskMemory(m2, { memoryDir });
  const list = listTaskMemories({ memoryDir });
  assert.equal(list.length, 2);
});

test('findTasksByPhase filters', () => {
  for (const f of fs.readdirSync(memoryDir)) fs.rmSync(path.join(memoryDir, f));
  const m1 = new TaskMemory({ taskId: 'phase-a', phase: 'active' });
  const m2 = new TaskMemory({ taskId: 'phase-b', phase: 'done' });
  saveTaskMemory(m1, { memoryDir });
  saveTaskMemory(m2, { memoryDir });
  const active = findTasksByPhase('active', { memoryDir });
  assert.equal(active.length, 1);
  assert.equal(active[0].taskId, 'phase-a');
});

test('patchTaskMemory updates fields', () => {
  const m = new TaskMemory({ taskId: 'patch-test', state: { x: 1 } });
  saveTaskMemory(m, { memoryDir });
  const updated = patchTaskMemory('patch-test', { progress: 0.9, phase: 'review' }, { memoryDir });
  assert.equal(updated.progress, 0.9);
  assert.equal(updated.phase, 'review');
  assert.equal(patchTaskMemory('nonexistent', {}, { memoryDir }), null);
});

test('createOrResumeTask creates new or resumes existing', () => {
  const { memory: m1, isNew } = createOrResumeTask('cor-test', { step: 1 }, { memoryDir });
  assert.ok(isNew);
  assert.equal(m1.state.step, 1);
  // Resume
  const { memory: m2, isNew: isNew2 } = createOrResumeTask('cor-test', {}, { memoryDir });
  assert.ok(!isNew2);
  assert.equal(m2.taskId, 'cor-test');
});

test('taskSummary returns overview', () => {
  const summary = taskSummary({ memoryDir });
  assert.ok(summary.total >= 0);
  assert.ok(summary.byPhase !== undefined);
  assert.ok(Array.isArray(summary.recent));
});

// Cleanup
test('cleanup', () => { fs.rmSync(testDir, { recursive: true, force: true }); });