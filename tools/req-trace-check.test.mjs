import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseTraceRows, checkTrace } from './req-trace-check.mjs';

describe('req-trace-check', () => {

  it('valid case (a): minimal connected set passes checkTrace', () => {
    const md = `
| ID | 親ID | 成果物パス | 担当 |
|---|---|---|---|
| REQ-BOOTH-001 | - | tools/req-trace-check.mjs | kim |
| SPEC-BOOTH-001 | REQ-BOOTH-001 | tools/req-trace-check.mjs | Claude |
| TASK-BOOTH-001 | SPEC-BOOTH-001 | tools/req-trace-check.mjs | Codex |
| TEST-BOOTH-001 | TASK-BOOTH-001 | tools/req-trace-check.test.mjs | 検証 |
`;
    const rows = parseTraceRows(md);
    assert.equal(rows.length, 4);
    const violations = checkTrace(rows);
    assert.deepEqual(violations, []);
  });

  it('valid case (b): real file docs/ai-news-x0039-doc-centric-hierarchical-dev.md CLI exit 0 with --check-paths', () => {
    const stdout = execFileSync(
      'node',
      ['tools/req-trace-check.mjs', '--check-paths', 'docs/ai-news-x0039-doc-centric-hierarchical-dev.md'],
      { encoding: 'utf8' }
    );
    assert.match(stdout, /OK: 8 rows, 2 REQ/);
  });

  it('error case: orphan TASK returns ORPHAN', () => {
    const md = `
| ID | 親ID | 成果物パス | 担当 |
|---|---|---|---|
| REQ-BOOTH-001 | - | tools/req-trace-check.mjs | kim |
| TASK-BOOTH-001 | - | tools/req-trace-check.mjs | Codex |
| TEST-BOOTH-001 | TASK-BOOTH-001 | tools/req-trace-check.test.mjs | 検証 |
`;
    const rows = parseTraceRows(md);
    const violations = checkTrace(rows);
    assert.ok(violations.some(v => v.code === 'ORPHAN' && v.id === 'TASK-BOOTH-001'));
  });

  it('error case: orphan TEST returns ORPHAN', () => {
    const md = `
| ID | 親ID | 成果物パス | 担当 |
|---|---|---|---|
| REQ-BOOTH-001 | - | tools/req-trace-check.mjs | kim |
| TASK-BOOTH-001 | REQ-BOOTH-001 | tools/req-trace-check.mjs | Codex |
| TEST-BOOTH-001 | - | tools/req-trace-check.test.mjs | 検証 |
`;
    const rows = parseTraceRows(md);
    const violations = checkTrace(rows);
    assert.ok(violations.some(v => v.code === 'ORPHAN' && v.id === 'TEST-BOOTH-001'));
  });

  it('error case: uncovered REQ (TASK only, no TEST) returns UNCOVERED_REQ', () => {
    const md = `
| ID | 親ID | 成果物パス | 担当 |
|---|---|---|---|
| REQ-BOOTH-001 | - | tools/req-trace-check.mjs | kim |
| TASK-BOOTH-001 | REQ-BOOTH-001 | tools/req-trace-check.mjs | Codex |
`;
    const rows = parseTraceRows(md);
    const violations = checkTrace(rows);
    assert.ok(violations.some(v => v.code === 'UNCOVERED_REQ' && v.id === 'REQ-BOOTH-001'));
  });

  it('error case: uncovered REQ (TEST only, no TASK) returns UNCOVERED_REQ', () => {
    const md = `
| ID | 親ID | 成果物パス | 担当 |
|---|---|---|---|
| REQ-BOOTH-001 | - | tools/req-trace-check.mjs | kim |
| TEST-BOOTH-001 | REQ-BOOTH-001 | tools/req-trace-check.test.mjs | 検証 |
`;
    const rows = parseTraceRows(md);
    const violations = checkTrace(rows);
    assert.ok(violations.some(v => v.code === 'UNCOVERED_REQ' && v.id === 'REQ-BOOTH-001'));
  });

  it('error case: duplicate ID returns DUPLICATE_ID', () => {
    const md = `
| ID | 親ID | 成果物パス | 担当 |
|---|---|---|---|
| REQ-BOOTH-001 | - | tools/req-trace-check.mjs | kim |
| REQ-BOOTH-001 | - | tools/req-trace-check.mjs | kim |
| TASK-BOOTH-001 | REQ-BOOTH-001 | tools/req-trace-check.mjs | Codex |
| TEST-BOOTH-001 | TASK-BOOTH-001 | tools/req-trace-check.test.mjs | 検証 |
`;
    const rows = parseTraceRows(md);
    const violations = checkTrace(rows);
    assert.ok(violations.some(v => v.code === 'DUPLICATE_ID' && v.id === 'REQ-BOOTH-001'));
  });

  it('error case: missing parent returns MISSING_PARENT', () => {
    const md = `
| ID | 親ID | 成果物パス | 担当 |
|---|---|---|---|
| REQ-BOOTH-001 | - | tools/req-trace-check.mjs | kim |
| SPEC-BOOTH-001 | REQ-BOOTH-999 | tools/req-trace-check.mjs | Claude |
| TASK-BOOTH-001 | SPEC-BOOTH-001 | tools/req-trace-check.mjs | Codex |
| TEST-BOOTH-001 | TASK-BOOTH-001 | tools/req-trace-check.test.mjs | 検証 |
`;
    const rows = parseTraceRows(md);
    const violations = checkTrace(rows);
    assert.ok(violations.some(v => v.code === 'MISSING_PARENT' && v.id === 'SPEC-BOOTH-001'));
  });

  it('error case: hierarchy violation SPEC->TASK returns BAD_PARENT_LAYER', () => {
    const md = `
| ID | 親ID | 成果物パス | 担当 |
|---|---|---|---|
| REQ-BOOTH-001 | - | tools/req-trace-check.mjs | kim |
| TASK-BOOTH-001 | REQ-BOOTH-001 | tools/req-trace-check.mjs | Codex |
| SPEC-BOOTH-001 | TASK-BOOTH-001 | tools/req-trace-check.mjs | Claude |
| TEST-BOOTH-001 | TASK-BOOTH-001 | tools/req-trace-check.test.mjs | 検証 |
`;
    const rows = parseTraceRows(md);
    const violations = checkTrace(rows);
    assert.ok(violations.some(v => v.code === 'BAD_PARENT_LAYER' && v.id === 'SPEC-BOOTH-001'));
  });

  it('error case: 0 rows returns NO_ROWS', () => {
    const violations = checkTrace([]);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].code, 'NO_ROWS');
  });

  it('CLI test: invalid markdown file exits 1', () => {
    const tmpFile = path.resolve('tools', '_tmp_invalid_trace.md');
    const badMd = `
| ID | 親ID | 成果物パス | 担当 |
|---|---|---|---|
| REQ-BOOTH-001 | - | tools/req-trace-check.mjs | kim |
| TASK-BOOTH-001 | - | tools/req-trace-check.mjs | Codex |
`;
    fs.writeFileSync(tmpFile, badMd, 'utf8');

    try {
      assert.throws(() => {
        execFileSync('node', ['tools/req-trace-check.mjs', tmpFile], { encoding: 'utf8' });
      }, (err) => {
        return err.status === 1 && err.stderr.includes('ORPHAN');
      });
    } finally {
      if (fs.existsSync(tmpFile)) {
        fs.unlinkSync(tmpFile);
      }
    }
  });

  it('CLI test: missing file arguments exits 2', () => {
    assert.throws(() => {
      execFileSync('node', ['tools/req-trace-check.mjs'], { encoding: 'utf8' });
    }, (err) => {
      return err.status === 2;
    });
  });

});
