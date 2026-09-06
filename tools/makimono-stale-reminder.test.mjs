import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCheck } from './makimono-stale-reminder.mjs';

const NOW = new Date('2026-08-27T12:00:00.000Z');

function createTempHome(submissions = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'makimono-stale-test-'));
  const claudeDir = path.join(root, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  
  // Create makimono.env to bypass ensureKey network calls
  fs.writeFileSync(
    path.join(claudeDir, 'makimono.env'),
    'MAKIMONO_EMAIL=test@example.com\nMAKIMONO_KEY=mk_test_key_123456789\n'
  );
  
  // Create cost-reporter.env with dummy webhook URL
  fs.writeFileSync(
    path.join(claudeDir, 'cost-reporter.env'),
    'DISCORD_COST_WEBHOOK=https://example.com/mock-discord-webhook\n'
  );
  
  // Create makimono-submissions.json
  if (submissions) {
    fs.writeFileSync(
      path.join(claudeDir, 'makimono-submissions.json'),
      JSON.stringify(submissions, null, 2) + '\n'
    );
  }
  
  return root;
}

test('1. 審査待ちがあればledgerに1行追記される', async () => {
  const stalePendingSubmission = {
    at: '2026-08-20T12:00:00.000Z', // 7 days ago relative to NOW (staleDays = 3)
    title: '安全な夜間処理の手順',
    submissionId: 'sub_dummy',
    status: 'pending',
  };

  const home = createTempHome([stalePendingSubmission]);
  const ledgerFile = path.join(home, '.claude', 'hook-selfheal-ledger.jsonl');
  const stateFile = path.join(home, '.claude', 'makimono-stale-reminder-state.json');

  let fetchCalls = [];
  const mockFetch = async (url, options) => {
    fetchCalls.push({ url, options });
    if (url.includes('/api/v1/listings/sub_dummy')) {
      return { ok: true, status: 200, json: async () => ({ status: 'pending', submissionId: 'sub_dummy' }) };
    }
    if (url.includes('/api/v1/search')) {
      return { ok: true, status: 200, json: async () => [] };
    }
    if (url.includes('/mock-discord-webhook')) {
      return { ok: true, status: 204, json: async () => ({}) };
    }
    throw new Error(`Unexpected mockFetch call: ${url}`);
  };

  const originalFetch = globalThis.fetch;
  const originalOrgHome = process.env.ORGIAST_HOME;

  globalThis.fetch = mockFetch;
  process.env.ORGIAST_HOME = home;

  try {
    const checkResult = await runCheck({
      home,
      now: NOW,
      throttleMs: 4 * 60 * 60 * 1000,
      staleDays: 3,
      ledgerFile,
      stateFile,
      fetchImpl: mockFetch,
    });

    assert.equal(checkResult.ran, true);
    assert.equal(checkResult.result.stale, 1);
    assert.equal(checkResult.result.pending, 1);

    // Verify state file was written
    assert.ok(fs.existsSync(stateFile));
    const stateContent = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.equal(stateContent.lastRunAt, NOW.toISOString());

    // Verify ledger was written
    assert.ok(fs.existsSync(ledgerFile));
    const ledgerLines = fs.readFileSync(ledgerFile, 'utf8').trim().split('\n').filter(Boolean);
    assert.equal(ledgerLines.length, 1);
    const ledgerRecord = JSON.parse(ledgerLines[0]);
    assert.equal(ledgerRecord.tool, 'makimono-stale-reminder');
    assert.equal(ledgerRecord.pending, 1);
    assert.equal(ledgerRecord.stale, 1);
    assert.equal(ledgerRecord.rejected, 0);
    assert.ok(ledgerRecord.ts);

    // Verify that mockFetch was called
    assert.ok(fetchCalls.length > 0);
  } finally {
    globalThis.fetch = originalFetch;
    process.env.ORGIAST_HOME = originalOrgHome;
    try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
  }
});

test('2. スロットル中はネットワークを呼ばずledgerも書かない', async () => {
  const stalePendingSubmission = {
    at: '2026-08-20T12:00:00.000Z',
    title: '安全な夜間処理の手順',
    submissionId: 'sub_dummy',
    status: 'pending',
  };

  const home = createTempHome([stalePendingSubmission]);
  const ledgerFile = path.join(home, '.claude', 'hook-selfheal-ledger.jsonl');
  const stateFile = path.join(home, '.claude', 'makimono-stale-reminder-state.json');

  // Pre-seed state file with a recent run (1 hour before NOW)
  const lastRunAt = new Date(NOW.getTime() - 1 * 60 * 60 * 1000).toISOString();
  fs.writeFileSync(stateFile, JSON.stringify({ lastRunAt }) + '\n');

  let fetchCalls = [];
  const mockFetch = async (url) => {
    fetchCalls.push(url);
    throw new Error('Fetch must not be called during throttle!');
  };

  const originalFetch = globalThis.fetch;
  const originalOrgHome = process.env.ORGIAST_HOME;

  globalThis.fetch = mockFetch;
  process.env.ORGIAST_HOME = home;

  try {
    const checkResult = await runCheck({
      home,
      now: NOW,
      throttleMs: 4 * 60 * 60 * 1000,
      staleDays: 3,
      ledgerFile,
      stateFile,
      fetchImpl: mockFetch,
    });

    assert.equal(checkResult.ran, false);
    assert.equal(checkResult.reason, 'throttled');

    // Verify fetch was never called
    assert.equal(fetchCalls.length, 0);

    // Verify ledger was not written
    assert.equal(fs.existsSync(ledgerFile), false);

    // Verify state file was not updated
    const stateContent = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.equal(stateContent.lastRunAt, lastRunAt);
  } finally {
    globalThis.fetch = originalFetch;
    process.env.ORGIAST_HOME = originalOrgHome;
    try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
  }
});

test('3. スロットル期間を過ぎれば再実行される', async () => {
  const stalePendingSubmission = {
    at: '2026-08-20T12:00:00.000Z',
    title: '安全な夜間処理の手順',
    submissionId: 'sub_dummy',
    status: 'pending',
  };

  const home = createTempHome([stalePendingSubmission]);
  const ledgerFile = path.join(home, '.claude', 'hook-selfheal-ledger.jsonl');
  const stateFile = path.join(home, '.claude', 'makimono-stale-reminder-state.json');

  // Pre-seed state file with an old run (5 hours before NOW, throttle is 4 hours)
  const lastRunAt = new Date(NOW.getTime() - 5 * 60 * 60 * 1000).toISOString();
  fs.writeFileSync(stateFile, JSON.stringify({ lastRunAt }) + '\n');

  let fetchCalls = [];
  const mockFetch = async (url, options) => {
    fetchCalls.push({ url, options });
    if (url.includes('/api/v1/listings/sub_dummy')) {
      return { ok: true, status: 200, json: async () => ({ status: 'pending', submissionId: 'sub_dummy' }) };
    }
    if (url.includes('/api/v1/search')) {
      return { ok: true, status: 200, json: async () => [] };
    }
    if (url.includes('/mock-discord-webhook')) {
      return { ok: true, status: 204, json: async () => ({}) };
    }
    throw new Error(`Unexpected mockFetch call: ${url}`);
  };

  const originalFetch = globalThis.fetch;
  const originalOrgHome = process.env.ORGIAST_HOME;

  globalThis.fetch = mockFetch;
  process.env.ORGIAST_HOME = home;

  try {
    const checkResult = await runCheck({
      home,
      now: NOW,
      throttleMs: 4 * 60 * 60 * 1000,
      staleDays: 3,
      ledgerFile,
      stateFile,
      fetchImpl: mockFetch,
    });

    assert.equal(checkResult.ran, true);
    assert.equal(checkResult.result.stale, 1);

    // Verify fetch was called
    assert.ok(fetchCalls.length > 0);

    // Verify ledger was written
    assert.ok(fs.existsSync(ledgerFile));
    const ledgerLines = fs.readFileSync(ledgerFile, 'utf8').trim().split('\n').filter(Boolean);
    assert.equal(ledgerLines.length, 1);

    // Verify state file was updated to NOW
    const stateContent = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.equal(stateContent.lastRunAt, NOW.toISOString());
  } finally {
    globalThis.fetch = originalFetch;
    process.env.ORGIAST_HOME = originalOrgHome;
    try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
  }
});

test('4. 出品ログがない場合は、ランはされず no-log を返す', async () => {
  // Pass null to createTempHome to avoid creating makimono-submissions.json
  const home = createTempHome(null);
  const ledgerFile = path.join(home, '.claude', 'hook-selfheal-ledger.jsonl');
  const stateFile = path.join(home, '.claude', 'makimono-stale-reminder-state.json');

  let fetchCalls = [];
  const mockFetch = async (url) => {
    fetchCalls.push(url);
    throw new Error('Fetch must not be called when submissions log is missing!');
  };

  const originalFetch = globalThis.fetch;
  const originalOrgHome = process.env.ORGIAST_HOME;

  globalThis.fetch = mockFetch;
  process.env.ORGIAST_HOME = home;

  try {
    const checkResult = await runCheck({
      home,
      now: NOW,
      throttleMs: 4 * 60 * 60 * 1000,
      staleDays: 3,
      ledgerFile,
      stateFile,
      fetchImpl: mockFetch,
    });

    assert.equal(checkResult.ran, false);
    assert.equal(checkResult.reason, 'no-log');

    // Verify fetch was never called
    assert.equal(fetchCalls.length, 0);

    // Verify ledger was not written
    assert.equal(fs.existsSync(ledgerFile), false);

    // Verify state file was not created
    assert.equal(fs.existsSync(stateFile), false);
  } finally {
    globalThis.fetch = originalFetch;
    process.env.ORGIAST_HOME = originalOrgHome;
    try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
  }
});
