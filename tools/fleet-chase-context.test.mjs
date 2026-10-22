import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { selectContext, main, CONTEXT_LIMIT, CONTEXT_COUNTS, REPEAT_MS } from './fleet-chase-context.mjs';
import { makeItem, iso, DAY, saveJson, ledgerPath, CATEGORY } from './fleet-chase.mjs';
const NOW = Date.parse('2026-10-18T03:00:00Z');
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-chase-context-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, '.claude/fleet-inbox'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude/cost-reporter.env'), 'REPORTER_LABEL=kim-PC\n');
  const ledger = { version: 1, items: {} };
  const add = (id, days, kind = 'inbound', extra = {}) => {
    const item = makeItem({ id: `mail-${id}`, from: 'nishi-PC', to: 'kim-PC', why: '[作業依頼] 内容', body: '', createdAt: iso(NOW - days * DAY) }, kind, NOW);
    // 表示順のテストなので取込時の stale 判定（POLICY.stale）に依存させず open を明示する。
    Object.assign(item, { status: 'open' }, extra); ledger.items[item.id] = item; return item;
  };
  const outputs = [], errors = [];
  const run = (event = 'SessionStart', now = NOW, session = 'test') => main({ home, now: () => now,
    readStdin: async () => JSON.stringify({ hook_event_name: event, session_id: session }),
    stdout: output => outputs.push(JSON.parse(output)), stderr: error => errors.push(error) });
  const save = () => saveJson(ledgerPath(home), ledger);
  return { home, ledger, add, save, run, outputs, errors };
}
test('oldest inbound first; bounded category counts; outward L2 and higher; deferred visible', t => {
  const f = fixture(t);
  f.add('new', 1); f.add('old', 10); f.add('middle', 5); f.add('extra', 2);
  f.add('low', 20, 'outbound', { level: 1 });
  f.add('high', 20, 'outbound', { level: 2 });
  f.add('highest', 22, 'outbound', { level: 3 });
  f.add('ignored', 12, 'outbound', { level: 3 });
  const context = selectContext(f.ledger, { home: f.home, now: NOW });
  assert.ok(context.indexOf('id=mail-old') < context.indexOf('id=mail-middle'));
  assert.equal((context.match(/受信\(最古\)/g) || []).length, CONTEXT_COUNTS.inbound);
  assert.ok((context.match(/送信 L/g) || []).length <= CONTEXT_COUNTS.outbound);
  assert.doesNotMatch(context, /id=mail-low|id=mail-new/); assert.ok(context.length <= CONTEXT_LIMIT);
  f.ledger.items['inbound-mail-old'].deferredUntil = iso(NOW + DAY);
  assert.match(selectContext(f.ledger, { home: f.home, now: NOW }), /保留中/);
});
test('inbox already presented in same session is omitted; different session reappears', t => {
  const f = fixture(t); f.add('presented', 4); f.add('unseen', 3);
  saveJson(path.join(f.home, '.claude/fleet-inbox/mail-presented.json'), { presentedSession: 'test' });
  const context = selectContext(f.ledger, { home: f.home, now: NOW, sessionId: 'test' });
  assert.doesNotMatch(context, /id=mail-presented/); assert.match(context, /id=mail-unseen/);
  assert.match(selectContext(f.ledger, { home: f.home, now: NOW, sessionId: 'next' }), /id=mail-presented/);
});
test('same content suppressed for 30 minutes, new session and changed debt visible; local hook <500ms', async t => {
  const f = fixture(t); f.add('one', 2); f.save();
  const before = fs.readFileSync(ledgerPath(f.home), 'utf8'); const start = performance.now();
  await f.run(); assert.ok(performance.now() - start < 500);
  await f.run('UserPromptSubmit', NOW + REPEAT_MS - 1); assert.equal(f.outputs.length, 1);
  await f.run('UserPromptSubmit', NOW + REPEAT_MS); assert.equal(f.outputs.length, 2);
  await f.run('UserPromptSubmit', NOW + REPEAT_MS, 'next'); assert.equal(f.outputs.length, 3);
  assert.equal(fs.readFileSync(ledgerPath(f.home), 'utf8'), before);
  assert.equal(f.outputs[0].hookSpecificOutput.hookEventName, 'SessionStart');
  assert.ok(f.outputs[0].hookSpecificOutput.additionalContext.length <= CONTEXT_LIMIT);
});
test('non-kim is silent before stdin and missing/corrupt ledger fails open', async t => {
  const f = fixture(t); await f.run(); assert.equal(f.outputs.length, 0);
  fs.mkdirSync(path.dirname(ledgerPath(f.home)), { recursive: true }); fs.writeFileSync(ledgerPath(f.home), '{bad');
  await f.run(); assert.equal(f.errors.length, 1); assert.equal(f.outputs.length, 0);
  fs.writeFileSync(path.join(f.home, '.claude/cost-reporter.env'), 'REPORTER_LABEL=other-PC\n');
  await main({ home: f.home, readStdin: () => assert.fail('must not read stdin'), stdout: () => assert.fail('silent') });
});
test('decisions never instruct headless to answer, secrets are masked, malicious session cannot escape marker dir', async t => {
  const f = fixture(t); f.add('decision', 3, 'inbound', { category: CATEGORY.decision }); f.save();
  await f.run('SessionStart', NOW, '../../escape');
  assert.match(f.outputs[0].hookSpecificOutput.additionalContext, /ヘッドレスは代行禁止/);
  assert.ok(!fs.existsSync(path.join(f.home, '.claude/escape.json')));
  const item = makeItem({ id: 'mail-sensitive', from: 'token=private', to: 'kim-PC', why: 'api_key=secret',
    body: 'https://discord.com/api/webhooks/123/private', createdAt: iso(NOW) }, 'inbound', NOW);
  assert.doesNotMatch(JSON.stringify(item), /private|secret"|webhooks\/123/);
});
test('CLI emits bounded additionalContext, expected hooks include both kim events only, registration is read-only', t => {
  const f = fixture(t); f.add('cli', 4); f.save();
  const env = { ...process.env, ORGIAST_HOME: f.home, ORGIAST_REPO: path.resolve('.') };
  const output = JSON.parse(execFileSync(process.execPath, ['tools/fleet-chase-context.mjs'], { env, encoding: 'utf8',
    input: JSON.stringify({ hook_event_name: 'SessionStart', session_id: 't' }) }));
  assert.ok(output.hookSpecificOutput.additionalContext.length <= CONTEXT_LIMIT);
  const expected = () => JSON.parse(execFileSync(process.execPath, ['tools/register-hooks.mjs', '--expected-json'], { env, encoding: 'utf8' }));
  const hooks = expected().hooks;
  for (const event of ['SessionStart', 'UserPromptSubmit']) {
    assert.equal(hooks[event].flatMap(g => g.hooks).filter(h => h.command.includes('fleet-chase-context.mjs')).length, 1);
  }
  assert.equal(fs.existsSync(path.join(f.home, '.claude/settings.json')), false);
  fs.writeFileSync(path.join(f.home, '.claude/cost-reporter.env'), 'REPORTER_LABEL=other-PC\n');
  assert.doesNotMatch(JSON.stringify(expected()), /fleet-chase-context/);
});
