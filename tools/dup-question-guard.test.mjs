import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ledgerFile, readLedger, writeLedger } from './auto-progress-ledger.mjs';
import { escalationText } from './auto-progress-escalate.mjs';
import { syncEscalationAnswer, parseEscalation, priorEscalations } from './lib/escalation-answer-sync.mjs';
import { isMcpOptedOut, mcpOptoutFile } from './lib/mcp-optout.mjs';
import { addItem, answerItem, listItems, lookupAnswers } from './kim-inbox.mjs';

const now = Date.parse('2026-11-19T03:00:00Z');
function tmpHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dupq-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  return home;
}
const ledgerRow = { ts: '2026-11-09T00:29:09.857Z', sessionId: 'e58984ea-0160-445f-8610-fc8c9a71a4c8', status: 'waiting_user', nextKim: '社外の返信待ち10件に返事をする', promise: '次の毎時の確認', pc: 'PC-1' };

test('エスカレーション本文から行を特定できる', () => {
  const item = { kind: 'ask', status: 'open', text: escalationText(ledgerRow, now) };
  assert.deepEqual(parseEscalation(item), { ts: ledgerRow.ts, session: 'e58984ea' });
  assert.equal(priorEscalations([item, { ...item, status: 'answered', answer: 'x', answeredAt: '2026-11-15T11:00:00Z' }], ledgerRow).matched.length, 2);
  assert.equal(parseEscalation({ text: 'ほかの通知' }), null);
});

test('受信箱で回答したエスカレーションは台帳の行に kimAnswer として書き戻される', t => {
  const home = tmpHome(t);
  writeLedger(ledgerFile(home), [ledgerRow]);
  const item = { id: 'ki-20261119000000-aaaa', kind: 'ask', status: 'answered', answer: '6番は最新にして送る', answeredAt: '2026-11-19T03:00:00.000Z', text: escalationText(ledgerRow, now) };
  assert.equal(syncEscalationAnswer(home, item, { now }), true);
  const [row] = readLedger(ledgerFile(home));
  assert.equal(row.kimAnswer, '6番は最新にして送る');
  assert.equal(row.nextKim, 'なし');
  assert.equal(row.kimAnswerSource, 'kim-inbox:ki-20261119000000-aaaa');
  assert.equal(syncEscalationAnswer(home, item, { now }), false);
});

test('kim-inbox: エスカレーションは dedupeKey で1件にまとまり、回答すると台帳へ書き戻される', async t => {
  const home = tmpHome(t);
  writeLedger(ledgerFile(home), [ledgerRow]);
  const opts = { kind: 'ask', from: 'kim-PC', dedupeKey: 'auto-progress-escalate:k1', source: 'auto-progress-escalate', execImpl: async () => ({ stdout: '送信済み: mail-test-1\n' }) };
  const first = await addItem(home, { ...opts, text: escalationText(ledgerRow, now) }, { drain: false });
  const second = await addItem(home, { ...opts, text: escalationText(ledgerRow, now + 86400000) }, { drain: false });
  assert.equal(second.id, first.id);
  assert.equal(listItems(home).length, 1);
  answerItem(home, first.id, '外して良い');
  const [row] = readLedger(ledgerFile(home));
  assert.equal(row.kimAnswer, '外して良い');
  assert.equal(row.nextKim, 'なし');
  const third = await addItem(home, { ...opts, text: escalationText(ledgerRow, now + 2 * 86400000) }, { drain: false });
  assert.equal(third.id, first.id);
  assert.equal(third.status, 'answered');
});

test('mcp-optout.json に載った MCP は除外扱いになる', t => {
  const home = tmpHome(t);
  assert.equal(isMcpOptedOut(home, 'gemini-cli'), false);
  fs.writeFileSync(mcpOptoutFile(home), JSON.stringify({ disabled: ['gemini-cli'] }));
  assert.equal(isMcpOptedOut(home, 'gemini-cli'), true);
  assert.equal(isMcpOptedOut(home, 'other'), false);
  fs.writeFileSync(mcpOptoutFile(home), '{壊れた');
  assert.equal(isMcpOptedOut(home, 'gemini-cli'), false);
});

test('--lookup は回答済みの質問だけを語の AND で探す', async t => {
  const home = tmpHome(t);
  const opts = { kind: 'ask', from: 'kim-PC', execImpl: async () => ({ stdout: '送信済み: mail-test-2\n' }) };
  const a = await addItem(home, { ...opts, text: 'gemini MCP を全セッションの自動起動から外してよいですか' }, { drain: false });
  await addItem(home, { ...opts, text: 'gemini の課金上限を上げてよいですか' }, { drain: false });
  assert.equal(lookupAnswers(home, 'gemini').length, 0);
  answerItem(home, a.id, '外して良い');
  const hits = lookupAnswers(home, 'gemini 外して');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].answer, '外して良い');
  assert.throws(() => lookupAnswers(home, '  '));
});
