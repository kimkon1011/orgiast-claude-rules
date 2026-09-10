import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { anomalyFingerprint, normalizeMessage, runRemediation } from './nightly-health-remediate.mjs';
import * as selfHealed from './lib/remediate-playbooks/self-healed.mjs';
import * as failover from './lib/remediate-playbooks/failover-succeeded.mjs';
import * as contention from './lib/remediate-playbooks/log-write-contention.mjs';

test('fingerprint ignores changing timestamps and counts', () => {
  const a = anomalyFingerprint({ label: 'job', message: '2026-09-10 07:00 error 12' });
  const b = anomalyFingerprint({ label: 'job', message: '2026-09-11 08:00 error 99' });
  assert.equal(a, b); assert.match(normalizeMessage('x 42'), /<n>/);
});

test('self-healed and failover playbooks require a later success', async () => {
  assert.equal(await selfHealed.match({ expectation: { successPattern: 'open=0' }, logTail: 'ERROR aborted\nopen=0' }), true);
  assert.equal(await failover.match({ logTail: 'ERROR 429\n[failover] groq -> deepseek\nOK done' }), true);
});

test('log contention recognizes appendLineWithRetry migration', async () => {
  const a = { message: 'EBUSY', expectation: { tool: 'x.mjs' } };
  assert.equal((await contention.apply(a, { readRepoFile: () => 'appendLineWithRetry(file, line)' })).outcome, 'fixed');
});

function makeHome(t, input, ledger = []) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'remediate-')); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  if (input !== undefined) fs.writeFileSync(path.join(home, '.claude', '.nightly-health-last.json'), JSON.stringify(input));
  if (ledger.length) fs.writeFileSync(path.join(home, '.claude', 'nightly-health-remediate-ledger.jsonl'), `${ledger.map(JSON.stringify).join('\n')}\n`);
  return home;
}

async function captureConsole(fn) {
  const lines = [], original = console.log; console.log = (...args) => lines.push(args.join(' '));
  try { return { value: await fn(), lines }; } finally { console.log = original; }
}

test('dry-run reports PLAN for a matching playbook and never calls apply or notification', async (t) => {
  const home = makeHome(t, { anomalies: [{ label: 'x', message: 'bad' }] });
  let applied = 0, notified = 0;
  const pb = { name: 'test', match: async () => true, apply: async () => { applied++; return { outcome: 'fixed' }; }, verify: async () => true };
  const { value: result, lines } = await captureConsole(() => runRemediation({ home, dryRun: true, json: false, playbooks: [pb], notify: async () => notified++ }));
  assert.equal(applied, 0); assert.equal(notified, 0); assert.equal(result.plan[0].action, 'playbook=test');
  assert.match(lines.join('\n'), /PLAN x: playbook=test/);
  assert.match(lines.at(-1), /deferred=0/);
});

test('repair limit defers without decision or notification', async (t) => {
  const home = makeHome(t, { anomalies: [{ label: 'limit', message: 'bad' }] });
  let decisions = 0, notifications = 0;
  const result = await runRemediation({ home, playbooks: [], maxCodex: 0, decision: () => decisions++, notify: async () => notifications++ });
  assert.equal(result.deferred.length, 1); assert.equal(result.escalated.length, 0);
  assert.equal(decisions, 0); assert.equal(notifications, 0);
});

test('open PR defers, while merged or closed PR allows retry', async (t) => {
  const now = new Date('2026-09-10T12:00:00Z');
  const anomaly = { label: 'pr-case', message: 'bad' }, fingerprint = anomalyFingerprint(anomaly);
  const ledger = [{ fingerprint, label: anomaly.label, outcome: 'pr', ranAt: '2026-09-08T12:00:00Z' }];
  const openHome = makeHome(t, { anomalies: [anomaly] }, ledger);
  const open = await runRemediation({ home: openHome, now, dryRun: true, json: true, playbooks: [], run: () => ({ status: 0, stdout: '[{"url":"https://example.test/pr/1"}]', stderr: '' }) });
  assert.equal(open.plan[0].action, 'deferred'); assert.match(open.plan[0].reason, /PRがopen/);

  const mergedHome = makeHome(t, { anomalies: [anomaly] }, ledger);
  const merged = await runRemediation({ home: mergedHome, now, dryRun: true, json: true, playbooks: [], run: () => ({ status: 0, stdout: '[]', stderr: '' }) });
  assert.equal(merged.plan[0].action, 'codex');
});

test('third recurrence after two deferred or PR outcomes escalates', async (t) => {
  const now = new Date('2026-09-10T12:00:00Z');
  const anomaly = { label: 'repeat', message: 'bad' }, fingerprint = anomalyFingerprint(anomaly);
  const home = makeHome(t, { anomalies: [anomaly] }, [
    { fingerprint, outcome: 'deferred', ranAt: '2026-09-04T12:00:00Z' },
    { fingerprint, outcome: 'deferred', ranAt: '2026-09-06T12:00:00Z' }
  ]);
  const result = await runRemediation({ home, now, dryRun: true, json: true, playbooks: [] });
  assert.equal(result.plan[0].action, 'escalate'); assert.match(result.plan[0].reason, /2回以上/);
});

test('missing and empty anomaly caches print an explicit ok line', async (t) => {
  const missing = makeHome(t, undefined);
  const missingOutput = await captureConsole(() => runRemediation({ home: missing }));
  assert.deepEqual(missingOutput.lines, ['ok:異常なし（キャッシュなし）']);
  const empty = makeHome(t, { ranAt: '2026-09-10T06:30:00Z', anomalies: [] });
  const emptyOutput = await captureConsole(() => runRemediation({ home: empty }));
  assert.deepEqual(emptyOutput.lines, ['ok:異常なし（2026-09-10T06:30:00Z）']);
});

test('playbook exception is recorded and the next anomaly is still processed', async (t) => {
  const home = makeHome(t, { anomalies: [{ label: 'one', message: 'bad one' }, { label: 'two', message: 'bad two' }] });
  const pb = { name: 'broken', match: async () => { throw new Error(`token=${'s'.repeat(30)}`); } };
  const result = await runRemediation({ home, playbooks: [pb], notify: async () => {} });
  assert.equal(result.playbookErrors.length, 2);
  assert.equal(result.playbookErrors.every((row) => row.outcome === 'playbook-error'), true);
  assert.equal(JSON.stringify(result).includes('s'.repeat(30)), false);
  const ledger = fs.readFileSync(path.join(home, '.claude', 'nightly-health-remediate-ledger.jsonl'), 'utf8');
  assert.equal((ledger.match(/playbook-error/g) || []).length, 2);
});

test('any nonzero codex exit tries cheap-code once and reports both redacted failures', async (t) => {
  const home = makeHome(t, { anomalies: [{ label: 'repair', message: 'bad' }] });
  const calls = [];
  const run = (_exe, args) => {
    calls.push(args);
    if (args.some((arg) => String(arg).endsWith('codex-do.mjs'))) return { status: 124, stdout: '', stderr: `codex token=${'a'.repeat(30)}` };
    if (args.some((arg) => String(arg).endsWith('cheap-code.mjs'))) return { status: 7, stdout: '', stderr: `cheap sk-${'b'.repeat(20)}` };
    return { status: 0, stdout: '', stderr: '' };
  };
  const result = await runRemediation({ home, playbooks: [], run, decision: () => {}, notify: async () => {} });
  assert.equal(calls.filter((args) => args.some((arg) => String(arg).endsWith('cheap-code.mjs'))).length, 1);
  assert.match(result.escalated[0].reason, /codex exit 124/);
  assert.match(result.escalated[0].reason, /cheap-code exit 7/);
  assert.equal(result.escalated[0].reason.includes('a'.repeat(30)), false);
  assert.equal(result.escalated[0].reason.includes('b'.repeat(20)), false);
});
