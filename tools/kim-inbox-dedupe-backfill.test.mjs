import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addItem, answerItem, listItems } from './kim-inbox.mjs';
import { dedupeBackfill } from './kim-inbox-dedupe-backfill.mjs';
import { escalationDedupeKey, ledgerFile, readLedger, writeLedger } from './auto-progress-ledger.mjs';

function setup(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-backfill-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, '.claude'));
  fs.writeFileSync(path.join(home, '.claude/cost-reporter.env'), 'REPORTER_LABEL=kim-PC');
  return home;
}

test('dry-run preserves files, apply inherits answers and keeps the newest unanswered ask', async t => {
  const home = setup(t);
  const ask = text => addItem(home, { kind: 'ask', text });
  const historical = await ask('金額を確認　してください');
  const answer = answerItem(home, historical.id, '500円', 'answer-session');
  const duplicate = await ask('金額を確認 してください');
  const old = await ask('送り先を確認してください');
  const kept = await ask('送り先を確認してください');
  const distinct = await ask('金額は550円ですか');
  const dir = path.join(home, '.claude/kim-inbox');
  for (const [item, createdAt] of [[old, '2026-11-18T00:00:00.000Z'], [kept, '2026-11-19T00:00:00.000Z']]) {
    fs.writeFileSync(path.join(dir, item.id + '.json'), JSON.stringify({ ...item, createdAt }));
  }
  const before = listItems(home);
  const plan = dedupeBackfill({ home });
  assert.deepEqual(listItems(home), before);
  assert.equal(plan.superseded, 1);
  assert.equal(plan.answerTransfers, 1);
  assert.equal(plan.archiveMoves, 2);
  const applied = dedupeBackfill({ home, apply: true });
  assert.deepEqual(applied, { ...plan, dryRun: false });
  assert.deepEqual(new Set(listItems(home, { status: 'open' }).map(item => item.id)), new Set([kept.id, distinct.id]));
  assert.equal(listItems(home, { status: 'superseded' })[0].supersededInto, kept.id);
  const transferred = listItems(home, { status: 'answered' }).find(item => item.id === duplicate.id);
  assert.equal(transferred.answer, answer.answer);
  assert.equal(transferred.answeredAt, answer.answeredAt);
  assert.equal(transferred.answerSession, answer.answerSession);
  assert.equal(listItems(home).length, before.length);
  assert.equal(dedupeBackfill({ home, apply: true }).archiveMoves, 0);
});

test('key-only and legacy asks share one ledger row, and inherited answers reach the session once', async t => {
  const home = setup(t);
  const row = { sessionId: 'abcdef12-test', ts: '2026-11-15T00:00:00.000Z', status: 'waiting_user', nextKim: '金額の確認' };
  const legacy = await addItem(home, { kind: 'ask', text: `【要対応・kim の判断待ち 3日】金額の確認\n（セッション abcdef12 / 台帳 ts ${row.ts}）` });
  const answer = answerItem(home, legacy.id, '500円');
  const keyed = await addItem(home, { kind: 'ask', dedupeKey: escalationDedupeKey(row), text: '金額の確認' });
  writeLedger(ledgerFile(home), [row]);
  const plan = dedupeBackfill({ home });
  assert.equal(plan.answerTransfers, 1);
  assert.equal(plan.ledgerRows, 1);
  assert.equal(readLedger(ledgerFile(home))[0].status, 'waiting_user');
  dedupeBackfill({ home, apply: true });
  assert.equal(readLedger(ledgerFile(home))[0].kimAnsweredAt, answer.answeredAt);
  assert.equal(listItems(home, { status: 'answered' }).find(item => item.id === keyed.id).answer, '500円');
  const sessionInbox = path.join(home, '.claude/auto-progress-inbox', row.sessionId + '.jsonl');
  dedupeBackfill({ home, apply: true });
  assert.equal(fs.readFileSync(sessionInbox, 'utf8').trim().split('\n').length, 1);
});
