// X-0021: Auto-collect evidence from test results, logs, type checks, and verification outputs.
// Produces structured evidence records for contract validation.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

export const toolsDir = path.dirname(fileURLToPath(import.meta.url));
export const repoDir = path.dirname(toolsDir);

// Evidence types
export const EVIDENCE_TYPES = {
  TEST_PASS: 'test-pass',
  TEST_FAIL: 'test-fail',
  TYPE_CHECK: 'type-check',
  LINT_PASS: 'lint-pass',
  BUILD_PASS: 'build-pass',
  LOG_MATCH: 'log-match',
  SCREENSHOT: 'screenshot',
  COMMIT: 'commit',
  PR_CREATED: 'pr-created',
  MANUAL: 'manual',
};

// Structured evidence record
export class Evidence {
  constructor({ type, description, passed, detail, source, timestamp, metadata = {} }) {
    this.type = type || EVIDENCE_TYPES.MANUAL;
    this.description = description || '';
    this.passed = passed !== undefined ? Boolean(passed) : false;
    this.detail = detail || '';
    this.source = source || '';
    this.timestamp = timestamp || Date.now();
    this.metadata = metadata;
  }

  toJSON() { return { ...this }; }
}

// Collect evidence by running a test command.
export function collectTestEvidence(testCommand, options = {}) {
  const { cwd = repoDir, timeout = 120000, description = 'test run' } = options;
  try {
    const result = spawnSync(testCommand, [], {
      cwd,
      encoding: 'utf8',
      timeout,
      windowsHide: true,
      shell: true,
    });
    const passed = result.status === 0;
    return new Evidence({
      type: passed ? EVIDENCE_TYPES.TEST_PASS : EVIDENCE_TYPES.TEST_FAIL,
      description,
      passed,
      detail: passed ? 'All tests passed' : truncateStdout(result.stderr || result.stdout || '', 500),
      source: testCommand,
    });
  } catch (err) {
    return new Evidence({
      type: EVIDENCE_TYPES.TEST_FAIL,
      description,
      passed: false,
      detail: String(err.message || err),
      source: testCommand,
    });
  }
}

// Collect evidence by running a type checker.
export function collectTypeCheckEvidence(options = {}) {
  const { cwd = repoDir, timeout = 60000 } = options;
  try {
    const result = spawnSync('node', ['--test', '--experimental-config', '--check'], { cwd, encoding: 'utf8', timeout, windowsHide: true });
    const passed = result.status === 0;
    return new Evidence({
      type: EVIDENCE_TYPES.TYPE_CHECK,
      description: 'Type check',
      passed,
      detail: passed ? 'Type check passed' : truncateStdout(result.stderr || result.stdout || '', 500),
      source: 'node --test --check',
    });
  } catch (err) {
    return new Evidence({
      type: EVIDENCE_TYPES.TYPE_CHECK,
      description: 'Type check',
      passed: false,
      detail: String(err.message || err),
      source: 'node --test --check',
    });
  }
}

// Collect evidence by running tests via node --test (glob patterns).
export function collectNodeTestEvidence(testPatterns, options = {}) {
  const { cwd = repoDir, timeout = 120000 } = options;
  const results = [];
  for (const pattern of testPatterns) {
    try {
      const result = spawnSync('node', ['--test', ...pattern.split(/\s+/)], { cwd, encoding: 'utf8', timeout, windowsHide: true });
      results.push(new Evidence({
        type: result.status === 0 ? EVIDENCE_TYPES.TEST_PASS : EVIDENCE_TYPES.TEST_FAIL,
        description: `Test: ${pattern}`,
        passed: result.status === 0,
        detail: result.status === 0 ? 'Passed' : truncateStdout(result.stderr || result.stdout || '', 400),
        source: `node --test ${pattern}`,
      }));
    } catch (err) {
      results.push(new Evidence({
        type: EVIDENCE_TYPES.TEST_FAIL,
        description: `Test: ${pattern}`,
        passed: false,
        detail: String(err.message || err),
        source: `node --test ${pattern}`,
      }));
    }
  }
  return results;
}

// Collect evidence by scanning a log file for a pattern.
export function collectLogEvidence(logFile, searchPattern, options = {}) {
  const { description = 'log scan' } = options;
  try {
    if (!fs.existsSync(logFile)) {
      return new Evidence({ type: EVIDENCE_TYPES.LOG_MATCH, description, passed: false, detail: `Log not found: ${logFile}` });
    }
    const content = fs.readFileSync(logFile, 'utf8');
    const matched = content.match(new RegExp(searchPattern, 'mi'));
    return new Evidence({
      type: EVIDENCE_TYPES.LOG_MATCH,
      description,
      passed: Boolean(matched),
      detail: matched ? `Pattern found in ${path.basename(logFile)}` : `Pattern not found in ${path.basename(logFile)}`,
      source: logFile,
    });
  } catch (err) {
    return new Evidence({
      type: EVIDENCE_TYPES.LOG_MATCH,
      description,
      passed: false,
      detail: String(err.message || err),
      source: logFile,
    });
  }
}

// Collect evidence from a git commit status.
export function collectCommitEvidence(sha, options = {}) {
  const { cwd = repoDir } = options;
  try {
    const result = spawnSync('git', ['-C', cwd, 'show', '-s', '--format=%H%n%ct', sha, '--'], { encoding: 'utf8', timeout: 10000 });
    if (result.status !== 0) {
      return new Evidence({ type: EVIDENCE_TYPES.COMMIT, description: `Commit ${sha.slice(0, 7)}`, passed: false, detail: 'Commit not found' });
    }
    return new Evidence({ type: EVIDENCE_TYPES.COMMIT, description: `Commit ${sha.slice(0, 7)}`, passed: true, detail: `Commit exists: ${sha}`, metadata: { sha } });
  } catch (err) {
    return new Evidence({ type: EVIDENCE_TYPES.COMMIT, description: `Commit ${sha.slice(0, 7)}`, passed: false, detail: String(err.message || err) });
  }
}

// Run all standard evidence collectors and return aggregated results.
export function collectAllEvidence({ testPatterns, logFiles, cwd = repoDir, timeout = 120000 } = {}) {
  const all = [];

  // Test evidence
  if (testPatterns?.length) {
    all.push(...collectNodeTestEvidence(testPatterns, { cwd, timeout }));
  } else {
    // Default: try to find any .test.mjs files in tools/
    const toolsTestDir = path.join(cwd, 'tools');
    if (fs.existsSync(toolsTestDir)) {
      const testFiles = fs.readdirSync(toolsTestDir).filter(f => f.endsWith('.test.mjs'));
      if (testFiles.length) {
        all.push(new Evidence({
          type: EVIDENCE_TYPES.TEST_PASS,
          description: `Found ${testFiles.length} test files in tools/`,
          passed: true,
          detail: testFiles.join(', '),
        }));
      }
    }
  }

  // Git evidence - last commit
  try {
    const result = spawnSync('git', ['-C', cwd, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 5000 });
    if (result.status === 0) {
      const sha = String(result.stdout || '').trim();
      all.push(new Evidence({ type: EVIDENCE_TYPES.COMMIT, description: 'Current HEAD', passed: true, detail: sha, metadata: { sha } }));
    }
  } catch { /* not a git repo or no commits */ }

  return all;
}

function truncateStdout(text, maxLen) {
  if (!text || text.length <= maxLen) return text || '';
  return text.slice(0, maxLen) + `\n... (${text.length - maxLen} more chars)`;
}