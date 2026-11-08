import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { machineIdentity } from './machine-identity.mjs';
import { ledgerRows, parseLedgerArgs, runTaskLedger } from './task-ledger.mjs';

async function fixture() {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'ledger-test-'));
  await mkdir(path.join(homeDir, '.claude'));
  await writeFile(path.join(homeDir, '.claude', 'task-sheet.env'), '# test\nTASK_SHEET_WEBAPP_URL=https://example.test/exec\nTASK_SHEET_TOKEN=secret\n');
  const calls = [];
  const fetchImpl = async (...call) => {
    calls.push(call);
    return { ok: true, status: 200, json: async () => ({ ok: true, value: 'result' }) };
  };
  return { homeDir, calls, fetchImpl };
}

test('upsert sends the expected POST payload', async () => {
  const f = await fixture();
  await runTaskLedger(parseLedgerArgs(['upsert', '--taskId', 'T1', '--件名', '件名', '--状態', '未着手']), f);
  assert.equal(f.calls[0][0], 'https://example.test/exec');
  assert.equal(f.calls[0][1].method, 'POST');
  assert.deepEqual(JSON.parse(f.calls[0][1].body), { token: 'secret', kind: 'upsertTask', taskId: 'T1', 件名: '件名', 状態: '未着手' });
});

test('claim uses machine hostname when 担当PC is omitted', async () => {
  const f = await fixture();
  await runTaskLedger(parseLedgerArgs(['claim', '--taskId', 'T2']), f);
  assert.equal(JSON.parse(f.calls[0][1].body).担当PC, machineIdentity().hostname);
});

test('claim accepts explicit owner and state', async () => {
  const f = await fixture();
  await runTaskLedger(parseLedgerArgs(['claim', '--taskId', 'T2', '--担当PC', 'PC2', '--状態', '作業中']), f);
  assert.deepEqual(JSON.parse(f.calls[0][1].body), { token: 'secret', kind: 'claimTask', taskId: 'T2', 担当PC: 'PC2', 状態: '作業中' });
});

test('already_claimed is returned as a successful control-flow result', async () => {
  const f = await fixture();
  f.fetchImpl = async (...call) => {
    f.calls.push(call);
    return { ok: true, json: async () => ({ ok: false, error: 'already_claimed', owner: 'PC1' }) };
  };
  assert.deepEqual(await runTaskLedger(parseLedgerArgs(['claim', '--taskId', 'T2']), f), { ok: false, error: 'already_claimed', owner: 'PC1' });
});

test('done sends only supported optional fields', async () => {
  const f = await fixture();
  await runTaskLedger(parseLedgerArgs(['done', '--taskId', 'T3', '--成果物リンク', 'https://result', '--備考', '完了']), f);
  assert.deepEqual(JSON.parse(f.calls[0][1].body), { token: 'secret', kind: 'doneTask', taskId: 'T3', 成果物リンク: 'https://result', 備考: '完了' });
});

test('list sends encoded filters with GET', async () => {
  const f = await fixture();
  await runTaskLedger(parseLedgerArgs(['list', '--状態', '実行中', '--担当PC', 'PC 1']), f);
  const target = new URL(f.calls[0][0]);
  assert.equal(f.calls[0][1].method, 'GET');
  assert.equal(target.searchParams.get('token'), 'secret');
  assert.equal(target.searchParams.get('状態'), '実行中');
  assert.equal(target.searchParams.get('担当PC'), 'PC 1');
});

test('--dry-run does not read env or fetch', async () => {
  const result = await runTaskLedger(parseLedgerArgs(['upsert', '--taskId', 'T4', '--dry-run']), {
    homeDir: '/does/not/exist', fetchImpl: () => assert.fail('fetch called'), identity: { hostname: 'PC' },
  });
  assert.deepEqual(result, { dryRun: true, method: 'POST', payload: { kind: 'upsertTask', taskId: 'T4' } });
});

test('empty token fails explicitly without fetching', async () => {
  const f = await fixture();
  await writeFile(path.join(f.homeDir, '.claude', 'task-sheet.env'), 'TASK_SHEET_WEBAPP_URL=https://example.test/exec\nTASK_SHEET_TOKEN=\n');
  await assert.rejects(runTaskLedger(parseLedgerArgs(['list']), f), /TASK_SHEET_TOKEN is empty/);
  assert.equal(f.calls.length, 0);
});

test('list は一時的な 404 を5秒後に1回だけ再試行する', async () => {
  const f = await fixture();
  const sleeps = [];
  let count = 0;
  f.fetchImpl = async (...call) => {
    f.calls.push(call);
    count += 1;
    return { ok: count === 1 ? false : true, status: count === 1 ? 404 : 200, json: async () => ({ ok: true, rows: [] }) };
  };
  await runTaskLedger(parseLedgerArgs(['list']), { ...f, sleep: async (ms) => { sleeps.push(ms); } });
  assert.equal(f.calls.length, 2);
  assert.deepEqual(sleeps, [5000]);
});

test('404 が続くときは2回で諦め、一時的でない 403 は再試行しない', async () => {
  const failTwice = await fixture();
  failTwice.fetchImpl = async (...call) => {
    failTwice.calls.push(call);
    return { ok: false, status: 404, json: async () => ({}) };
  };
  await assert.rejects(
    runTaskLedger(parseLedgerArgs(['list']), { ...failTwice, sleep: async () => {} }),
    /HTTP 404/,
  );
  assert.equal(failTwice.calls.length, 2);
  const forbidden = await fixture();
  forbidden.fetchImpl = async (...call) => {
    forbidden.calls.push(call);
    return { ok: false, status: 403, json: async () => ({}) };
  };
  await assert.rejects(
    runTaskLedger(parseLedgerArgs(['list']), { ...forbidden, sleep: async () => { throw new Error('403 must not be retried'); } }),
    /HTTP 403/,
  );
  assert.equal(forbidden.calls.length, 1);
});

test('upsert の一時的な 500 も1回だけ再試行する（taskId 冪等のため再送安全）', async () => {
  const f = await fixture();
  let count = 0;
  f.fetchImpl = async (...call) => {
    f.calls.push(call);
    count += 1;
    return { ok: count === 1 ? false : true, status: count === 1 ? 500 : 200, json: async () => ({ ok: true, value: 'result' }) };
  };
  await runTaskLedger(parseLedgerArgs(['upsert', '--taskId', 'T1', '--件名', '件名']), { ...f, sleep: async () => {} });
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls.every(([, init]) => init.method === 'POST'), true);
});

test('ledgerRows は実形 {ok, rows, count} を読む', () => {
  const rows = [{ taskId: 'T1' }];
  assert.deepEqual(ledgerRows({ ok: true, rows, count: 1 }), rows);
});

test('ledgerRows は items/tasks/配列も受け、未知の形は空配列にする', () => {
  assert.deepEqual(ledgerRows({ items: [1] }), [1]);
  assert.deepEqual(ledgerRows({ tasks: [2] }), [2]);
  assert.deepEqual(ledgerRows([3]), [3]);
  assert.deepEqual(ledgerRows({ ok: true, count: 0 }), []);
  assert.deepEqual(ledgerRows(null), []);
  assert.deepEqual(ledgerRows(undefined), []);
});
