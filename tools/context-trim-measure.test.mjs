import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseSessionJsonl, selectLogs, parseArgs } from './context-trim-measure.mjs';
import { trimEveryTurn, missingInfoRate } from './context-trim.mjs';

// ---------------------------------------------------------------------------
// parseSessionJsonl
// ---------------------------------------------------------------------------

test('parseSessionJsonl handles string content (user)', () => {
  const jsonl = JSON.stringify({
    type: 'user',
    message: { role: 'user', content: 'hello world' },
  });
  const result = parseSessionJsonl(jsonl);
  assert.equal(result.length, 1);
  assert.equal(result[0].kind, 'text');
  assert.equal(result[0].text, 'hello world');
});

test('parseSessionJsonl handles array content with text blocks (user)', () => {
  const jsonl = JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [
        { type: 'text', text: 'first' },
        { type: 'text', text: 'second' },
      ],
    },
  });
  const result = parseSessionJsonl(jsonl);
  assert.equal(result.length, 2);
  assert.equal(result[0].kind, 'text');
  assert.equal(result[0].text, 'first');
  assert.equal(result[1].kind, 'text');
  assert.equal(result[1].text, 'second');
});

test('parseSessionJsonl handles tool_result with is_error (user)', () => {
  const jsonl = JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_abc',
          content: 'command output',
          is_error: true,
        },
      ],
    },
  });
  const result = parseSessionJsonl(jsonl);
  assert.equal(result.length, 1);
  assert.equal(result[0].kind, 'tool_result');
  assert.equal(result[0].text, 'command output');
  assert.equal(result[0].hasError, true);
});

test('parseSessionJsonl handles tool_result without is_error (user)', () => {
  const jsonl = JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_def',
          content: 'ok output',
        },
      ],
    },
  });
  const result = parseSessionJsonl(jsonl);
  assert.equal(result.length, 1);
  assert.equal(result[0].kind, 'tool_result');
  assert.equal(result[0].text, 'ok output');
  assert.equal(result[0].hasError, false);
});

test('parseSessionJsonl handles tool_result with array content (user)', () => {
  const jsonl = JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_ghi',
          content: [
            { type: 'text', text: 'line 1' },
            { type: 'text', text: 'line 2' },
          ],
        },
      ],
    },
  });
  const result = parseSessionJsonl(jsonl);
  assert.equal(result.length, 1);
  assert.equal(result[0].kind, 'tool_result');
  assert.equal(result[0].text, 'line 1\nline 2');
});

test('parseSessionJsonl handles assistant messages with text and tool_use', () => {
  const jsonl = JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text: 'here you go' },
        { type: 'tool_use', name: 'bash', input: { command: 'ls' } },
      ],
    },
  });
  const result = parseSessionJsonl(jsonl);
  assert.equal(result.length, 2);
  assert.equal(result[0].kind, 'text');
  assert.equal(result[0].text, 'here you go');
  assert.equal(result[1].kind, 'tool_use');
  assert.equal(result[1].text, JSON.stringify({ command: 'ls' }));
});

test('parseSessionJsonl skips thinking blocks in assistant messages', () => {
  const jsonl = JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'internal...', signature: 'sig123' },
        { type: 'text', text: 'visible output' },
      ],
    },
  });
  const result = parseSessionJsonl(jsonl);
  assert.equal(result.length, 1);
  assert.equal(result[0].kind, 'text');
  assert.equal(result[0].text, 'visible output');
});

test('parseSessionJsonl skips metadata lines (custom-title, agent-name, etc.)', () => {
  const jsonl = [
    JSON.stringify({ type: 'custom-title', customTitle: 'test' }),
    JSON.stringify({ type: 'agent-name', agentName: 'test' }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }),
    JSON.stringify({ type: 'attachment', attachment: { type: 'environment' } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] } }),
    JSON.stringify({ type: 'queue-operation', operation: 'enqueue' }),
  ].join('\n');
  const result = parseSessionJsonl(jsonl);
  assert.equal(result.length, 2);
  assert.equal(result[0].text, 'hi');
  assert.equal(result[1].text, 'hello');
});

test('parseSessionJsonl skips invalid JSON lines', () => {
  const jsonl = [
    'not valid json',
    '{"type":"user","message":{"role":"user","content":"valid"}}',
    '{truncated json',
  ].join('\n');
  const result = parseSessionJsonl(jsonl);
  assert.equal(result.length, 1);
  assert.equal(result[0].text, 'valid');
});

test('parseSessionJsonl handles empty input', () => {
  assert.deepEqual(parseSessionJsonl(''), []);
  assert.deepEqual(parseSessionJsonl('\n\n\n'), []);
});

test('parseSessionJsonl handles tool_result with null content', () => {
  const jsonl = JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_null', content: null },
      ],
    },
  });
  const result = parseSessionJsonl(jsonl);
  assert.equal(result.length, 1);
  assert.equal(result[0].kind, 'tool_result');
  assert.equal(result[0].text, '');
});

test('parseSessionJsonl preserves tool_use input as stringified JSON', () => {
  const jsonl = JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        { type: 'tool_use', name: 'Read', input: { file_path: '/test.txt' } },
      ],
    },
  });
  const result = parseSessionJsonl(jsonl);
  assert.equal(result.length, 1);
  assert.equal(result[0].kind, 'tool_use');
  assert.equal(JSON.parse(result[0].text).file_path, '/test.txt');
});

// ---------------------------------------------------------------------------
// selectLogs
// ---------------------------------------------------------------------------

function createTempDir() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctm-test-'));
  return tmpDir;
}

function createJsonlFile(dir, name, content, mtime) {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, content, 'utf8');
  if (mtime) {
    fs.utimesSync(filePath, mtime, mtime);
  }
  return filePath;
}

test('selectLogs returns files from different dates, sorted by size', () => {
  const tmpDir = createTempDir();
  try {
    // Create 5 files: 3 on date1, 2 on date2, with varied sizes
    const date1 = new Date('2026-10-01T12:00:00Z');
    const date2 = new Date('2026-10-02T12:00:00Z');

    createJsonlFile(tmpDir, 'small-d1.jsonl', 'x'.repeat(250000), date1);
    createJsonlFile(tmpDir, 'medium-d1.jsonl', 'x'.repeat(500000), date1);
    createJsonlFile(tmpDir, 'large-d1.jsonl', 'x'.repeat(800000), date1);
    createJsonlFile(tmpDir, 'small-d2.jsonl', 'x'.repeat(300000), date2);
    createJsonlFile(tmpDir, 'large-d2.jsonl', 'x'.repeat(700000), date2);

    const { files, criteria } = selectLogs(tmpDir, { min: 2, minBytes: 200000 });

    assert.equal(files.length, 2, `expected 2 files, got ${files.length}: ${criteria}`);
    // Should pick largest from each date: large-d1 (800k) and large-d2 (700k)
    const basenames = files.map(f => path.basename(f));
    assert.ok(basenames.includes('large-d1.jsonl'), `missing large-d1 in ${basenames}`);
    assert.ok(basenames.includes('large-d2.jsonl'), `missing large-d2 in ${basenames}`);
    assert.ok(criteria.length > 0, 'criteria should be non-empty');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('selectLogs returns more files when min > unique dates', () => {
  const tmpDir = createTempDir();
  try {
    const date1 = new Date('2026-10-01T12:00:00Z');
    // 3 files all on same date
    createJsonlFile(tmpDir, 'a.jsonl', 'x'.repeat(300000), date1);
    createJsonlFile(tmpDir, 'b.jsonl', 'x'.repeat(400000), date1);
    createJsonlFile(tmpDir, 'c.jsonl', 'x'.repeat(500000), date1);

    const { files } = selectLogs(tmpDir, { min: 3, minBytes: 200000 });
    assert.equal(files.length, 3);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('selectLogs excludes files smaller than minBytes', () => {
  const tmpDir = createTempDir();
  try {
    const date = new Date('2026-10-01T12:00:00Z');
    createJsonlFile(tmpDir, 'small.jsonl', 'x'.repeat(500), date);  // too small
    createJsonlFile(tmpDir, 'big.jsonl', 'x'.repeat(300000), date); // ok

    const { files } = selectLogs(tmpDir, { min: 1, minBytes: 100000 });
    assert.equal(files.length, 1);
    assert.ok(path.basename(files[0]).includes('big'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('selectLogs returns empty when no files match', () => {
  const tmpDir = createTempDir();
  try {
    const { files } = selectLogs(tmpDir, { min: 3, minBytes: 100000 });
    assert.deepEqual(files, []);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('selectLogs handles nested directories', () => {
  const tmpDir = createTempDir();
  try {
    const nested = path.join(tmpDir, 'sub', 'nested');
    fs.mkdirSync(nested, { recursive: true });
    const date = new Date('2026-10-01T12:00:00Z');
    createJsonlFile(nested, 'deep.jsonl', 'x'.repeat(300000), date);
    createJsonlFile(tmpDir, 'shallow.jsonl', 'x'.repeat(250000), date);

    const { files } = selectLogs(tmpDir, { min: 2, minBytes: 200000 });
    assert.equal(files.length, 2);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('selectLogs handles non-existent root', () => {
  const { files, criteria } = selectLogs('/nonexistent/path/xyz');
  assert.deepEqual(files, []);
  assert.ok(criteria.includes('not found'));
});

// ---------------------------------------------------------------------------
// parseArgs (argument parsing)
// ---------------------------------------------------------------------------

test('parseArgs returns defaults when no flags given', () => {
  const opts = parseArgs([]);
  assert.equal(opts.keepRecent, 6);
  assert.equal(opts.maxChars, 400);
  assert.equal(opts.protectErrors, true);
  assert.equal(opts.recent, 6);
});

test('parseArgs accepts --keep-recent', () => {
  const opts = parseArgs(['--keep-recent', '10']);
  assert.equal(opts.keepRecent, 10);
});

test('parseArgs accepts --max-chars', () => {
  const opts = parseArgs(['--max-chars', '200']);
  assert.equal(opts.maxChars, 200);
});

test('parseArgs accepts --no-protect-errors', () => {
  const opts = parseArgs(['--no-protect-errors']);
  assert.equal(opts.protectErrors, false);
});

test('parseArgs accepts --recent', () => {
  const opts = parseArgs(['--recent', '3']);
  assert.equal(opts.recent, 3);
});

test('parseArgs combines multiple flags', () => {
  const opts = parseArgs([
    '--keep-recent', '12',
    '--max-chars', '500',
    '--no-protect-errors',
    '--recent', '4',
    '--root', '/tmp/logs',
  ]);
  assert.equal(opts.keepRecent, 12);
  assert.equal(opts.maxChars, 500);
  assert.equal(opts.protectErrors, false);
  assert.equal(opts.recent, 4);
  assert.equal(opts.root, '/tmp/logs');
});

test('parseArgs accepts --progressive-max-chars', () => {
  const opts = parseArgs(['--progressive-max-chars', '1000']);
  assert.equal(opts.progressiveMaxChars, 1000);
});

test('parseArgs accepts --progressive-threshold as float', () => {
  const opts = parseArgs(['--progressive-threshold', '0.15']);
  assert.equal(opts.progressiveThreshold, 0.15);
});

test('parseArgs accepts --min-chars', () => {
  const opts = parseArgs(['--min-chars', '50']);
  assert.equal(opts.minChars, 50);
});

test('parseArgs all progressive flags together', () => {
  const opts = parseArgs([
    '--progressive-max-chars', '600',
    '--progressive-threshold', '0.3',
    '--min-chars', '100',
    '--keep-recent', '10',
  ]);
  assert.equal(opts.progressiveMaxChars, 600);
  assert.equal(opts.progressiveThreshold, 0.3);
  assert.equal(opts.minChars, 100);
  assert.equal(opts.keepRecent, 10);
});

// ---------------------------------------------------------------------------
// protectErrors / missingInfoRate integration
// ---------------------------------------------------------------------------

test('protectErrors=false allows hasError tool results to be trimmed, increasing missingInfoRate', () => {
  // Build messages: 10 tool_results, all with hasError=true, none in recent window
  const messages = [];
  for (let i = 0; i < 10; i++) {
    messages.push({ kind: 'tool_result', text: `long output line ${i} `.repeat(100), hasError: true });
  }

  // With protectErrors=true (default), error tool results are never trimmed
  const protectedResult = trimEveryTurn(messages, { keepRecent: 0, maxChars: 50, protectErrors: true });
  const protectedMissing = missingInfoRate(messages, protectedResult);
  assert.equal(protectedMissing, 0, 'protectErrors=true should keep all error tool results intact');

  // With protectErrors=false, error tool results can be trimmed
  const unprotectedResult = trimEveryTurn(messages, { keepRecent: 0, maxChars: 50, protectErrors: false });
  const unprotectedMissing = missingInfoRate(messages, unprotectedResult);
  assert.ok(unprotectedMissing > 0, `protectErrors=false should produce missingInfoRate > 0, got ${unprotectedMissing}`);
});
