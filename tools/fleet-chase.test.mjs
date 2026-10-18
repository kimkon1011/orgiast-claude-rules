import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { POLICY, CATEGORY, DAY, HOUR, iso, makeItem, ingest, checkLedger, chase, digest, digestText,
  control, work, runChase, loadLedger, saveJson, ledgerPath, parseArgs, resendBody } from './fleet-chase.mjs';
import { TERMINAL_STATUSES, parseExecMarkers, acquireLock } from './fleet-mail.mjs';
import { main as register, TASK_NAME } from './register-fleet-chase.mjs';
const NOW = Date.parse('2026-10-18T03:00:00Z');
const mail = (id = 'mail-original', extra = {}) => ({ id, from: 'kim-PC', to: 'nishi-PC',
  action: 'send-attempt', messageKind: 'note', kind: 'note', why: '[作業依頼] 確認', body: '原本の本文',
  createdAt: iso(NOW - 4 * DAY), expiresAt: iso(NOW - DAY), status: 'expired', ...extra });
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-chase-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, '.claude');
  fs.mkdirSync(path.join(dir, 'fleet-inbox'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'cost-reporter.env'), 'REPORTER_LABEL=kim-PC\n');
  const put = m => saveJson(path.join(dir, 'fleet-inbox', `${m.id}.json`), m);
  const sent = rows => fs.writeFileSync(path.join(dir, 'fleet-mail-sent.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  const ledger = { version: 1, items: {}, checks: {} }, requests = [], dms = [], notifications = [], errors = [];
  const ctx = { home, now: NOW, repo: path.resolve('.'), persist: () => saveJson(ledgerPath(home), ledger),
    stderr: s => errors.push(s), pcMap: { 'nishi-PC': { person: '西' }, 'kim-PC': { person: '金' } },
    freshness: async () => ({ stale: false, unknown: false, text: '最終 poll 1h前' }),
    request: async (kind, payload) => { requests.push({ kind, payload }); return { ok: true, mail: kind === 'mail-get' ? { id: payload.id, status: 'expired' } : null }; },
    sendDm: async (...args) => { dms.push(args); return { delivered: true }; },
    notify: async body => { notifications.push(body); return { delivered: 'dm' }; } };
  const add = (m = mail(), kind = 'outbound') => { const item = makeItem(m, kind, NOW); ledger.items[item.id] = item; ledger.checks[m.id] = { verified: true, mail: m }; return item; };
  return { home, dir, put, sent, ledger, ctx, add, requests, dms, notifications, errors };
}

test('ingestion includes expired/failed requests and excludes broadcasts, self, replies, notices; idempotent chase grouping', t => {
  const f = fixture(t);
  const outbound = [mail(), mail('mail-broadcast', { to: 'all' }), mail('mail-self', { to: 'kim-PC' }),
    mail('mail-reply-xyz'), mail('mail-notice', { why: '[配布通知]' }), mail('mail-report', { body: '[報告・返信不要]' }),
    mail('mail-answer', { why: '[回答・返信不要]' }), mail('mail-many', { to: 'nishi-PC,cr-PC' }),
    mail('mail-chase-one', { chaseOf: 'outbound-mail-original' })];
  f.sent(outbound);
  for (const status of TERMINAL_STATUSES.filter(s => s !== 'done')) f.put(mail(`mail-in-${status}`, { from: 'nishi-PC', to: 'kim-PC', status }));
  f.put(mail('mail-all', { from: 'nishi-PC', to: 'all' }));
  f.put(mail('mail-all-note', { to: 'all', why: '通常', body: '確認' }));
  f.put(mail('mail-prompt', { to: 'kim-PC', kind: 'prompt', why: '通常' }));
  f.put(mail('mail-in-report', { to: 'kim-PC', body: '[報告・返信不要]' }));
  f.put(mail('mail-in-other', { to: 'cr-PC' }));
  ingest(f.ledger, f.ctx); ingest(f.ledger, f.ctx);
  const values = Object.values(f.ledger.items);
  assert.equal(values.filter(i => i.kind === 'outbound').length, 1);
  assert.equal(values.filter(i => i.kind === 'inbound').length, TERMINAL_STATUSES.length - 1 + 2);
  assert.ok(values.every(i => i.status === 'open'));
  assert.deepEqual(f.ledger.items['outbound-mail-original'].chaseMailIds, ['mail-chase-one']);
  assert.equal(f.ledger.items['inbound-mail-in-expired'].category, CATEGORY.task);
});
test('initial age > policy threshold is stale, never re-stales revived entries', t => {
  const f = fixture(t); f.sent([mail('mail-old', { createdAt: iso(NOW - POLICY.stale - 1) })]);
  ingest(f.ledger, f.ctx);
  const item = Object.values(f.ledger.items)[0]; assert.equal(item.status, 'stale');
  control(f.ledger, 'revive', item.id, { now: NOW }); ingest(f.ledger, { ...f.ctx, now: NOW + DAY });
  assert.equal(item.status, 'open'); assert.match(digestText(f.ledger, f.ctx), /蘇生: --revive/);
});
test('GAS done closes outbound, cache done alone cannot; blockers derive a single inbound item', async t => {
  const f = fixture(t), done = f.add(), blocked = f.add(mail('mail-blocked')), cached = f.add(mail('mail-cached'));
  saveJson(path.join(f.dir, 'fleet-mail-sent-status.json'), { [cached.mailId]: { status: 'done', resultBody: '完了' } });
  const request = async (_kind, { id }) => ({ ok: true, mail: { id, status: id === cached.mailId ? 'expired' : 'done',
    resultBody: id === blocked.mailId ? 'BLOCKED: push の権限がない' : 'commit abc123', resultAt: iso(NOW) } });
  await checkLedger(f.ledger, { ...f.ctx, request }); await checkLedger(f.ledger, { ...f.ctx, request });
  assert.equal(done.status, 'done'); assert.equal(done.evidence.type, 'reply');
  assert.equal(cached.status, 'open'); assert.equal(blocked.status, 'blocked');
  const derived = Object.values(f.ledger.items).filter(i => i.derivedFrom === blocked.id);
  assert.equal(derived.length, 1); assert.equal(derived[0].kind, 'inbound'); assert.equal(derived[0].mailId, blocked.mailId);
  assert.match(derived[0].title, /ブロッカー解消/);
  f.put(mail(blocked.mailId, { to: 'kim-PC', status: 'done', resultBody: 'BLOCKED', resultAt: iso(NOW) }));
  await checkLedger(f.ledger, { ...f.ctx, request }); assert.equal(derived[0].status, 'open');
});
test('checks rotate across original and chase IDs, bounded by exported limit even with failures', async t => {
  const f = fixture(t);
  const count = POLICY.checkLimit + 3;
  for (let n = 0; n < count; n++) f.add(mail(`mail-${n}`));
  const item = f.add(mail('mail-with-chase')); item.chaseMailIds = ['mail-chase-test'];
  const called = [];
  const request = async (_kind, { id }) => { called.push(id); throw Error('network'); };
  await checkLedger(f.ledger, { ...f.ctx, request }); assert.equal(called.length, POLICY.checkLimit);
  const first = new Set(called); called.length = 0;
  await checkLedger(f.ledger, { ...f.ctx, request, now: NOW + 1 });
  assert.equal(called.length, POLICY.checkLimit); assert.ok(called.some(id => !first.has(id)));
  assert.ok(new Set([...first, ...called]).has('mail-chase-test'));
});
test('decision receipt and batched are not answers; human answer plus actual reply is required', async t => {
  const f = fixture(t), m = mail('mail-decision', { from: 'nishi-PC', to: 'kim-PC', why: '[判断依頼]', status: 'done' });
  const item = f.add(m, 'inbound'); f.put(m);
  const decisionFile = path.join(f.dir, 'pending-decisions.jsonl');
  const decision = status => fs.writeFileSync(decisionFile, JSON.stringify({ id: 'decision-1', status }) + '\n');
  const ack = { action: 'decision-ack', id: m.id, decisionId: 'decision-1' };
  f.sent([ack]); decision('batched'); await checkLedger(f.ledger, f.ctx); assert.equal(item.status, 'open');
  decision('answered'); await checkLedger(f.ledger, f.ctx); assert.equal(item.status, 'open');
  f.sent([ack, { action: 'reply', id: m.id, at: iso(NOW) }]);
  await checkLedger(f.ledger, f.ctx); assert.equal(item.status, 'done');
});
test('L0 resends at most once per policy interval, preserves exact exec markers, persists grouping', async t => {
  const f = fixture(t), body = '<!-- fleet-exec: claude -->\n<!-- fleet-exec-cwd: /repo -->\n<!-- fleet-resume: session-1 -->\n元本文';
  const item = f.add(mail('mail-exec', { body, messageKind: 'prompt' }));
  await chase(f.ledger, f.ctx); await chase(f.ledger, { ...f.ctx, now: NOW + POLICY.resend - 1 });
  assert.equal(f.requests.length, 1); const payload = f.requests[0].payload;
  assert.match(payload.body, new RegExp(item.mailId)); assert.equal(payload.messageKind, 'prompt');
  assert.ok(payload.body.endsWith('元本文')); assert.equal(parseExecMarkers(payload.body).exec, 'claude');
  assert.equal(parseExecMarkers(payload.body).resumeSessionId, 'session-1');
  assert.equal(Date.parse(payload.expiresAt) - NOW, POLICY.resend);
  await checkLedger(f.ledger, f.ctx);
  const sendsBefore = f.requests.filter(r => r.kind === 'mail-send').length;
  await chase(f.ledger, { ...f.ctx, now: NOW + POLICY.resend }); assert.equal(f.requests.filter(r => r.kind === 'mail-send').length, sendsBefore + 1);
  ingest(f.ledger, f.ctx); assert.equal(Object.values(f.ledger.items).filter(i => i.kind === 'outbound').length, 1);
});
test('L0 waits for 80% of TTL; dry-run never sends or persists even on invalid length', async t => {
  const f = fixture(t), item = f.add(mail('mail-fresh', { createdAt: iso(NOW), expiresAt: iso(NOW + POLICY.resend) }));
  await chase(f.ledger, f.ctx); assert.equal(f.requests.length, 0);
  await chase(f.ledger, { ...f.ctx, now: NOW + POLICY.resend * 0.8 }); assert.equal(f.requests.length, 1);
  item.sourceMail.body = 'x'.repeat(20000); assert.throws(() => resendBody(item, 2), /20000/);
  await chase(f.ledger, { ...f.ctx, now: NOW + POLICY.resend * 2, dryRun: true, persist: () => assert.fail('dry-run write') });
  assert.equal(f.requests.length, 1);
});
test('ambiguous send retry reuses durable ID and payload after reload', async t => {
  const f = fixture(t); f.add(); const payloads = [];
  const request = async (_kind, p) => { payloads.push(p); if (payloads.length === 1) throw Error('response lost'); return { ok: true }; };
  await chase(f.ledger, { ...f.ctx, request });
  const loaded = loadLedger(f.home); ingest(loaded, f.ctx);
  await checkLedger(loaded, f.ctx);
  await chase(loaded, { ...f.ctx, request, now: NOW + HOUR, persist: () => {} });
  assert.deepEqual(payloads[0], payloads[1]); assert.equal(Object.keys(loaded.items).length, 1);
});
test('L1 no resend when poll stops, owner DM rate-limited, unknown owner/poll and kim are digest-only', async t => {
  const f = fixture(t), item = f.add();
  const ctx = { ...f.ctx, freshness: async () => ({ stale: true, text: '最終 poll 2日前' }) };
  await chase(f.ledger, ctx); await chase(f.ledger, { ...ctx, now: NOW + POLICY.ownerDm - 1 });
  assert.equal(item.level, 1); assert.equal(f.requests.length, 0); assert.equal(f.dms.length, 1);
  await chase(f.ledger, { ...ctx, now: NOW + POLICY.ownerDm }); assert.equal(f.dms.length, 2);
  f.add(mail('mail-unknown', { to: 'unknown-PC' }));
  f.add(mail('mail-kim-owner', { to: 'kimko-PC' })); ctx.pcMap['kimko-PC'] = { person: '金' };
  const plans = await chase(f.ledger, ctx); assert.ok(plans.some(p => /宛先停止/.test(p.action)));
  assert.equal(f.dms.length, 2);
});
test('L2 after seen+24h, L3 after seen+48h keeps 72h reminders', async t => {
  const f = fixture(t), item = f.add(); item.seenAt = iso(NOW - POLICY.reminder);
  await chase(f.ledger, f.ctx); assert.equal(item.level, 2); assert.equal(f.requests.length, 1);
  assert.match(f.requests[0].payload.body, /状況を返信/); assert.match(f.requests[0].payload.why, /催促/);
  await checkLedger(f.ledger, { ...f.ctx, request: async (_kind, {id}) => ({ok: true, mail: {id, status: 'seen', seenAt: item.seenAt}}) });
  const escalated = NOW + POLICY.escalate - POLICY.reminder;
  await chase(f.ledger, { ...f.ctx, now: escalated }); assert.equal(item.level, 3); assert.equal(item.status, 'open');
  assert.equal(f.requests.length, 1);
  await chase(f.ledger, { ...f.ctx, now: NOW + POLICY.finalReminder }); assert.equal(f.requests.length, 2);
});
test('digest only after 09 JST, once per day only after DM, summary capped at 8', async t => {
  const f = fixture(t);
  for (let n = 0; n < 55; n++) f.add(mail(`mail-digest-${n}`));
  await digest(f.ledger, { ...f.ctx, now: Date.parse('2026-10-17T23:59:00Z') }); assert.equal(f.notifications.length, 0);
  await digest(f.ledger, { ...f.ctx, notify: async () => ({ delivered: 'webhook' }) }); assert.equal(f.ledger.digestDay, undefined);
  await digest(f.ledger, f.ctx); await digest(f.ledger, f.ctx); assert.equal(f.notifications.length, 1);
  assert.match(f.notifications[0], /ほか 47 件/); assert.equal((f.notifications[0].match(/\(outbound-mail-digest-/g) || []).length, 8);
  await digest(f.ledger, { ...f.ctx, now: NOW + DAY }); assert.equal(f.notifications.length, 2);
});
test('cancel/defer/revive validate explicit reason and dates; deferred work stays visible without sending', async t => {
  const f = fixture(t), item = f.add();
  assert.throws(() => control(f.ledger, 'cancel', item.id, { now: NOW }), /reason/);
  assert.throws(() => control(f.ledger, 'defer', item.id, { reason: '待ち', until: 'invalid', now: NOW }), /until/);
  control(f.ledger, 'defer', item.id, { reason: '確認待ち', until: '+3d', now: NOW });
  assert.equal(item.deferredUntil, iso(NOW + 3 * DAY)); await chase(f.ledger, f.ctx); assert.equal(f.requests.length, 0);
  control(f.ledger, 'cancel', item.id, { reason: 'kimが取消', now: NOW }); assert.equal(item.status, 'cancelled');
  assert.equal(item.attempts.at(-1).action, 'cancel'); assert.throws(() => control(f.ledger, 'revive', item.id, { now: NOW }));
  assert.throws(() => parseArgs(['--cancel', item.id, '--work']));
});
test('work opt-in, 2 items, 6h retry, 5 attempts, excludes decisions and deferred; no network/LLM in dry-run', async t => {
  const f = fixture(t);
  for (let n = 0; n < POLICY.workLimit + 1; n++) f.add(mail(`mail-work-${n}`, { to: 'kim-PC', from: 'nishi-PC' }), 'inbound');
  let calls = 0;
  const ctx = { ...f.ctx, resolveExe: async () => ({ executable: '/claude' }), run: async opts => {
    calls++; assert.equal(opts.readOnly, false); assert.equal(opts.timeoutSeconds, POLICY.workSeconds);
    assert.match(opts.body, /実測の証拠/); return { exitCode: 0, stdoutTail: 'CHASE_RESULT: blocked' };
  } };
  assert.equal((await work(f.ledger, ctx)).skipped, 'no-optin'); assert.equal(calls, 0);
  saveJson(path.join(f.dir, 'fleet-agent-optin.json'), { accept: ['prompt'] });
  const decision = f.add(mail('mail-work-decision', { to: 'kim-PC', why: '[判断依頼]' }), 'inbound');
  const deferred = f.add(mail('mail-work-deferred', { to: 'kim-PC' }), 'inbound'); deferred.deferredUntil = iso(NOW + POLICY.stale);
  await work(f.ledger, { ...ctx, dryRun: true }); assert.equal(calls, 0);
  await work(f.ledger, ctx); assert.equal(calls, POLICY.workLimit);
  await work(f.ledger, ctx); assert.equal(calls, POLICY.workLimit + 1);
  const before = calls; await work(f.ledger, { ...ctx, now: NOW + POLICY.workRetry - 1 }); assert.equal(calls, before);
  for (let n = 1; n <= POLICY.workAttempts + 1; n++) {
    await work(f.ledger, { ...ctx, now: NOW + n * POLICY.workRetry });
    await work(f.ledger, { ...ctx, now: NOW + n * POLICY.workRetry });
  }
  assert.equal(calls, (POLICY.workLimit + 1) * POLICY.workAttempts);
  assert.equal(decision.attempts.length, 0); assert.equal(deferred.attempts.length, 0);
  assert.match(digestText(f.ledger, f.ctx), /自動消化5回失敗/);
});
test('work done requires final marker, successful execution and actual inbox evidence; timeout cannot close next check', async t => {
  const f = fixture(t); saveJson(path.join(f.dir, 'fleet-agent-optin.json'), { accept: ['prompt'] });
  const a = f.add(mail('mail-work-a', { to: 'kim-PC' }), 'inbound');
  const b = f.add(mail('mail-work-b', { to: 'kim-PC' }), 'inbound');
  const ctx = { ...f.ctx, resolveExe: async () => 'claude', run: async opts => {
    const item = opts.body.includes(a.mailId) ? a : b;
    f.put({ ...item.sourceMail, status: 'done', resultBody: 'commit abc', resultAt: iso(NOW) });
    return { exitCode: item === a ? 0 : null, timedOut: item === b, stdoutTail: 'CHASE_RESULT: done' };
  } };
  await work(f.ledger, ctx); assert.equal(a.status, 'done'); assert.equal(b.status, 'open');
  await checkLedger(f.ledger, f.ctx); assert.equal(b.status, 'open');
});
test('full dry-run leaves HOME byte-identical, no lock, send, DM, notify or worker; non-kim no-op', async t => {
  const f = fixture(t); f.sent([mail()]);
  const snapshot = () => fs.readdirSync(f.dir, { recursive: true }).filter(p => fs.statSync(path.join(f.dir, p)).isFile())
    .map(p => [p, fs.readFileSync(path.join(f.dir, p), 'utf8')]);
  const before = snapshot();
  const result = await runChase({ '--dry-run': true, '--status': true }, { ...f.ctx, now: () => NOW,
    sendDm: () => assert.fail('DM'), notify: () => assert.fail('notify'), run: () => assert.fail('worker') });
  assert.equal(result.counts.outbound, 1); assert.equal(result.plans[0].action, 'resend');
  assert.deepEqual(snapshot(), before); assert.ok(f.requests.every(r => r.kind === 'mail-get'));
  fs.writeFileSync(path.join(f.dir, 'cost-reporter.env'), 'REPORTER_LABEL=other-PC\n');
  assert.equal((await runChase({}, { ...f.ctx, now: () => NOW })).skipped, 'not-controller');
});
test('ledger lock suppresses concurrent runs and malformed ledger is not replaced', async t => {
  const f = fixture(t); const release = acquireLock(path.join(f.dir, 'fleet-chase/.lock'));
  try { assert.equal((await runChase({}, { ...f.ctx, now: () => NOW })).skipped, 'locked'); } finally { release(); }
  fs.writeFileSync(ledgerPath(f.home), '{bad');
  await assert.rejects(runChase({}, { ...f.ctx, now: () => NOW })); assert.equal(fs.readFileSync(ledgerPath(f.home), 'utf8'), '{bad');
});
test('registrar is kim-only, validates scheduled task without real registration', t => {
  const f = fixture(t), calls = [];
  const spawnImpl = (_exe, args) => { calls.push(args); return { status: 0, stdout: args.includes('-Command') ? 'ok' : '' }; };
  register({ home: f.home, platform: 'win32', spawnImpl, stdout: () => {} });
  assert.equal(calls.length, 2); assert.ok(calls[0].some(a => a.endsWith('register-fleet-chase.ps1')));
  assert.ok(calls[1].some(a => a.includes(TASK_NAME)));
  fs.writeFileSync(path.join(f.dir, 'cost-reporter.env'), 'REPORTER_LABEL=other-PC\n');
  register({ home: f.home, platform: 'win32', spawnImpl }); assert.equal(calls.length, 2);
});

test('unverified originals or failed checks cannot trigger a blind resend after bulk import', async t => {
  const f = fixture(t); f.sent([mail()]); ingest(f.ledger, f.ctx);
  let plans = await chase(f.ledger, f.ctx);
  assert.equal(plans[0].action, '状態確認待ち'); assert.equal(f.requests.length, 0);
  await checkLedger(f.ledger, { ...f.ctx, request: async () => { throw Error('offline'); } });
  plans = await chase(f.ledger, f.ctx); assert.equal(plans[0].action, '状態確認待ち'); assert.equal(f.requests.length, 0);
});
test('recovering blocker closes derived debt on fresh authoritative evidence', async t => {
  const f = fixture(t), item = f.add();
  const request = body => async (_kind, { id }) => ({ ok: true, mail: { id, status: 'done', resultBody: body, resultAt: iso(NOW) } });
  await checkLedger(f.ledger, { ...f.ctx, request: request('BLOCKED') });
  assert.equal(item.status, 'blocked');
  await checkLedger(f.ledger, { ...f.ctx, request: request('commit abc123') });
  assert.equal(item.status, 'done');
  assert.ok(Object.values(f.ledger.items).filter(i => i.derivedFrom === item.id).every(i => i.status === 'done'));
});
test('headless cannot cancel debts and cannot bypass kim-only guard', async t => {
  const f = fixture(t), item = f.add(); f.ctx.persist();
  await assert.rejects(runChase({ '--cancel': item.id, '--reason': '勝手に取消' }, { ...f.ctx, now: () => NOW, env: { CLAUDE_HEADLESS: '1' } }), /ヘッドレス/);
  assert.equal(loadLedger(f.home).items[item.id].status, 'open');
});
test('long digest stays within Discord budget and retains counts/control footer', async t => {
  const { DIGEST_LIMIT } = await import('./lib/fleet-chase-actions.mjs');
  const f = fixture(t);
  for (let n = 0; n < 55; n++) f.add(mail(`mail-${String(n).padStart(3, '0')}${'x'.repeat(170)}`, { to: '宛先'.repeat(64), why: '件名'.repeat(500) }));
  const text = digestText(f.ledger, f.ctx);
  assert.ok(text.length <= DIGEST_LIMIT); assert.match(text, /--cancel/); assert.match(text, /ほか \d+ 件/);
});

test('resend tracking header cannot hide a body-only human decision tag from recipient', async t => {
  const { hasDecisionRequest, mailCategory } = await import('./fleet-mail.mjs');
  const f = fixture(t); f.add(mail('mail-body-decision', { why: '選択をお願いします', body: '[判断依頼] AかBか', messageKind: 'prompt' }));
  await chase(f.ledger, f.ctx);
  assert.equal(f.requests.length, 1);
  assert.equal(hasDecisionRequest(f.requests[0].payload), true);
  assert.equal(mailCategory(f.requests[0].payload), CATEGORY.decision);
});

// Include rollout integration in the established task-A test entrypoint.
import './fleet-chase-rollout.test.mjs';
