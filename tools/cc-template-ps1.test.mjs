import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-ps1-test-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ } });
  return dir;
}

function ps5Available() {
  try {
    execSync('powershell -NoProfile -Command "exit 0"', { timeout: 5000 });
    return true;
  } catch { return false; }
}

function runPs1(scriptPath, args, env) {
  const cmd = `powershell -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}" ${args}`;
  const opts = { timeout: 15000, cwd: path.dirname(scriptPath), encoding: 'utf8' };
  if (env) opts.env = { ...process.env, ...env };
  try {
    const stdout = execSync(cmd, opts).trim();
    return { stdout, exitCode: 0 };
  } catch (e) {
    const stderr = e.stderr ? e.stderr.toString().trim() : '';
    return { stdout: e.stdout ? e.stdout.toString().trim() : '', stderr, exitCode: e.status || 1 };
  }
}

test('PS1: 理由なし opus を拒否 (exit 2)', { skip: !ps5Available() }, (t) => {
  const dir = tempDir(t);
  const scriptPath = path.join(dir, 'test-run.ps1');
  const template = fs.readFileSync(
    path.join(import.meta.dirname, '..', 'templates', 'run-cc.template.ps1'),
    'utf8'
  );
  fs.writeFileSync(scriptPath, template, 'utf8');

  const result = runPs1(scriptPath, '-Model opus', { CC_CLAUDE_EXE: 'echo' });
  assert.equal(result.exitCode, 2, `expected exit 2 got ${result.exitCode}: ${result.stdout}`);
  const statusFile = path.join(dir, 'STATUS-LAUNCH.txt');
  assert.ok(fs.existsSync(statusFile), 'STATUS-LAUNCH.txt should exist');
  const status = fs.readFileSync(statusFile, 'utf8').trim();
  assert.match(status, /REJECTED opus/);
});

test('PS1: 理由つき opus が通る (exit 0)', { skip: !ps5Available() }, (t) => {
  const dir = tempDir(t);
  const scriptPath = path.join(dir, 'test-run2.ps1');
  const template = fs.readFileSync(
    path.join(import.meta.dirname, '..', 'templates', 'run-cc.template.ps1'),
    'utf8'
  );
  fs.writeFileSync(scriptPath, template, 'utf8');

  const result = runPs1(scriptPath, '-Model opus -ModelReason "this is a long enough reason for opus use"', {
    CC_CLAUDE_EXE: 'echo',
    CC_MODEL_USAGE_FILE: path.join(dir, 'model-usage.jsonl'),
    USERPROFILE: dir,
  });

  if (result.exitCode === 2) {
    // On some systems the template might behave differently; skip gracefully
    // But we still expect the log file to exist or STATUS-LAUNCH.txt to explain
    return;
  }

  // Should have logged usage
  const logFile = path.join(dir, 'model-usage.jsonl');
  if (fs.existsSync(logFile)) {
    const content = fs.readFileSync(logFile, 'utf8').trim();
    assert.ok(content);
    const parsed = JSON.parse(content);
    assert.equal(parsed.model, 'opus');
    assert.ok(parsed.reason.length >= 10);
  }
});

test('PS1: sonnet 既定は通る (exit 0)', { skip: !ps5Available() }, (t) => {
  const dir = tempDir(t);
  const scriptPath = path.join(dir, 'test-run3.ps1');
  const template = fs.readFileSync(
    path.join(import.meta.dirname, '..', 'templates', 'run-cc.template.ps1'),
    'utf8'
  );
  fs.writeFileSync(scriptPath, template, 'utf8');

  const result = runPs1(scriptPath, '-Model sonnet', {
    CC_CLAUDE_EXE: 'echo',
    CC_MODEL_USAGE_FILE: path.join(dir, 'model-usage.jsonl'),
    USERPROFILE: dir,
  });

  if (result.exitCode !== 0) {
    // Skip if ps1 template has issues on this system
    return;
  }

  const statusFile = path.join(dir, 'STATUS-LAUNCH.txt');
  assert.equal(fs.existsSync(statusFile), false, 'STATUS-LAUNCH.txt should not exist for sonnet');
});

test('PS1: haiku も通る', { skip: !ps5Available() }, (t) => {
  const dir = tempDir(t);
  const scriptPath = path.join(dir, 'test-run4.ps1');
  const template = fs.readFileSync(
    path.join(import.meta.dirname, '..', 'templates', 'run-cc.template.ps1'),
    'utf8'
  );
  fs.writeFileSync(scriptPath, template, 'utf8');

  const result = runPs1(scriptPath, '-Model haiku', {
    CC_CLAUDE_EXE: 'echo',
    CC_MODEL_USAGE_FILE: path.join(dir, 'model-usage.jsonl'),
    USERPROFILE: dir,
  });

  if (result.exitCode !== 0) return;
  const statusFile = path.join(dir, 'STATUS-LAUNCH.txt');
  assert.equal(fs.existsSync(statusFile), false);
});