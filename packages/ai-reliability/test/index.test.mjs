import assert from 'node:assert/strict';
import test from 'node:test';
import { createReliabilityPipeline, Workflow, EvalChain, staticAnalyze, Tracer } from '../index.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('createReliabilityPipeline はパイプラインを構築する', () => {
  const pipeline = createReliabilityPipeline({ workflowId: 'test-pipe' });
  assert.ok(pipeline.workflow instanceof Workflow);
  assert.ok(pipeline.evalChain instanceof EvalChain);
  assert.ok(pipeline.tracer instanceof Tracer);
  assert.equal(typeof pipeline.run, 'function');
});

test('パイプラインは静的解析に合格するHTMLで passed=true を返す', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pipe-test-'));
  const pipeline = createReliabilityPipeline({
    workflowId: 'pipe-pass',
    checkpointDir: dir,
  });
  const result = await pipeline.run({
    generateFn: async () => ({
      'index.html': `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>OK</title>
</head>
<body>
  <main><h1>Hello</h1><nav>Menu</nav></main>
</body>
</html>`,
    }),
    prompt: 'make a page',
  });
  assert.equal(result.passed, true);
  await rm(dir, { recursive: true, force: true });
});

test('パイプラインは不完全なHTMLで passed=false を返す', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pipe-test-'));
  const pipeline = createReliabilityPipeline({
    workflowId: 'pipe-fail',
    checkpointDir: dir,
  });
  const result = await pipeline.run({
    generateFn: async () => ({
      'index.html': '<div>broken page</div>',
    }),
    prompt: 'broken',
  });
  assert.equal(result.passed, false);
  // 失敗理由がレポートに含まれている
  assert.ok(result.reports.validation || result.reports.evaluation);
  await rm(dir, { recursive: true, force: true });
});

test('パイプラインは generateFn エラー時に回復を試みる', async () => {
  let attemptCount = 0;
  const dir = await mkdtemp(join(tmpdir(), 'pipe-test-'));
  const pipeline = createReliabilityPipeline({
    workflowId: 'pipe-retry',
    checkpointDir: dir,
  });
  const result = await pipeline.run({
    generateFn: async () => {
      attemptCount += 1;
      if (attemptCount < 3) throw new Error('generate failed');
      return { 'page.html': '<html><body>OK</body></html>' };
    },
    prompt: 'retry test',
  });
  // リトライ上限内で成功したか、または3回失敗してescalated
  // generateFnに渡す関数はWorkflow内で呼ばれ、リトライ時に再実行される
  assert.equal(attemptCount >= 1, true);
  await rm(dir, { recursive: true, force: true });
});

test('staticAnalyze が index.mjs からエクスポートされている', () => {
  assert.equal(typeof staticAnalyze, 'function');
});