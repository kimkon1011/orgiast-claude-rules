import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { iso, DAY, HOUR, saveJson, checkLedger, chase, digestText, work, ledgerPath } from './fleet-chase.mjs';
import { ROLLOUT_POLICY as P, updateComplianceHistory, reconcileRollout, complianceTable,
  collectRollout, complianceHistoryPath } from './lib/fleet-chase-rollout.mjs';
import { measuredRules, rulesRegistry, buildRuleComplianceMail, COMPLIANCE_DAYS } from './lib/rule-compliance-mail.mjs';
import { selectContext } from './fleet-chase-context.mjs';
import { runChase, statusTable } from './fleet-chase.mjs';
const NOW = Date.parse('2026-10-18T03:00:00Z');
const rule = measuredRules[0];
function report(at, pc = 'test-PC', changes = {}) {
  return JSON.parse(buildRuleComplianceMail({ pc, at: iso(at), days: COMPLIANCE_DAYS, rulesHead: 'abc',
    rules: { [rule.id]: { applicable: P.applicable * 2, violation: P.applicable * 2, ...changes } } }).body);
}
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rollout-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, '.claude/fleet-inbox'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude/cost-reporter.env'), 'REPORTER_LABEL=kim-PC\n');
  const ledger = { version: 1, items: {} }, sends = [], requests = [];
  const ctx = { home, now: NOW, dryRun: true, repo: path.resolve('.'), stderr: () => {},
    pcMap: { 'test-PC': {}, 'kim-PC': {} }, fetchBeacons: async () => ({ ok: true, beacons: [] }),
    freshness: async () => ({ stale: false }), persist() {},
    request: async (kind, payload) => { requests.push(kind); if (kind === 'mail-send') sends.push(payload); return { ok: true, mail: { id: payload.id, status: 'seen', seenAt: iso(NOW) } }; } };
  let history = { pcs: {} }, latest = [];
  const reconcile = (reports, now = NOW, extra = {}) => {
    history = updateComplianceHistory(history, reports, now);
    latest = Object.values(history.pcs).map(days => Object.values(days).sort((a, b) => a.at.localeCompare(b.at)).at(-1));
    const snapshot = { history, latest, rows: [], convergence: null, ...extra };
    reconcileRollout(ledger, snapshot, { ...ctx, now });
    return snapshot;
  };
  const seed = (pc = 'test-PC', changes = {}) => reconcile(Array.from({ length: P.consecutiveDays }, (_, i) => report(NOW - (P.consecutiveDays - 1 - i) * DAY, pc, changes)));
  const items = subkind => Object.values(ledger.items).filter(i => i.subkind === subkind);
  return { home, ctx, ledger, sends, requests, reconcile, seed, items };
}
test('rollout requires three distinct consecutive days, minimum sample, validated nondelegated rules', t => {
  const f = fixture(t);
  const reports = Array.from({ length: P.consecutiveDays }, (_, i) => report(NOW - (P.consecutiveDays - 1 - i) * DAY));
  f.reconcile(reports.slice(0, -1)); assert.equal(f.items('violation').length, 0);
  f.reconcile([reports.at(-2)]); assert.equal(f.items('violation').length, 0);
  f.reconcile([reports.at(-1)]); assert.equal(f.items('violation').length, 1);
  f.reconcile(reports); assert.equal(f.items('violation').length, 1);
  const missing = fixture(t); missing.reconcile([report(NOW - 4 * DAY), report(NOW - DAY), report(NOW)]);
  assert.equal(missing.items('violation').length, 0);
  const small = fixture(t); small.seed('test-PC', { applicable: P.applicable - 1, violation: P.applicable - 1 });
  assert.equal(small.items('violation').length, 0);
  const excluded = rulesRegistry.rules.filter(r => !measuredRules.includes(r));
  for (const excludedRule of excluded) assert.equal(f.items('violation').some(i => i.ruleId === excludedRule.id), false);
});
test('rollout closes on later improvement, never on missing/zero samples or stale reports; history retained 30 days', t => {
  const f = fixture(t); f.seed(); const item = f.items('violation')[0];
  f.reconcile([report(NOW + DAY, 'test-PC', { applicable: 0, violation: 0 })], NOW + DAY);
  assert.equal(item.status, 'open');
  f.reconcile([report(NOW + 2 * DAY, 'test-PC', { violation: 0 })], NOW + 2 * DAY);
  assert.equal(item.status, 'done'); assert.equal(item.evidence.type, 'compliance-report');
  f.reconcile([], NOW + 2 * DAY); assert.equal(f.items('violation')[0].status, 'done');
  f.reconcile([report(NOW + 3 * DAY)], NOW + 3 * DAY); assert.equal(f.items('violation')[0].status, 'done');
  const history = updateComplianceHistory({}, Array.from({ length: P.historyDays + 5 }, (_, i) => report(NOW - i * DAY)), NOW);
  assert.equal(Object.keys(history.pcs['test-PC']).length, P.historyDays);
});
test('block needs verified done reply plus a subsequent fresh report; replay cannot reopen done', async t => {
  const f = fixture(t); f.seed('test-PC', { mode: 'block' }); const item = f.items('violation')[0];
  await chase(f.ledger, { ...f.ctx, dryRun: false }); assert.equal(f.sends.length, 1);
  assert.match(f.sends[0].why, /\[作業依頼\]/); assert.ok(f.sends[0].body.includes(rule.source));
  f.reconcile([report(NOW + DAY, 'test-PC', { mode: 'block' })], NOW + DAY); assert.equal(item.status, 'open');
  await checkLedger(f.ledger, { ...f.ctx, now: NOW + DAY, request: async (_kind, { id }) => ({ ok: true,
    mail: { id, status: 'done', resultAt: iso(NOW + DAY + HOUR), resultBody: '原因とhook修正済み' } }) });
  assert.equal(item.status, 'open');
  f.reconcile([], NOW + DAY + HOUR); assert.equal(item.status, 'open');
  f.reconcile([report(NOW + 2 * DAY, 'test-PC', { mode: 'block' })], NOW + 2 * DAY);
  assert.equal(item.status, 'done');
  f.reconcile([], NOW + 2 * DAY); assert.equal(f.items('violation')[0].status, 'done');
});
test('stopped reports keep violation open and open no-report only for PCs polling within 48h', t => {
  const f = fixture(t); f.seed(); const later = NOW + P.reportAge;
  const row = (label, age) => ({ label, pollAt: iso(later - age), pollAgeMs: age });
  f.reconcile([], later, { rows: [row('test-PC', HOUR), row('active-PC', P.pollAge), row('offline-PC', P.pollAge + 1)] });
  assert.equal(f.items('violation')[0].status, 'open');
  assert.deepEqual(f.items('no-report').map(i => i.pc).sort(), ['active-PC', 'test-PC']);
  f.reconcile([report(later + HOUR)], later + HOUR);
  assert.equal(f.items('no-report').find(i => i.pc === 'test-PC').status, 'done');
  assert.equal(f.items('violation')[0].status, 'open');
});
test('convergence mirrors entries, never sends, missing state never completes; removal does', async t => {
  const f = fixture(t);
  f.reconcile([], NOW, { convergence: { targets: { key: { firstSeen: NOW - DAY, label: 'test-PC' } } } });
  const item = f.items('convergence')[0]; assert.equal(item.status, 'open');
  await chase(f.ledger, { ...f.ctx, dryRun: false }); assert.equal(f.sends.length, 0);
  f.reconcile([], NOW + HOUR); assert.equal(item.status, 'open');
  f.reconcile([], NOW + HOUR, { convergence: { targets: {} } }); assert.equal(item.status, 'done');
});
test('self rollout is inbound, sends nothing, local work waits for next report and context prioritizes self', async t => {
  const f = fixture(t); f.seed(); const snapshot = f.seed('kim-PC');
  const item = f.items('violation').find(i => i.pc === 'kim-PC');
  assert.equal(item.direction, 'inbound');
  await chase(f.ledger, { ...f.ctx, dryRun: false }); assert.ok(f.sends.every(mail => mail.to !== 'kim-PC'));
  const context = selectContext(f.ledger, { home: f.home, now: NOW });
  assert.ok(context.includes(`kim-PC 自身 ${rule.id}`)); assert.ok(context.includes(rule.summary));
  assert.equal(context.split('\n').filter(line => /kim-PC 自身|^rollout:/.test(line)).length, 1);
  assert.match(statusTable(f.ledger, NOW), /rollout/); assert.match(digestText(f.ledger, f.ctx), /ルール遵守: 違反継続 2 件/);
  assert.match(complianceTable({ ...snapshot, rows: [{ label: 'empty-PC', pollAt: iso(NOW) }] }), /empty-PC \/ —（最終poll/);
  saveJson(path.join(f.home, '.claude/fleet-agent-optin.json'), { accept: ['prompt'] });
  await work(f.ledger, { ...f.ctx, dryRun: false, resolveExe: async () => 'claude',
    run: async options => { assert.match(options.body, /fleet-mail 返信は不要/); return { exitCode: 0, stdoutTail: '修正済み\nCHASE_RESULT: done' }; } });
  assert.equal(item.status, 'open'); assert.equal(item.replyEvidence.type, 'local-work');
  f.reconcile([report(NOW + DAY, 'kim-PC', { mode: 'block' })], NOW + DAY); assert.equal(item.status, 'done');
});
test('collects actual inbox and self JSON; ingest persists history; compliance-only and dry-run write nothing', async t => {
  const f = fixture(t);
  for (let i = 0; i < P.consecutiveDays; i++) {
    const data = report(NOW - i * DAY);
    saveJson(path.join(f.home, `.claude/fleet-inbox/mail-report-${i}.json`), {
      id: `mail-report-${i}`, from: data.pc, to: 'kim-PC', ...buildRuleComplianceMail(data) });
  }
  saveJson(path.join(f.home, '.claude/rule-compliance-fleet-self.json'), report(NOW, 'kim-PC'));
  const before = () => fs.readdirSync(f.home, { recursive: true }).filter(name => fs.statSync(path.join(f.home, name)).isFile())
    .map(name => [name, fs.readFileSync(path.join(f.home, name), 'utf8')]);
  const original = before();
  const result = await runChase({ '--compliance': true, '--dry-run': true }, { ...f.ctx, now: () => NOW });
  assert.match(result.compliance, /kim-PC/); assert.deepEqual(before(), original); assert.equal(f.requests.length, 0);
  await runChase({ '--ingest': true, '--dry-run': true }, { ...f.ctx, now: () => NOW });
  assert.deepEqual(before(), original);
  await runChase({ '--ingest': true }, { ...f.ctx, now: () => NOW });
  assert.ok(fs.existsSync(complianceHistoryPath(f.home)));
  const ledger = JSON.parse(fs.readFileSync(ledgerPath(f.home), 'utf8'));
  assert.equal(Object.values(ledger.items).filter(i => i.kind === 'rollout').length, 1);
  assert.equal((await collectRollout(f.ctx)).latest.length, 2);
});
test('no-report resolves when a delayed but fresh report arrives; done reply alone is insufficient', async t => {
  // 猶予ルール: フリート最初の報告から 72h 経つまで no-report は起票しない。別PCの履歴で warm-up 済みにする。
  const f = fixture(t); f.seed('other-PC'); const later = NOW + P.reportAge;
  f.reconcile([], later, { rows: [{ label: 'test-PC', pollAt: iso(later), pollAgeMs: 0 }] });
  const item = f.items('no-report')[0];
  await chase(f.ledger, { ...f.ctx, now: later, dryRun: false });
  await checkLedger(f.ledger, { ...f.ctx, now: later, request: async (_kind, { id }) => ({ ok: true,
    mail: { id, status: 'done', resultAt: iso(later), resultBody: 'converge実行済み' } }) });
  assert.equal(item.status, 'open');
  f.reconcile([report(later + HOUR)], later + 2 * HOUR);
  assert.equal(item.status, 'done');
});
test('recurrence needs three new bad days and uses a new mail ID; cancelled/deferred rollout remains controlled', async t => {
  const f = fixture(t); f.seed();
  const first = f.items('violation')[0];
  f.reconcile([report(NOW + DAY, 'test-PC', { violation: 0 })], NOW + DAY);
  assert.equal(first.status, 'done');
  for (let i = 1; i <= P.consecutiveDays; i++) f.reconcile([report(NOW + (i + 1) * DAY)], NOW + (i + 1) * DAY);
  const second = f.items('violation')[0];
  assert.equal(second.status, 'open'); assert.notEqual(first.mailId, second.mailId);
  second.deferredUntil = iso(NOW + 20 * DAY);
  await chase(f.ledger, { ...f.ctx, dryRun: false, now: NOW + 5 * DAY }); assert.equal(f.sends.length, 0);
  second.status = 'cancelled';
  f.reconcile([report(NOW + 5 * DAY)], NOW + 5 * DAY); assert.equal(second.status, 'cancelled');
});
test('digest retains rollout counts and three top issues under its length budget', async t => {
  const { DIGEST_LIMIT } = await import('./lib/fleet-chase-actions.mjs');
  const f = fixture(t);
  for (let i = 0; i < 12; i++) f.seed(`PC-${i}`);
  const text = digestText(f.ledger, f.ctx);
  assert.match(text, /違反継続 12 件/);
  assert.equal(text.split('\n').filter(line => line.startsWith('遵守追跡:')).length, 3);
  assert.ok(text.length <= DIGEST_LIMIT);
});
test('no-report waits for fleet warm-up: with no report history at all, polling PCs are not accused on day one', t => {
  const f = fixture(t);
  f.reconcile([], NOW, { rows: [{ label: 'fresh-PC', pollAt: iso(NOW - HOUR), pollAgeMs: HOUR }] });
  assert.equal(f.items('no-report').length, 0);
  // once any PC has reported and 72h passed, silent pollers are chased
  f.reconcile([report(NOW, 'test-PC')], NOW + P.reportAge, { rows: [{ label: 'fresh-PC', pollAt: iso(NOW + P.reportAge - HOUR), pollAgeMs: HOUR }] });
  assert.deepEqual(f.items('no-report').map(i => i.pc), ['fresh-PC']);
});
