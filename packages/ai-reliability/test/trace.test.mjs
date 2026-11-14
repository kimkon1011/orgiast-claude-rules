import assert from 'node:assert/strict';
import test from 'node:test';
import { Tracer, ConsoleAdapter, FileTraceAdapter } from '../trace.mjs';
import { readFile, rm, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('Tracer はスパンを記録する', async () => {
  const tracer = new Tracer({ traceId: 'test-trace' });
  const { result, span } = await tracer.span('test-op', async () => 'hello');
  assert.equal(result, 'hello');
  assert.equal(span.name, 'test-op');
  assert.equal(span.status, 'ok');
  assert.equal(span.traceId, 'test-trace');
  assert.ok(span.duration >= 0);
  assert.ok(span.spanId);
});

test('Tracer はエラースパンを記録する', async () => {
  const tracer = new Tracer({ traceId: 'test-error' });
  await assert.rejects(
    () => tracer.span('fail-op', async () => { throw new Error('boom'); }),
    /boom/
  );
  assert.equal(tracer.spans.length, 1);
  assert.equal(tracer.spans[0].status, 'error');
  assert.equal(tracer.spans[0].error, 'boom');
});

test('Tracer はリトライスパンを記録する', async () => {
  const tracer = new Tracer({ traceId: 'test-retry' });
  await tracer.recordRetry('generate', { retryCount: 1, error: new Error('timeout') });
  assert.equal(tracer.spans.length, 1);
  assert.equal(tracer.spans[0].status, 'retry');
  assert.ok(tracer.spans[0].name.includes('retry'));
});

test('Tracer は parentSpanId を伝搬する', async () => {
  const tracer = new Tracer();
  const { span: parent } = await tracer.span('parent', async () => 'p');
  const { span: child } = await tracer.span('child', async () => 'c', { parentSpanId: parent.spanId });
  assert.equal(child.parentSpanId, parent.spanId);
});

test('Tracer は input/output を記録する', async () => {
  const tracer = new Tracer();
  const { span } = await tracer.span('op', async () => 'result', {
    input: { files: ['a.html'] },
    attributes: { model: 'test' },
  });
  assert.deepEqual(span.input, { files: ['a.html'] });
  assert.equal(span.output, 'result');
  assert.equal(span.attributes.model, 'test');
});

test('FileTraceAdapter はスパンをファイルに書き込む', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'trace-test-'));
  const filePath = join(dir, 'traces.json');
  const adapter = new FileTraceAdapter(filePath);
  const tracer = new Tracer({ traceId: 'file-test', adapter });

  await tracer.span('op1', async () => 'a');
  await tracer.span('op2', async () => 'b');
  await tracer.flush();

  const data = await readFile(filePath, 'utf-8');
  const spans = JSON.parse(data);
  assert.equal(spans.length, 2);
  assert.equal(spans[0].traceId, 'file-test');

  await rm(dir, { recursive: true, force: true });
});