import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { checkTema, parseTemaRecord } from './lib/tema-check.mjs';
import { assertNoHandback, stripHumanOnly } from './lib/handback-guard.mjs';
import { saveTemaRecord, findTemaRecord, normalizeTemaBody } from './lib/tema-record-store.mjs';
import { withTema } from './test-fixtures/tema-record.mjs';
import { createDraft, sendDraft, runCli, buildRawMessage, assertGmailBodySendable } from './gmail-draft.mjs';
import { sendDiscordDm } from './discord-dm.mjs';
import { prepareTemaSend } from './lib/unattended-tema.mjs';
import { registerCard, listActiveCards, listCards, markCardSent, CARD_NOTICE } from './lib/approval-cards.mjs';
import { evaluateHandoffAction } from './handoff-action-gate.mjs';
import { assertSendConsistency, afterSendCleanup } from './send-consistency-check.mjs';
import { main as cardCli } from './approval-cards.mjs';
import { evaluateTemaHook } from './tema-check-gate.mjs';
import { absoluteTemaStep } from './lib/tema-rules.mjs';

const temp = t => { const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tema-regression-')); t.after(() => fs.rmSync(home, { recursive: true, force: true })); return home; };
const res = value => new Response(JSON.stringify(value), { status: 200 });
const request = 'ご署名のうえご返送ください。よろしくお願いいたします。';
const record = parseTemaRecord(withTema(''));
const makeDraft = body => ({ message: { threadId: 'thread', payload: { mimeType: 'text/plain', headers: [{ name: 'To', value: 'customer@example.com' }, { name: 'Subject', value: '署名の件' }], body: { data: Buffer.from(body).toString('base64url') } } } });
const sendOptions = (home, body) => ({ home, id: 'draft1', draft: makeDraft(body), ledger: { domains: [], addresses: [] }, getToken: async () => 'mock-token', acquireDedupe: async () => ({ recordSuccess() {}, release() {} }), consistencyCheck: async () => ({ ok: true }), cleanup: async () => ({ ok: true }) });

test('D1 決まり文句だけの通常メールは applies=false', () => {
  for (const closing of ['よろしくお願いいたします。', 'よろしくお願い致します。', 'よろしくお願いします。', 'お願い申し上げます。', '引き続きよろしくお願い', '今後ともよろしく', '何卒よろしく']) {
    const result = checkTema(`お世話になっております。資料を送付します。${closing}`);
    assert.equal(result.ok, true, closing); assert.equal(result.applies, false, closing);
  }
});
test('D2 署名・返送・記入・対応・確認は挨拶があっても TEMA_NO_RECORD', () => {
  for (const body of [request, 'ご記入ください。', 'ご対応ください。', 'ご確認をお願いします。', 'ご確認をよろしくお願いします。', 'ご確認をお願い申し上げます。']) {
    assert.equal(checkTema(body).findings[0]?.code, 'TEMA_NO_RECORD', body);
  }
});
test('認証という名詞だけではサインインの委任にしない', () => {
  assert.equal(checkTema('認証が完了しました。').applies, false);
  assert.equal(checkTema(withTema('認証結果の書類にご署名ください。')).ok, true);
  for (const body of ['ログイン用の認証をお願いします。', '認証してください。', '認証コードを入力してください。']) assert.ok(checkTema(withTema(body)).findings.some(f => f.code === 'SIGNIN_NO_SOURCE'));
});
test('本文正規化・改変時の失効・チャネルと時刻の別保存', t => {
  const home = temp(t);
  saveTemaRecord('  本文\r\n\r\n\r\n署名\r\n ', record, { home, channel: 'gmail' });
  assert.equal(findTemaRecord('本文\n\n署名', { home }).raw, record.raw);
  assert.equal(findTemaRecord('本文変更\n\n署名', { home }), null);
  assert.equal(normalizeTemaBody('本文\n \n\n署名'), '本文\n\n署名');
  const file = fs.readdirSync(path.join(home, '.claude', 'tema-records'))[0];
  assert.match(file, /^[a-f0-9]{64}\.json$/);
  const entry = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'tema-records', file)));
  assert.equal(entry.channel, 'gmail'); assert.ok(Date.parse(entry.createdAt));
});
test('不合格の記録は保存せず、同じ本文の以前の記録で上書き合格にしない', t => {
  const home = temp(t);
  assertNoHandback(withTema(request), { home });
  assert.throws(() => assertNoHandback(`${request}\n[TEMA-CHECK]\n候補: 1案\n[/TEMA-CHECK]`, { home }), /TEMA_FEW_CANDIDATES/);
  assert.equal(findTemaRecord(request, { home }).values['手順数'], '1');
});
test('D3 記録付き作成→Gmailには本文のみ→sendDraftで別保存記録を発見', async t => {
  const home = temp(t); let stored = '', sends = 0;
  await createDraft({ home, raw: buildRawMessage({ from: 'seisaku-team@orgiast.jp', to: 'customer@example.com', subject: '署名の件', body: withTema(request) }), getToken: async () => 'mock-token', fetchImpl: async (_url, options) => {
    const raw = Buffer.from(JSON.parse(options.body).message.raw, 'base64url').toString('utf8');
    stored = Buffer.from(raw.split('\r\n\r\n')[1].replace(/\s/g, ''), 'base64').toString('utf8');
    assert.doesNotMatch(stored, /TEMA-CHECK|HUMAN-ONLY/);
    return res({ id: 'draft1', message: { id: 'draft-message', threadId: 'thread' } });
  } });
  assert.ok(findTemaRecord(stored, { home }));
  assert.equal(listActiveCards({ home }).length, 1);
  const result = await sendDraft({ ...sendOptions(home, stored), fetchImpl: async () => { sends++; return res({ id: 'sent', threadId: 'thread' }); } });
  assert.equal(result.sentMessageId, 'sent'); assert.equal(sends, 1);
});
test('HUMAN-ONLY許可も別保存して署名依頼を送信時に再検証する', t => {
  const home = temp(t); const body = withTema('[HUMAN-ONLY: 本人の署名] ご署名対応をお願いします。');
  assertNoHandback(body, { home });
  assert.doesNotThrow(() => assertGmailBodySendable(stripHumanOnly(body), { home }));
});
test('D4 記録のない下書きはPOSTせず TEMA_NO_RECORD、inboxへ退避', async t => {
  const home = temp(t); const inbox = []; let posts = 0;
  await assert.rejects(sendDraft({ ...sendOptions(home, request), fetchImpl: async () => { posts++; throw Error('送信禁止'); }, consistencyDeps: { addItemImpl: async (_home, item) => { inbox.push(item); return { id: 'inbox1' }; } } }), /TEMA_NO_RECORD/);
  assert.equal(posts, 0); assert.equal(inbox.length, 1); assert.ok(inbox[0].text.includes(request));
});
test('temaRecordオプションで既存下書きを補完し、残存タグのエラーは分ける', async t => {
  const home = temp(t);
  await sendDraft({ ...sendOptions(home, request), temaRecord: record, fetchImpl: async () => res({ id: 'sent', threadId: 'thread' }) });
  assert.throws(() => assertGmailBodySendable(withTema(request), { home }), e => e.code === 'TEMA_TAG_UNSTRIPPED' && /記録は送信前に外れます/.test(e.message));
  assert.throws(() => assertGmailBodySendable(withTema('[HUMAN-ONLY: 本人の署名] ' + request), { home }), e => e.code === 'HANDBACK_TAG_UNSTRIPPED');
});
test('gmail-draft --tema-recordのJSONファイル補完とCLIカード注意表示', async t => {
  const home = temp(t); const file = path.join(home, 'record.json'); const output = []; let posts = 0;
  fs.writeFileSync(file, JSON.stringify({ record }), 'utf8');
  const code = await runCli({ argv: ['--send', 'draft1', '--tema-record', file], deps: {
    home, stdout: text => output.push(text), loadLedger: () => ({ domains: [], addresses: [] }),
    getToken: async () => 'mock-token', inspectDraft: async () => ({ ok: true, findings: [] }), skipContextCheck: true,
    consistencyCheck: async () => ({ ok: true }), cleanup: async () => ({ ok: true, cardNotice: CARD_NOTICE }),
    acquireDedupe: async () => ({ recordSuccess() {}, release() {} }),
    fetchImpl: async (url, options) => { if (options?.method === 'POST') { posts++; return res({ id: 'sent', threadId: 'thread' }); } return res(makeDraft(request)); },
  } });
  assert.equal(code, 0, output.join('\n')); assert.equal(posts, 1); assert.ok(output.some(text => text.includes(CARD_NOTICE)));
});
test('D5 無人discord-dmの停止本文と理由をkim-inboxモックへ退避', async t => {
  const home = temp(t); const inbox = []; let sends = 0;
  await assert.rejects(sendDiscordDm('担当者', request, { home, source: 'scheduled-recheck', resolve: async () => ({ id: '123', displayName: '担当者' }), addItemImpl: async (_home, item, opts) => { inbox.push(item); assert.equal(opts.localOnly, true); return { id: 'blocked' }; }, fetchImpl: async () => { sends++; throw Error('送信禁止'); } }), /TEMA_NO_RECORD/);
  assert.equal(sends, 0); assert.equal(inbox.length, 1); assert.match(inbox[0].text, /手間チェックで止まった送信/); assert.ok(inbox[0].text.includes(request));
});
test('LLM生成の報告でも記録が無ければ送らず退避する', async t => {
  const home = temp(t); const inbox = [];
  await assert.rejects(prepareTemaSend('完了しました。', { home, requireRecord: true, addItemImpl: async (_h, item) => { inbox.push(item); return { id: 'blocked' }; } }), /検証記録/);
  assert.equal(inbox.length, 1);
});
test('warn例外を監査ログに残し、既定blockは緩めない', t => {
  const home = temp(t);
  assertNoHandback(request, { home, temaMode: 'warn', channel: 'audit-test' });
  const warning = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'tema-check', 'warn.jsonl'), 'utf8'));
  assert.equal(warning.channel, 'audit-test'); assert.equal(warning.findings[0].code, 'TEMA_NO_RECORD');
  assert.throws(() => assertNoHandback(request, { home }), /TEMA_NO_RECORD/);
});
test('CLI --saveの登録をPreToolUseから利用できる', t => {
  const home = temp(t); const file = path.join(home, 'body.txt');
  fs.writeFileSync(file, withTema(request), 'utf8');
  const result = spawnSync(process.execPath, ['tools/tema-check.mjs', '--file', file, '--save', '--json'], { encoding: 'utf8', env: { ...process.env, ORGIAST_HOME: home }, windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  fs.writeFileSync(file, request);
  assert.equal(evaluateTemaHook({ home, tool_input: { command: `node tools/line-group-send.mjs --text-file "${file}"` } }).decision, 'pass');
});
test('T8a 表示中と送信直後のカード: 注意なしblock、注意ありpass', async t => {
  const home = temp(t); registerCard({ draftId: 'd1', to: 'customer@example.com', subject: '署名の件' }, { home });
  assert.equal(evaluateHandoffAction({ home, text: '署名の件を送信しました。', raw: '' }).decision, 'block');
  const cleaned = await afterSendCleanup({ channel: 'gmail', to: 'customer@example.com', subject: '署名の件', draftId: 'd1', sentMessageId: 'm1' }, { home, stdout: () => {}, getDraft: async () => ({ status: 404 }), deleteDraft: async () => { throw Error('不要'); } });
  assert.equal(cleaned.cardNotice, CARD_NOTICE); assert.equal(listActiveCards({ home }).length, 0);
  assert.equal(evaluateHandoffAction({ home, text: '署名の件を送りました。', raw: '' }).decision, 'block');
  assert.equal(evaluateHandoffAction({ home, text: `署名の件を送信しました。${CARD_NOTICE}`, raw: '' }).decision, 'pass');
});
test('T8b 17秒前にカードから送信済み、独立したno-cache検索で停止', async t => {
  const home = temp(t); const now = '2026-11-27T14:05:57.000Z'; const sentAt = '2026-11-27T14:05:40.000Z'; const calls = [];
  const input = { channel: 'gmail', to: 'customer@example.com', subject: '署名の件', text: '資料です。', now };
  const fetchImpl = async (url, options) => {
    calls.push({ url, options }); assert.equal(options.cache, 'no-store'); assert.equal(options.headers['Cache-Control'], 'no-cache');
    if (url.includes('/messages?')) { const q = new URL(url).searchParams.get('q'); assert.match(q, /in:sent to:customer@example.com after:\d+/); assert.doesNotMatch(q, /14d/); return res({ messages: [{ id: 'sent17' }] }); }
    return res({ id: 'sent17', internalDate: String(Date.parse(sentAt)), payload: { headers: [{ name: 'From', value: '金 <kim@orgiast.jp>' }, { name: 'To', value: input.to }, { name: 'Subject', value: input.subject }] } });
  };
  await assert.rejects(assertSendConsistency(input, { home, collect: async () => ({ ...input, sentHistory: [] }), getToken: async () => 'mock-token', fetchImpl }), error => {
    const finding = error.findings.find(f => f.code === 'DUP_SENT_BY_USER');
    assert.equal(finding.item, 8); assert.match(finding.where, /14:05:40.*kim@orgiast.jp/); return true;
  });
  assert.equal(calls.filter(c => c.url.includes('/messages?')).length, 3);
});
test('T8c カードなし・他案件・古い送信カードで誤ブロックしない', async t => {
  const home = temp(t);
  assert.equal(evaluateHandoffAction({ home, text: '通常メールを送信しました。', raw: '' }).decision, 'pass');
  registerCard({ draftId: 'other', to: 'other@example.com', subject: '別件' }, { home });
  assert.equal(evaluateHandoffAction({ home, text: '通常メールを送信しました。', raw: '' }).decision, 'pass');
  markCardSent('other', { home, at: '2020-01-01', by: 'user' });
  assert.equal(evaluateHandoffAction({ home, text: '別件を送信しました。', raw: '' }).decision, 'pass');
  const result = await afterSendCleanup({ channel: 'discord', to: 'x', sentMessageId: 'm2' }, { home, stdout: () => {} });
  assert.equal(result.cardNotice, undefined);
});
test('カードCLI register/list/mark-sent と宛先+件名照合', t => {
  const home = temp(t); const output = []; const deps = { home, stdout: s => output.push(JSON.parse(s)) };
  cardCli(['--register', '--draft-id', 'd1', '--to', 'customer@example.com', '--subject', '署名の件'], deps);
  cardCli(['--list'], deps); assert.equal(output[1].length, 1);
  cardCli(['--mark-sent', '--to', 'customer@example.com', '--subject', 'Re: 署名の件', '--by', 'Grobo'], deps);
  assert.equal(listActiveCards({ home }).length, 0); assert.equal(listCards({ home })[0].by, 'Grobo');
});
test('カード注意語は絶対ルールのブロック内だけをビーコンに反映', t => {
  const home = temp(t); fs.mkdirSync(path.join(home, '.claude'));
  const file = path.join(home, '.claude', 'CLAUDE.md');
  fs.writeFileSync(file, `<!-- BEGIN: 絶対ルール -->\n▶ 手間チェック\n▶ ブラウザのサインイン委任\n▶ 送信前の整合性チェック\n<!-- END: 絶対ルール -->\n${CARD_NOTICE}`);
  assert.match(absoluteTemaStep(home).reason, /card=no/);
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('<!-- END:', `${CARD_NOTICE}\n<!-- END:`));
  assert.match(absoluteTemaStep(home).reason, /card=yes/); assert.equal(absoluteTemaStep(home).status, 'ok');
});
