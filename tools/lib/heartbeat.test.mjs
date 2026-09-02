import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { reportHeartbeat } from './heartbeat.mjs';

async function tempHome() {
  return mkdtemp(path.join(os.tmpdir(), 'heartbeat-test-'));
}

test('missing env is fail-open and local record is written', async () => {
  const homeDir = await tempHome();
  const record = { job: 'nightly', startedAt: 'a', finishedAt: 'b', ok: true, summary: 'done' };
  const result = await reportHeartbeat(record, { homeDir, fetchImpl: () => assert.fail('fetch called') });
  assert.equal(result.written, true);
  assert.equal(result.sent, false);
  assert.deepEqual(JSON.parse(await readFile(path.join(homeDir, '.claude', 'heartbeat', 'nightly.json'))), record);
});

test('empty token is fail-open and does not fetch', async () => {
  const homeDir = await tempHome();
  await mkdir(path.join(homeDir, '.claude'), { recursive: true });
  await writeFile(path.join(homeDir, '.claude', 'task-sheet.env'), 'TASK_SHEET_WEBAPP_URL=https://example.test/exec\nTASK_SHEET_TOKEN=\n');
  const result = await reportHeartbeat({ job: 'x', ok: false }, { homeDir, fetchImpl: () => assert.fail('fetch called') });
  assert.equal(result.sent, false);
  assert.match(result.warning, /empty/);
});

test('configured heartbeat sends the upsertJob payload', async () => {
  const homeDir = await tempHome();
  await mkdir(path.join(homeDir, '.claude'), { recursive: true });
  await writeFile(path.join(homeDir, '.claude', 'task-sheet.env'), 'TASK_SHEET_WEBAPP_URL=https://example.test/exec\nTASK_SHEET_TOKEN=secret\n');
  let call;
  const record = { job: 'x', startedAt: 'a', finishedAt: 'b', ok: true, summary: 'ok' };
  const result = await reportHeartbeat(record, { homeDir, fetchImpl: async (...args) => {
    call = args;
    return { ok: true, json: async () => ({ ok: true }) };
  } });
  assert.equal(result.sent, true);
  assert.equal(call[0], 'https://example.test/exec');
  assert.deepEqual(JSON.parse(call[1].body), { token: 'secret', kind: 'upsertJob', ...record });
});

test('--dry-run writes no file and performs no HTTP request', async () => {
  const homeDir = await tempHome();
  const script = fileURLToPath(new URL('./heartbeat.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [script, '--job', 'dry', '--ok', 'true', '--summary', 'plan', '--dry-run'], {
    encoding: 'utf8', env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).dryRun, true);
  await assert.rejects(access(path.join(homeDir, '.claude', 'heartbeat', 'dry.json')));
});
