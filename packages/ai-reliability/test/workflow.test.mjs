import assert from 'node:assert/strict';
import test from 'node:test';
import { Workflow, WorkflowStep } from '../workflow.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('Workflow は全ステップを順次実行する', async () => {
  const trace = [];
  const wf = new Workflow({
    workflowId: 'test-simple',
    checkpointDir: await mkdtemp(join(tmpdir(), 'wf-test-')),
    steps: [
      new WorkflowStep({ name: 'step1', phase: 'generate', execute: async () => ({ status: 'passed', output: 'a' }) }),
      new WorkflowStep({ name: 'step2', phase: 'validate', execute: async () => ({ status: 'passed', output: 'b' }) }),
    ],
    onStepComplete: (ctx, step) => { trace.push(step.name); },
  });
  const result = await wf.run();
  assert.equal(result.passed, true);
  assert.deepEqual(trace, ['step1', 'step2']);
  assert.equal(result.checkpoint.context.step1, 'a');
  assert.equal(result.checkpoint.context.step2, 'b');
});

test('Workflow は失敗ステップで中断する', async () => {
  const trace = [];
  const wf = new Workflow({
    workflowId: 'test-fail',
    checkpointDir: await mkdtemp(join(tmpdir(), 'wf-test-')),
    steps: [
      new WorkflowStep({ name: 'ok', phase: 'generate', execute: async () => ({ status: 'passed', output: 'ok' }) }),
      new WorkflowStep({ name: 'fail', phase: 'validate', execute: async () => ({ status: 'failed', error: 'bad code' }) }),
      new WorkflowStep({ name: 'never', phase: 'evaluate', execute: async () => ({ status: 'passed' }) }),
    ],
    onStepComplete: (ctx, step) => { trace.push(step.name); },
  });
  const result = await wf.run();
  assert.equal(result.passed, false);
  assert.deepEqual(trace, ['ok', 'fail']);
  assert.equal(result.checkpoint.steps.never.status, 'pending');
});

test('Workflow はリトライ上限まで自動リトライする', async () => {
  let attempts = 0;
  const wf = new Workflow({
    workflowId: 'test-retry',
    checkpointDir: await mkdtemp(join(tmpdir(), 'wf-test-')),
    steps: [
      new WorkflowStep({
        name: 'flakey',
        phase: 'generate',
        execute: async () => {
          attempts += 1;
          throw new Error(`attempt ${attempts} failed`);
        },
        retry: { maxAttempts: 3, baseDelayMs: 10 },
      }),
    ],
  });
  const result = await wf.run();
  assert.equal(result.passed, false);
  assert.equal(result.checkpoint.steps.flakey.status, 'escalated');
  assert.equal(attempts, 3);
});

test('Workflow はチェックポイントを復元できる', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wf-test-'));
  let step1Ran = false;
  const wf1 = new Workflow({
    workflowId: 'test-restore',
    checkpointDir: dir,
    steps: [
      new WorkflowStep({ name: 's1', phase: 'generate', execute: async () => { step1Ran = true; return { status: 'passed', output: 'done' }; } }),
      new WorkflowStep({ name: 's2', phase: 'validate', execute: async () => ({ status: 'passed' }) }),
    ],
  });
  await wf1.run();

  // 別のインスタンスでチェックポイントを復元（s1 は再実行されない）
  let step1RanAgain = false;
  const wf2 = new Workflow({
    workflowId: 'test-restore',
    checkpointDir: dir,
    steps: [
      new WorkflowStep({ name: 's1', phase: 'generate', execute: async () => { step1RanAgain = true; return { status: 'passed', output: 'done' }; } }),
      new WorkflowStep({ name: 's2', phase: 'validate', execute: async () => ({ status: 'passed' }) }),
    ],
  });
  const result2 = await wf2.run();
  assert.equal(result2.passed, true);
  assert.equal(step1RanAgain, false); // チェックポイント復元でスキップ

  await rm(dir, { recursive: true, force: true });
});

test('Workflow は context をステップ間で共有する', async () => {
  const wf = new Workflow({
    workflowId: 'test-context',
    checkpointDir: await mkdtemp(join(tmpdir(), 'wf-test-')),
    steps: [
      new WorkflowStep({ name: 'generate', phase: 'generate', execute: async (ctx) => {
        ctx.value = 42;
        return { status: 'passed', output: 'generated' };
      }}),
      new WorkflowStep({ name: 'check', phase: 'validate', execute: async (ctx) => {
        assert.equal(ctx.value, 42);
        return { status: 'passed', output: 'checked' };
      }}),
    ],
  });
  const result = await wf.run();
  assert.equal(result.passed, true);
});

test('Workflow はリセットできる', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wf-test-'));
  const wf = new Workflow({
    workflowId: 'test-reset',
    checkpointDir: dir,
    steps: [
      new WorkflowStep({ name: 's1', phase: 'generate', execute: async () => ({ status: 'passed' }) }),
    ],
  });
  await wf.run();
  await wf.reset();
  const cp = await wf.run();
  assert.equal(cp.passed, true);
  await rm(dir, { recursive: true, force: true });
});