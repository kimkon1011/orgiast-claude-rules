import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { withTema } from './test-fixtures/tema-record.mjs';
import { checkTema, parseTemaRecord } from './lib/tema-check.mjs';
import { assertNoHandback, stripHumanOnly } from './lib/handback-guard.mjs';
import { saveTemaRecord, findTemaRecord } from './lib/tema-record-store.mjs';
import { prepareTemaSend } from './lib/unattended-tema.mjs';
import { CHANNEL_ITEM_SUPPORT, checkSendConsistency } from './lib/send-consistency.mjs';
import { registerCard, listActiveCards, CARD_NOTICE } from './lib/approval-cards.mjs';
import { evaluateHandoffAction } from './handoff-action-gate.mjs';
import { assertSendConsistency, afterSendCleanup } from './send-consistency-check.mjs';
import { buildRawMessage, createDraft, sendDraft, assertGmailBodySendable } from './gmail-draft.mjs';

function temp(t) { const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tema-fix3-review-')); t.after(() => fs.rmSync(home, { recursive: true, force: true })); return home; }
function report(t, id, title, expected, actual) { t.diagnostic('CASE_RESULT ' + JSON.stringify({ id, title, expected, actual, pass: JSON.stringify(expected) === JSON.stringify(actual) })); assert.deepEqual(actual, expected); }
const response = data => new Response(JSON.stringify(data), { status: 200 });
const to = 'review@example.com', subject = '署名依頼', now = '2026-11-27T15:00:00Z';
const base = { channel: 'gmail', to, subject, text: '資料を送付します。', now, draftReadAt: now };

test('D1 決まり文句だけは依頼にしない', () => {
  for (const closing of ['よろしくお願いいたします。', 'よろしくお願い致します。', 'お願い申し上げます。', '引き続きよろしくお願い', '今後ともよろしく', '何卒よろしく', '引き続き、どうぞよろしくお願い申し上げます。']) {
    const r = checkTema(`お世話になっております。資料を送付します。${closing}`);
    assert.equal(r.ok, true); assert.equal(r.applies, false, closing);
  }
});
test('D2 実作業依頼と認証の委任を区別する', () => {
  for (const request of ['ご署名のうえご返送ください。', 'ご確認をお願いします。', 'ご記入ください。', 'ご対応ください。']) {
    assert.equal(checkTema(request + 'よろしくお願いいたします。').findings[0]?.code, 'TEMA_NO_RECORD', request);
  }
  assert.equal(checkTema('認証を完了しました。よろしくお願いいたします。').applies, false);
  assert.ok(checkTema(withTema('認証コードを入力してください。')).findings.some(f => f.code === 'SIGNIN_NO_SOURCE'));
});
test('B 記録は正規化本文に対応し、別本文や不合格記録には流用しない', t => {
  const home = temp(t), record = parseTemaRecord(withTema(''));
  saveTemaRecord('本文\r\n\r\n\r\n次行 ', record, { home, channel: 'gmail' });
  assert.deepEqual(findTemaRecord(' 本文\n\n次行', { home }), record);
  assert.equal(findTemaRecord('別の本文', { home }), null);
  const body = withTema('ご署名ください。').replace('手順数: 1', '手順数:');
  assert.throws(() => assertNoHandback(body, { home, env: {} }));
  assert.equal(findTemaRecord(stripHumanOnly(body), { home }), null);
});
test('D3 記録付き下書き→Gmail本文の記録除去→保存記録でsendDraft合格', async t => {
  const home = temp(t), body = withTema('ご署名のうえご返送ください。よろしくお願いいたします。');
  let savedBody, posts = 0;
  await createDraft({ home, raw: buildRawMessage({ from: 'seisaku-team@orgiast.jp', to, subject, body }), getToken: async () => 'mock', fetchImpl: async (_url, options) => {
    const raw = Buffer.from(JSON.parse(options.body).message.raw, 'base64url').toString('utf8');
    savedBody = Buffer.from(raw.split(/\r?\n\r?\n/)[1], 'base64').toString('utf8');
    assert.doesNotMatch(savedBody, /TEMA-CHECK|HUMAN-ONLY/);
    return response({ id: 'draft-record', message: { id: 'draft-message' } });
  } });
  assert.ok(findTemaRecord(savedBody, { home }));
  const draft = { message: { threadId: 'thread', payload: { mimeType: 'text/plain', headers: [{ name: 'To', value: to }, { name: 'Subject', value: subject }], body: { data: Buffer.from(savedBody).toString('base64url') } } } };
  const result = await sendDraft({ home, id: 'draft-record', draft, ledger: { domains: [], addresses: [] }, getToken: async () => 'mock', acquireDedupe: async () => ({ recordSuccess() {}, release() {} }), consistencyCheck: async () => ({ ok: true }), cleanup: async () => ({ ok: true }), fetchImpl: async () => { posts++; return response({ id: 'sent-message', threadId: 'thread' }); } });
  assert.equal(result.sentMessageId, 'sent-message'); assert.equal(posts, 1);
});
test('D4 記録なしの既存下書きは送信せず理由と全文を退避する', async t => {
  const home = temp(t), text = 'ご署名のうえご返送ください。'; let posts = 0; const parked = [];
  const draft = { message: { payload: { mimeType: 'text/plain', headers: [{ name: 'To', value: to }], body: { data: Buffer.from(text).toString('base64url') } } } };
  await assert.rejects(sendDraft({ home, id: 'no-record', draft, ledger: { domains: [], addresses: [] }, getToken: async () => 'mock', fetchImpl: async () => { posts++; throw Error('POST forbidden'); }, consistencyDeps: { addItemImpl: async (_home, item) => { parked.push(item); return { id: 'parked' }; } } }), /TEMA_NO_RECORD/);
  assert.equal(posts, 0); assert.equal(parked.length, 1); assert.ok(parked[0].text.includes(text));
});
test('D5 無人LLM文面の記録欠落はkim-inboxに残る', async t => {
  const home = temp(t), parked = [];
  await assert.rejects(prepareTemaSend('資料を送付しました。', { home, source: 'discord-autoreply', requireRecord: true, addItemImpl: async (_home, item, options) => { parked.push(item); assert.equal(options.localOnly, true); return { id: 'parked' }; } }), /TEMA-CHECK/);
  assert.equal(parked.length, 1); assert.match(parked[0].text, /手間チェックで止まった送信/);
});
test('B HUMAN-ONLYは保存記録から復元し、残ったタグは区別して止める', t => {
  const home = temp(t), body = withTema('[HUMAN-ONLY: 本人の署名] ご署名をお願いします。');
  assertNoHandback(body, { home, env: {} });
  assert.equal(assertGmailBodySendable(stripHumanOnly(body), { home, env: {} }).trim(), 'ご署名をお願いします。');
  assert.throws(() => assertGmailBodySendable(body, { home, env: {} }), e => e.code === 'HANDBACK_TAG_UNSTRIPPED');
  assert.throws(() => assertGmailBodySendable(withTema('資料を送付しました。'), { home, env: {} }), e => e.code === 'TEMA_TAG_UNSTRIPPED');
});
test('T8a 承認カード送信後の報告は注意文が必要', async t => {
  const home = temp(t); registerCard({ draftId: 'd8a', to, subject, at: now }, { home });
  const clean = await afterSendCleanup({ ...base, channel: 'discord', draftId: 'd8a', sentAt: now, sentMessageId: 'm8a' }, { home, stdout() {} });
  assert.equal(clean.cardNotice, CARD_NOTICE); assert.equal(listActiveCards({ home }).length, 0);
  const args = { home, now: Date.parse(now), raw: '' };
  report(t, 'T8a', 'AI送信後のカード注意有無', ['block', 'pass'], [evaluateHandoffAction({ ...args, text: `${subject}を送信しました。` }).decision, evaluateHandoffAction({ ...args, text: `${subject}を送信しました。${CARD_NOTICE}。` }).decision]);
});
test('T8b Gmail直前検索で17秒前のユーザー送信を検出する', async t => {
  const home = temp(t), queries = [];
  const fetchImpl = async (url, init) => {
    assert.equal(init.cache, 'no-store'); assert.equal(init.headers['Cache-Control'], 'no-cache');
    const u = new URL(url); if (u.pathname.endsWith('/messages')) { queries.push(u.searchParams.get('q')); return response({ messages: [{ id: 'user-sent' }] }); }
    return response({ internalDate: String(Date.parse(now) - 17000), payload: { headers: [{ name: 'To', value: to }, { name: 'Subject', value: subject }, { name: 'From', value: 'kim@orgiast.jp' }] } });
  };
  let caught; try { await assertSendConsistency(base, { home, getToken: async () => 'mock', fetchImpl, collect: async () => ({ ...base }) }); } catch (error) { caught = error; }
  const hit = caught?.findings.find(f => f.code === 'DUP_SENT_BY_USER');
  assert.ok(hit?.where.includes('kim@orgiast.jp')); assert.ok(hit.where.includes('2026-11-27T14:59:43.000Z'));
  assert.equal(queries.length, 3); assert.ok(queries.every(q => q.includes('in:sent to:') && q.includes('after:')));
  report(t, 'T8b', '17秒前のカード送信を直前検索で停止', ['DUP_SENT_BY_USER'], hit ? [hit.code] : []);
});
test('T8c カードのない通常送信や別件のカードで誤検出しない', async t => {
  const home = temp(t); const result = await assertSendConsistency(base, { home, readRecentSent: async () => [], collect: async () => ({ ...base }) });
  registerCard({ to: 'another@example.com', subject: '別件' }, { home });
  report(t, 'T8c', '表示中カードのない通常送信', ['pass', 'pass'], [result.ok ? 'pass' : 'block', evaluateHandoffAction({ home, text: `${subject}を送信しました。`, raw: '' }).decision]);
});

test('A ご確認をよろしくお願いしますは決まり文句として消さない', () => {
  for (const text of ['ご確認をよろしくお願いします。', 'ご記入の程よろしくお願いいたします。', 'ご返送をお願い申し上げます。']) {
    assert.equal(checkTema(text).findings[0]?.code, 'TEMA_NO_RECORD', text);
  }
});
test('G 複数行の送信報告も同じ件のカード注意を要求する', t => {
  const home = temp(t); registerCard({ to, subject }, { home });
  assert.equal(evaluateHandoffAction({ home, raw: '', text: `宛先: ${to}\n件名: ${subject}\n送信しました。` }).decision, 'block');
});
test('G カード保存失敗後も成功した送信の台帳記録は残る', async t => {
  const home = temp(t); fs.mkdirSync(path.join(home, '.claude')); fs.writeFileSync(path.join(home, '.claude', 'approval-cards.jsonl'), 'broken json\n');
  let result; try { result = await afterSendCleanup({ ...base, sentMessageId: 'already-sent' }, { home, stdout() {} }); } catch { /* 下の永続化を必ず照合する */ }
  const file = path.join(home, '.claude', 'sent-registry.jsonl');
  assert.ok(fs.existsSync(file), 'カード障害が送信済み台帳保存を妨げてはいけない');
  assert.match(fs.readFileSync(file, 'utf8'), /already-sent/);
  assert.equal(result?.ok, false);
});

test('J-LINE 先方新着reader未提供なら警告を出して送信できログも残る', async t => {
  const home = temp(t), warnings = [];
  const input = { ...base, channel: 'line' };
  const result = await assertSendConsistency(input, { home, fetchHistory: null, taskCsv: '', followupRows: async () => [], calendarEvents: async () => [], directives: [], pcMap: {}, fleetSnapshot: { labels: [], checkedAt: now, sentHistory: [], scheduledSends: [], otherDrafts: [] }, warn: text => warnings.push(text) });
  assert.equal(result.ok, true); assert.ok(warnings.some(s => s === '未確認: threadMessages（lineは読み取り未対応）'));
  const rows = fs.readFileSync(path.join(home, '.claude', 'send-consistency', 'unsupported.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(rows.some(r => r.code === 'UNSUPPORTED_threadMessages' && r.severity === 'warning'));
  report(t, 'J-LINE', 'LINE先方新着が未対応の経路は警告＋永続ログ', ['warn', 'pass'], [rows.some(r => r.code === 'UNSUPPORTED_threadMessages') ? 'warn' : 'missing', result.ok ? 'pass' : 'block']);
});
test('J-GMAIL 送信済み検索401は警告に落とさず停止', async t => {
  const home = temp(t); let error;
  try { await assertSendConsistency(base, { home, getToken: async () => 'mock', fetchImpl: async () => new Response('{}', { status: 401 }), taskCsv: '', followupRows: async () => [], calendarEvents: async () => [], directives: [], pcMap: {}, fleetSnapshot: { labels: [], checkedAt: now, sentHistory: [], scheduledSends: [], otherDrafts: [] } }); } catch (caught) { error = caught; }
  assert.ok(error?.findings.some(f => f.code === 'UNVERIFIED_sentHistory'));
  assert.ok(error.findings.some(f => f.code === 'UNVERIFIED_recentSent'));
  report(t, 'J-GMAIL', 'Gmail送信済み検索401', ['UNVERIFIED_sentHistory', 'UNVERIFIED_recentSent'], error.findings.filter(f => ['UNVERIFIED_sentHistory', 'UNVERIFIED_recentSent'].includes(f.code)).map(f => f.code));
});
test('J 実装済みLINE readerの認証失敗は停止し、項目1・8の警告化は禁止', async t => {
  const home = temp(t);
  await assert.rejects(assertSendConsistency({ ...base, channel: 'line' }, { home, fetchHistory: async () => { throw Error('401'); }, taskCsv: '', followupRows: async () => [], calendarEvents: async () => [], directives: [], pcMap: {}, fleetSnapshot: { labels: [], checkedAt: now, sentHistory: [], scheduledSends: [], otherDrafts: [] }, warn() {} }), /UNVERIFIED_threadMessages/);
  for (const channel of ['gmail', 'discord', 'line', 'beeper']) for (const field of ['sentHistory', 'recentSent']) {
    assert.equal(CHANNEL_ITEM_SUPPORT[channel][field], 'required');
    for (const status of ['unverified', 'unsupported']) assert.equal(checkSendConsistency({ ...base, channel, [status]: [field] }, { allowUnverified: { [field]: '試験用理由' } }).ok, false);
  }
});
test('J チャネル対応表を固定し既存readerを勝手に未対応へ落とさない', () => {
  assert.deepEqual(Object.fromEntries(Object.entries(CHANNEL_ITEM_SUPPORT).map(([channel, row]) => [channel, [row.sentHistory, row.otherDrafts, row.calendarEvents, row.threadMessages, row.recentSent]])), {
    gmail: ['required', 'required', 'required', 'required', 'required'],
    discord: ['required', 'unsupported', 'required', 'required', 'required'],
    line: ['required', 'unsupported', 'required', 'optional', 'required'],
    beeper: ['required', 'unsupported', 'required', 'optional', 'required'],
  });
});
test('J 全チャネルで収集中に追記された送信済み台帳を項目8で再照合', async t => {
  for (const channel of ['gmail', 'discord', 'line', 'beeper']) {
    const home = temp(t), input = { ...base, channel, draftId: 'parallel-send' };
    await assert.rejects(assertSendConsistency(input, { home, readRecentSent: async () => [], collect: async () => {
      fs.mkdirSync(path.join(home, '.claude')); fs.writeFileSync(path.join(home, '.claude', 'sent-registry.jsonl'), JSON.stringify({ channel, to, subject, draftId: input.draftId, at: new Date(Date.parse(now) - 1000).toISOString() }) + '\n');
      return { ...input };
    } }), /DUP_SENT_BY_USER/);
  }
});
