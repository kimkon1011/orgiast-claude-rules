import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const source = readFileSync(resolve('tools/nightly-batch.ps1'), 'utf8');

test('nightly step failures are not logged or summarized without output detail', () => {
  assert.doesNotMatch(source, /Write-NightlyLog\s+'\S+'\s*\(?\s*["']error:終了コード/);

  const summaryFailures = source.match(/^.*\$summary\[[^\n]+error:終了コード.*$/gm) ?? [];
  for (const line of summaryFailures) {
    assert.match(line, /Format-NightlyDetail/, line.trim());
  }
});

test('Write-NightlyStepResult formats captured output before logging failures', () => {
  const helper = source.match(/function Write-NightlyStepResult\b[\s\S]*?\n}/)?.[0];
  assert.ok(helper, 'Write-NightlyStepResult function');
  assert.match(helper, /Format-NightlyDetail\s+\$Output/);
  assert.match(helper, /Write-NightlyLog\s+\$Step/);
});

test('captured nightly node steps save LASTEXITCODE on the following line', () => {
  const lines = source.split(/\r?\n/);
  const capturedCalls = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => /=\s*@\(&\s+\$node\.Source/.test(line) && /2>&1\)/.test(line))
    .filter(({ line }) => !/\$(?:derive|split|verify|keyserve)Output\s*=/.test(line));

  assert.ok(capturedCalls.length > 0, 'captured node steps');
  for (const { line, index } of capturedCalls) {
    assert.match(lines[index + 1] ?? '', /=\s*\$LASTEXITCODE\b/, line.trim());
  }
});
