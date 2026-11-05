import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectCaseProgress, formatCaseProgress } from './case-progress-digest.mjs';
import { caseWatch, client } from './case-handoff.mjs';
import { run } from './auto-progress-digest.mjs';
import { notifyKim, deliverKim } from './notify-kim.mjs';
import { addItem, listItems, selectContext, ingestFleetMail, retryForwarding, main } from './kim-inbox.mjs';

const now = Date.parse('2026-11-04T00:00:00Z');
const name = '阡周会様イルミネーション';
const draft = 'draft-C0039-20261103';
const waiting = `11/3 打合せ予定と確定メールを作成。下書きID: ${draft}。期限: 2026/11/04 17:00。kim の「送って」待ち`;
const data = { name, state: `## 決定事項\n打合せ予定を作成\n## 未完了・次の一手\n${waiting}\n## 最終更新\n作業用008 / 2026-11-03T12:00:00Z`, log: '2026-11-03T12:00:00Z 下書き作成' };
function home(t, label = 'kim-PC', account = 'kim@orgiast.jp') {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'case-delivery-'));
  fs.mkdirSync(path.join(h, '.claude'));
  fs.writeFileSync(path.join(h, '.claude/cost-reporter.env'), `REPORTER_LABEL=${label}`);
  fs.writeFileSync(path.join(h, '.claude/fleet-pc-map.json'), JSON.stringify({ [label]: { account } }));
  t.after(() => fs.rmSync(h, { recursive: true, force: true })); return h;
}
test('C0039 11/3: unchanged draft still produces a separate named ask on every collection', () => {
  const first = formatCaseProgress('C0039', data, undefined, now);
  const again = formatCaseProgress('C0039', data, first.checkpoint, now);
  assert.deepEqual(again.entries.map(x => x.kind), ['info', 'ask']);
  for (const entry of again.entries) assert.ok(entry.text.startsWith(`C0039 ${name}`));
  assert.match(again.entries[0].text, /変化なし/);
  for (const value of [draft, '2026/11/04 17:00', '「送って」待ち']) assert.ok(again.entries[1].text.includes(value));
});
test('all requested waiting phrases survive unchanged fingerprints; completed tasks do not become asks', () => {
  for (const phrase of ['「送って」待ち', 'kim の承認後', 'kim 承認待ち', '送信可否未承認', '保留', 'kim の判断待ち', 'kim に確認']) {
    const input = { ...data, state: `## 未完了・次の一手\n- ${phrase}\n- [x] kim 承認待ち: 済み` };
    const first = formatCaseProgress('C0039', input, undefined, now);
    const again = formatCaseProgress('C0039', input, first.checkpoint, now);
    assert.ok(again.entries.find(x => x.kind === 'ask').text.includes(phrase));
    assert.ok(!again.entries.some(x => x.text.includes('済み')));
  }
});
test('catalog reconciliation discovers new cases and fresh STATE on a receiving seat without registration', async t => {
  const h = home(t, '作業用008', 'seisaku-team@orgiast.jp');
  caseWatch(h, { now });
  let state = {}, version = data, queried = 0;
  const sent = [];
  const io = { label: '作業用008', localOwner: 'seisaku-team@orgiast.jp', readLedger: () => [], readState: () => state, writeState: (_, next) => { state = next; },
    fetchCaseCatalog: async () => [{ id: 'C0039', name }], fetchCaseResume: async id => { assert.equal(id, 'C0039'); queried++; return version; },
    notifyOwner: async (owner, text, opts) => { assert.equal(owner, 'kim@orgiast.jp'); assert.equal(opts.plainJa, false); sent.push({ text, kind: opts.kind }); return { delivered: 'session-inbox' }; } };
  assert.equal((await run({ home: h, now, io })).sent, true);
  assert.ok(caseWatch(h).cases.C0039);
  version = { ...data, state: data.state.replace(draft, 'draft-updated') };
  assert.equal((await run({ home: h, now: now + 9 * 3600000, io })).sent, true);
  assert.equal(queried, 2); assert.ok(sent.some(x => x.kind === 'ask' && x.text.includes('draft-updated')));
});
test('catalog preview is read-only and catalog outage still checks watched cases', async t => {
  const h = home(t);
  await collectCaseProgress({ home: h, now, dryRun: true, fetchCatalog: async () => [{ id: 'C0039', name }], fetchResume: async () => data });
  assert.equal(fs.existsSync(path.join(h, '.claude/state/case-watch.json')), false);
  caseWatch(h, { add: ['C0039'], now });
  const out = await collectCaseProgress({ home: h, now, fetchCatalog: async () => { throw Error('offline'); }, fetchResume: async () => data });
  assert.match(out.text, /カタログ: 照会失敗/); assert.ok(out.entries.some(x => x.kind === 'ask'));
});
test('catalog refresh can avoid cache writes and receiving bind registers watch after migration', async t => {
  const h = home(t, '作業用008', 'seisaku-team@orgiast.jp');
  caseWatch(h, { now });
  const c = client({ home: h, pc: 'DESKTOP-BDOAK99', account: 'seisaku-team@orgiast.jp', fetchImpl: async () => ({ ok: true, json: async () => ({ cases: [{ id: 'C0039', name }] }) }) });
  await c.catalog(true, { persist: false });
  assert.equal(fs.existsSync(path.join(h, '.claude/case-catalog.json')), false);
  c.bind('session-test', ['C0039']); assert.equal(caseWatch(h).cases.C0039.reason, 'bind');
});
test('case route never rewrites identifiers or calls Discord, even if allowlisted', async t => {
  const h = home(t);
  const text = `C0039 ${name}\n${waiting}`;
  const result = await notifyKim(text, { home: h, kind: 'ask', source: 'case-progress-digest', plainJaImpl: () => assert.fail('rewriting'), fetchImpl: () => assert.fail('Discord'), allowlist: [{ pattern: '.*' }] });
  assert.equal(result.delivered, 'session-inbox'); assert.equal(listItems(h)[0].text, text);
  await deliverKim(text, { home: h, kind: 'ask', source: 'case-progress-digest', plainJaImpl: () => assert.fail('rewriting') });
  assert.equal(listItems(h).length, 1);
});
test('full case text beyond 4000 chars is split without merging distinct case IDs or losing late drafts', async t => {
  const h = home(t);
  const text = `C0039 ${name}\n${'進捗。'.repeat(1500)}${waiting}\nC0040 別案件\n下書きID: draft-other 期限11/5`;
  await addItem(h, { text });
  const items = listItems(h);
  assert.ok(items.length > 5); assert.ok(items.every(x => x.text.length <= 900));
  assert.ok(items.some(x => x.text.includes(draft))); assert.ok(items.some(x => x.text.startsWith('C0040 別案件')));
  const displayed = [];
  for (let n = 0; n < items.length; n++) {
    const context = selectContext(items, { sessionId: 'same' });
    displayed.push(context); assert.ok(context.length <= 1800);
  }
  assert.ok(items.every(x => x.shownCount > 0)); assert.ok(displayed.some(x => x.includes(draft)));
});
test('unseen info precedes already shown asks in both session hooks', async t => {
  const h = home(t);
  await addItem(h, { kind: 'ask', text: '既表示の質問' });
  for (const hook_event_name of ['SessionStart', 'UserPromptSubmit']) {
    await main(['--context'], { home: h, stdout: () => {}, readStdin: async () => JSON.stringify({ hook_event_name, session_id: 'same' }) });
    const info = await addItem(h, { text: `C0039 ${name}\n未提示 ${hook_event_name} ${'あ'.repeat(700)} ${draft}` });
    let context;
    await main(['--context'], { home: h, stdout: x => { context = JSON.parse(x).hookSpecificOutput.additionalContext; }, readStdin: async () => JSON.stringify({ hook_event_name, session_id: 'same' }) });
    assert.ok(context.indexOf(info.id) < context.indexOf('既表示の質問') || !context.includes('既表示の質問'));
    assert.ok(context.includes(draft));
  }
});
test('fleet-reported kim-operated seat forwards via existing hub, retries failure and imports once', async t => {
  const source = home(t, '作業用008', 'seisaku-team@orgiast.jp'), target = home(t);
  const item = await addItem(source, { text: `C0039 ${name}\n${waiting}`, kind: 'ask', execImpl: async () => { throw Error('offline'); } });
  assert.equal(item.status, 'open'); assert.equal(item.shownCount, 0);
  let body, why;
  const retried = await retryForwarding(source, { execImpl: async (_, args) => {
    assert.ok(args.includes('kim-PC')); body = fs.readFileSync(args.at(-1), 'utf8'); why = args[args.indexOf('--why') + 1];
    return { stdout: '送信済み: mail-c0039' };
  } });
  assert.equal(retried[0].status, 'forwarded');
  assert.equal((await retryForwarding(source, { execImpl: () => assert.fail('duplicate forwarding') })).length, 0);
  fs.mkdirSync(path.join(target, '.claude/fleet-inbox'));
  fs.writeFileSync(path.join(target, '.claude/fleet-inbox/mail-c0039.json'), JSON.stringify({ from: '作業用008', body, why }));
  await ingestFleetMail(target); await ingestFleetMail(target);
  assert.equal(listItems(target).length, 1); assert.equal(listItems(target)[0].kind, 'ask');
  assert.ok(selectContext(listItems(target)).includes(draft));
});
test('same slot delivery retry is idempotent, next slot re-presents an unanswered case', async t => {
  const h = home(t);
  const opts = { kind: 'ask', text: `C0039 ${name}\n${waiting}`, deliveryKey: 'morning' };
  const first = await addItem(h, opts);
  await addItem(h, opts); assert.equal(listItems(h).length, 1);
  const items = listItems(h); selectContext(items);
  fs.writeFileSync(path.join(h, '.claude/kim-inbox', `${first.id}.json`), JSON.stringify(items[0]));
  await addItem(h, { ...opts, deliveryKey: 'evening' });
  assert.equal(listItems(h).length, 1); assert.equal(listItems(h)[0].shownCount, 0);
});
test('expired event does not hide an outstanding approval', async t => {
  const h = home(t); caseWatch(h, { add: ['C0039'], now });
  const out = await collectCaseProgress({ home: h, now, fetchResume: async () => ({ ...data, state: '開催日: 2026/09/01\n' + data.state }) });
  assert.ok(out.entries.some(x => x.kind === 'ask')); assert.ok(caseWatch(h).cases.C0039);
});

test('long generic inbox reports retain all chunks, including repeated text', async t => {
  const h = home(t);
  const text = 'あ'.repeat(5000) + '末尾の下書き';
  const { items } = await addItem(h, { text });
  assert.equal(new Set(items.map(x => x.id)).size, items.length);
  assert.equal(items.map(x => x.text.replace(/\n（続き \d+\/\d+）$/, '')).join(''), text);
});
test('case approval details repeat within the same session until answered', async t => {
  const h = home(t);
  await addItem(h, { text: `C0039 ${name}\n${waiting}`, kind: 'ask' });
  const items = listItems(h);
  assert.ok(selectContext(items, { sessionId: 'same' }).includes(draft));
  assert.ok(selectContext(items, { sessionId: 'same' }).includes(draft));
});

test('concurrent retry does not forward the same inbox item twice', async t => {
  const h = home(t, '作業用008', 'seisaku-team@orgiast.jp');
  let unblock, entered;
  const waitingForSend = new Promise(resolve => { entered = resolve; });
  const completion = new Promise(resolve => { unblock = resolve; });
  const send = addItem(h, { text: `C0039 ${name}\n${waiting}`, kind: 'ask', execImpl: async () => { entered(); await completion; return { stdout: 'mail-concurrent' }; } });
  await waitingForSend;
  const retry = await retryForwarding(h, { execImpl: () => assert.fail('duplicate send') });
  assert.match(retry[0].forwardError, /転送中/);
  unblock(); assert.equal((await send).status, 'forwarded');
});

test('approval keeps draft IDs stored separately in the related files section', () => {
  const input = { ...data, state: `## 未完了・次の一手\nkim の「送って」待ち\n## 関連ファイル・ID\n下書きID: ${draft} 期限: 2026/11/04 17:00` };
  const first = formatCaseProgress('C0039', input, undefined, now);
  const result = formatCaseProgress('C0039', input, first.checkpoint, now);
  assert.ok(result.entries.every(x => x.text.includes(draft) && x.text.includes('2026/11/04 17:00')));
});
