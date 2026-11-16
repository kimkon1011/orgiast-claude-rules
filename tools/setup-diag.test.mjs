// setup-diag.mjs のテスト
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const toolsDir = path.dirname(fileURLToPath(import.meta.url));

async function createDiag() {
  const mod = await import('./setup-diag.mjs');
  return mod.createConvergeDiag;
}

test('RUNNER_TEMP 未設定では no-op で書き込まない', async () => {
  // RUNNER_TEMP が undefined であることを確認
  const orig = process.env.RUNNER_TEMP;
  delete process.env.RUNNER_TEMP;
  try {
    const createFn = await createDiag();
    const diag = createFn();
    assert.equal(diag.active, false);
    diag.begin('test');
    diag.end('test', 'ok');
    diag.write('message');
    diag.execFileSyncFail('test');
    diag.setupProcessHandlers();
    assert.equal(diag.getCurrentStep(), '');
  } finally {
    if (orig !== undefined) process.env.RUNNER_TEMP = orig;
  }
});

test('RUNNER_TEMP 設定時はファイルができる', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'diag-test-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const orig = process.env.RUNNER_TEMP;
  process.env.RUNNER_TEMP = tmp;
  try {
    const createFn = await createDiag();
    const diag = createFn();
    assert.equal(diag.active, true);
    const logFile = path.join(tmp, 'clean-install-logs', 'setup-steps.log');
    assert.ok(fs.existsSync(logFile));
    const content = fs.readFileSync(logFile, 'utf8');
    assert.match(content, /converge diag started/);
  } finally {
    if (orig === undefined) delete process.env.RUNNER_TEMP;
    else process.env.RUNNER_TEMP = orig;
  }
});

test('begin/end が正しく追記される', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'diag-begin-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const orig = process.env.RUNNER_TEMP;
  process.env.RUNNER_TEMP = tmp;
  try {
    const createFn = await createDiag();
    const diag = createFn();
    diag.begin('step1');
    diag.end('step1', 'OK', 'extra info');
    diag.begin('step2');
    diag.end('step2', 'NG');

    const logFile = path.join(tmp, 'clean-install-logs', 'setup-steps.log');
    const content = fs.readFileSync(logFile, 'utf8');
    const lines = content.split('\n').filter(Boolean);

    assert.match(lines[0], /converge diag started/);
    assert.match(lines[1], /begin: step1/);
    assert.match(lines[2], /end: step1 status=OK extra info/);
    assert.match(lines[3], /begin: step2/);
    assert.match(lines[4], /end: step2 status=NG/);
  } finally {
    if (orig === undefined) delete process.env.RUNNER_TEMP;
    else process.env.RUNNER_TEMP = orig;
  }
});

test('execFileSyncFail が status/signal/stderr を追記する', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'diag-fail-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const orig = process.env.RUNNER_TEMP;
  process.env.RUNNER_TEMP = tmp;
  try {
    const createFn = await createDiag();
    const diag = createFn();
    diag.execFileSyncFail('test-command', { status: 1, stderr: 'something went wrong' });

    const logFile = path.join(tmp, 'clean-install-logs', 'setup-steps.log');
    const content = fs.readFileSync(logFile, 'utf8');
    assert.match(content, /execFileSync FAIL: test-command/);
    assert.match(content, /status=1/);
    assert.match(content, /stderr=something went wrong/);
  } finally {
    if (orig === undefined) delete process.env.RUNNER_TEMP;
    else process.env.RUNNER_TEMP = orig;
  }
});