import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { auditSite } from './ai-index-audit.mjs';

describe('ai-index-audit', () => {
  it('returns expected shape for valid URL', async () => {
    const report = await auditSite('https://httpbin.org/html');
    assert.ok(report.url);
    assert.ok(report.timestamp);
    assert.ok(report.summary);
    assert.ok(Array.isArray(report.checks));
    assert.ok(report.checks.length > 0);
  });

  it('reports checks with proper fields', async () => {
    const report = await auditSite('https://httpbin.org/html');
    for (const c of report.checks) {
      assert.ok(typeof c.label === 'string');
      assert.ok(typeof c.ok === 'boolean');
      assert.ok(typeof c.weight === 'number');
      assert.ok(typeof c.score === 'number');
      assert.ok(typeof c.detail === 'string');
    }
  });

  it('summary contains grade A-F', async () => {
    const report = await auditSite('https://httpbin.org/html');
    assert.ok(['A', 'B', 'C', 'D', 'F'].includes(report.summary.grade));
  });

  it('handles unreachable URL gracefully', async () => {
    const report = await auditSite('https://nonexistent-domain-xyz999.example');
    // Should still return a report structure, just with failing checks
    assert.ok(report.checks.length > 0);
  });

  it('handles crawl parameter', async () => {
    const report = await auditSite('https://httpbin.org', { crawlDepth: 2 });
    assert.ok(report.checks.length > 0);
  });
});