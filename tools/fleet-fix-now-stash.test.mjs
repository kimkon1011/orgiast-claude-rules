import { test, describe } from 'node:test';
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('fleet-fix-now stash behavior', () => {
  test('untracked files only should not appear in --untracked-files=no status', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'test-repo-'));
    try {
      execFileSync('git', ['init'], { cwd: tempDir });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tempDir });
      execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: tempDir });
      writeFileSync(join(tempDir, 'initial.txt'), 'initial content');
      execFileSync('git', ['add', 'initial.txt'], { cwd: tempDir });
      execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: tempDir });

      // Only untracked file exists
      writeFileSync(join(tempDir, 'untracked.txt'), 'untracked content');

      const statusOutput = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: tempDir, encoding: 'utf-8' });
      assert.strictEqual(statusOutput.trim(), '');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('reset --hard does not delete untracked files', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'test-repo-'));
    try {
      execFileSync('git', ['init'], { cwd: tempDir });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tempDir });
      execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: tempDir });
      writeFileSync(join(tempDir, 'initial.txt'), 'initial content');
      execFileSync('git', ['add', 'initial.txt'], { cwd: tempDir });
      execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: tempDir });

      // Only untracked file exists
      writeFileSync(join(tempDir, 'untracked.txt'), 'untracked content');

      execFileSync('git', ['reset', '--hard', 'HEAD'], { cwd: tempDir });
      const untrackedExists = readFileSync(join(tempDir, 'untracked.txt'), 'utf-8');
      assert.strictEqual(untrackedExists, 'untracked content');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('tracked file changes appear in --untracked-files=no status', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'test-repo-'));
    try {
      execFileSync('git', ['init'], { cwd: tempDir });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tempDir });
      execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: tempDir });
      writeFileSync(join(tempDir, 'initial.txt'), 'initial content');
      execFileSync('git', ['add', 'initial.txt'], { cwd: tempDir });
      execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: tempDir });

      // Modify tracked file
      writeFileSync(join(tempDir, 'initial.txt'), 'modified content');

      const statusOutput = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: tempDir, encoding: 'utf-8' });
      assert.notStrictEqual(statusOutput.trim(), '');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('script uses --untracked-files=no and stash push without -u', () => {
    const scriptContent = readFileSync('tools/fleet-fix-now.ps1', 'utf-8');
    assert.ok(scriptContent.includes('--untracked-files=no'), 'Script should use --untracked-files=no to separate untracked check');
    assert.ok(!scriptContent.includes('stash push -u'), 'Script should stash only tracked files (no -u flag)');
  });
});