import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { caseWatch, client, atomic } from './case-handoff.mjs';
import { collectCaseProgress, expiredCase, formatCaseProgress } from './case-progress-digest.mjs';
import { renderState } from './lib/case-handoff.mjs';
import { run } from './auto-progress-digest.mjs';
const now = Date.parse('2026-11-02T01:00:00Z');
const id = '260430EIG';
const source = { account: 'seisaku-team@orgiast.jp', pc: 'cafe015-PC', timestamp: '2026-11-02T00:00:00Z', file: 'session.md' };
const data = () => ({ state: renderState({ purpose: '開催日: 2026/12/12', decisions: [{ text: '課題企業を確定' }], next: '- 会場確認\n- kim待ち: 送信OK を判断\n- kim の承認\n- 資料確認\n- 四つ目' }, source), log: `${source.timestamp} ${source.account}/${source.pc}\n企業を確定\n会場確認` });
function home(t) { const h = fs.mkdtempSync(path.join(os.tmpdir(), 'case-digest-')); t.after(() => fs.rmSync(h, { recursive: true, force: true })); return h; }

test('watch adds, removes and migrates only recent bindings once', t => {
  const h = home(t), dir = path.join(h, '.claude/case-binding');
  atomic(path.join(dir, 'recent.json'), { cases: [id] });
  atomic(path.join(dir, 'old.json'), { cases: ['C0001'] });
  fs.utimesSync(path.join(dir, 'old.json'), new Date(now - 31 * 86400000), new Date(now - 31 * 86400000));
  assert.deepEqual(Object.keys(caseWatch(h, { now }).cases), [id]);
  assert.deepEqual(caseWatch(h, { now, remove: [id] }).cases, {});
  assert.deepEqual(caseWatch(h, { now }).cases, {});
  assert.equal(caseWatch(h, { now, add: [id] }).cases[id].reason, 'watch');
  assert.throws(() => caseWatch(h, { add: ['../bad'] }), /invalid/);
});
test('bind automatically watches kim-PC but not other seats', t => {
  for (const label of ['kim-PC', 'cafe015-PC']) {
    const h = home(t), c = client({ home: h, pc: label, label, account: source.account });
    c.bind('session-1', [id]);
    assert.equal(Boolean(caseWatch(h, { now, remove: [] }).cases[id]), true); // migration is independently supported
    if (label === 'kim-PC') assert.equal(caseWatch(h).cases[id].reason, 'bind');
    else assert.equal(caseWatch(h).cases[id].reason, 'binding migration');
  }
});
test('watch expiration uses event date plus 14 days, not citation/update dates', async t => {
  const added = '2026-09-01T00:00:00Z';
  assert.equal(expiredCase('## 最終更新\n2026/09/01', added, now), false);
  assert.equal(expiredCase('開催日: 2026/10/01', added, now), true);
  assert.equal(expiredCase('開催日: 10/01 → 12/12 [s.md 2026-09-01]', added, now), false);
  assert.equal(expiredCase('開催日: 1/12', '2026-12-01', Date.parse('2027-01-20')), false);
  const h = home(t); caseWatch(h, { add: [id], now });
  const out = await collectCaseProgress({ home: h, now, fetchResume: async () => ({ state: '開催日: 2026/10/01', log: '' }) });
  assert.equal(out.text, ''); assert.deepEqual(caseWatch(h).cases, {});
});
test('changed progress includes new decisions, first three next steps, kim requests and seat in six lines', () => {
  const result = formatCaseProgress(id, data(), undefined, now);
  assert.ok(result.text.split('\n').length <= 6);
  for (const text of ['課題企業を確定', '会場確認', 'kim待ち', '送信OK', 'kim の承認', 'cafe015-PC', source.timestamp]) assert.ok(result.text.includes(text), text);
  assert.ok(!result.text.includes('四つ目')); assert.ok(!result.text.includes('停滞'));
  const changed = data(); changed.state = changed.state.replace('課題企業を確定', '開催を延期');
  const second = formatCaseProgress(id, changed, result.checkpoint, now);
  assert.match(second.text, /開催を延期/); assert.ok(!second.text.includes('課題企業を確定'));
});
test('unchanged progress is one line and stale LOG still shows stagnation', () => {
  const first = formatCaseProgress(id, data(), undefined, now);
  const same = formatCaseProgress(id, data(), first.checkpoint, now);
  assert.equal(same.text.split('\n').length, 1); assert.match(same.text, /変化なし・最終更新/);
  assert.match(formatCaseProgress(id, data(), first.checkpoint, now + 86400000).text, /停滞/);
  assert.match(formatCaseProgress(id, { ...data(), log: '' }, undefined, now).text, /停滞/);
});
test('one failed hub lookup does not stop other cases or advance its checkpoint', async t => {
  const h = home(t); caseWatch(h, { add: [id, 'C0001'], now });
  const result = await collectCaseProgress({ home: h, now, fetchResume: async key => { if (key === id) throw Error('HTTP 503'); return data(); } });
  assert.match(result.text, /260430EIG: 照会失敗（HTTP 503）/); assert.match(result.text, /C0001: 案件進捗/);
  assert.equal(result.checkpoints[id], undefined); assert.ok(result.checkpoints.C0001);
});
test('morning and evening digest sends watched cases without local ledger and commits delivery point only on success', async t => {
  const h = home(t); caseWatch(h, { add: [id], now });
  let state = {}, fail = true; const delivered = [];
  const io = { label: 'kim-PC', localOwner: 'kim@orgiast.jp', readLedger: () => [], readState: () => structuredClone(state), writeState: (_, v) => { state = v; }, fetchCaseResume: async () => data(), notifyOwner: async (owner, message) => { assert.equal(owner, 'kim@orgiast.jp'); delivered.push(message); return fail ? { reason: 'offline' } : { delivered: 'session-inbox' }; } };
  assert.equal((await run({ home: h, now, io })).sent, false); assert.equal(state.caseProgress, undefined);
  await run({ home: h, now, io, dryRun: true }); assert.equal(state.caseProgress, undefined);
  fail = false; assert.equal((await run({ home: h, now, io })).sent, true);
  assert.equal(state.caseProgress[id].lastDeliveredAt, new Date(now).toISOString());
  assert.equal((await run({ home: h, now, io })).skipped, 'already-sent');
  const evening = now + 9 * 3600000;
  assert.equal((await run({ home: h, now: evening, io })).sent, true); assert.match(delivered.at(-1), /変化なし/);
  assert.equal(state.caseProgress[id].lastDeliveredAt, new Date(evening).toISOString());
});
test('other PCs and outside slots do not query watched cases', async t => {
  const h = home(t); caseWatch(h, { add: [id], now });
  const io = { label: 'other-PC', localOwner: 'kim@orgiast.jp', readLedger: () => [], fetchCaseResume: () => assert.fail('unexpected query') };
  await run({ home: h, now, io }); await run({ home: h, now, slot: null, io: { ...io, label: 'kim-PC' } });
});
test('resume and digest share the same hub read function', async t => {
  const h = home(t), requests = [];
  const c = client({ home: h, pc: 'kim-PC', account: 'kim@orgiast.jp', fetchImpl: async url => { requests.push(url.searchParams.get('mode')); return { ok: true, json: async () => data() }; } });
  assert.deepEqual(await c.fetchResume(id), data()); assert.match(await c.resume(id), /課題企業/);
  assert.deepEqual(requests, ['resume', 'resume']);
});
test('changing citation timestamps does not repeat an already delivered decision', () => {
  const first = formatCaseProgress(id, data(), undefined, now);
  const changed = data(); changed.state = changed.state.replaceAll(source.timestamp, '2026-11-02T00:30:00Z');
  assert.match(formatCaseProgress(id, changed, first.checkpoint, now).text, /決定事項: 新しい決定なし/);
});
test('preview leaves watch migration and delivery state untouched', async t => {
  const h = home(t); atomic(path.join(h, '.claude/case-binding/session.json'), { cases: [id] });
  const result = await collectCaseProgress({ home: h, now, dryRun: true, fetchResume: async () => data() });
  assert.match(result.text, /案件進捗/); assert.equal(fs.existsSync(path.join(h, '.claude/state/case-watch.json')), false);
});
test('failed later message part retains the previous delivery point for retry', async t => {
  // 2026-11-04 仕様変更: 大量案件も1通。失敗時に配達点を進めず、同じ枠で再送できる意図を維持する。
  const h = home(t); caseWatch(h, { add: [id, ...Array.from({ length: 20 }, (_, i) => `C${String(i).padStart(4, '0')}`)], now });
  let state = {}, calls = 0;
  const io = { label: 'kim-PC', localOwner: 'kim@orgiast.jp', readLedger: () => [], readState: () => structuredClone(state), writeState: (_, value) => { state = value; }, fetchCaseResume: async () => data(), notifyOwner: async (_, text) => { assert.ok(text.length <= 1800); return ++calls === 1 ? { reason: 'offline' } : { delivered: 'dm' }; } };
  const out = await run({ home: h, now, io });
  assert.equal(calls, 1); assert.equal(out.sent, false); assert.equal(state.caseProgress, undefined);
  assert.equal((await run({ home: h, now, io })).sent, true); assert.ok(state.caseProgress[id]);
  assert.equal(calls, 2);
  assert.equal((await run({ home: h, now, io })).skipped, 'already-sent');
});

const eigCitation = '[20261030-session-user-PC-12345678-1234-1234-1234-123456789abc.md 2026-11-02T12:05:46.218Z]';
function eigState({ decisions = '', next = '', customer = '', files = '' } = {}) {
  return { state: `## 顧客の意向\n${customer}\n## 決定事項\n${decisions}\n## 未完了・次の一手\n${next}\n## 関連ファイル・ID\n${files}\n## 最終更新\n${source.account} / ${source.pc} / ${source.timestamp}`, log: data().log };
}
test('260430EIG removes citation tags and bullet or numbered prefixes from display', () => {
  const input = eigState({ decisions: `- 会場を確定 ${eigCitation}\n* [要確認] 見積を確定 ${eigCitation}`, next: `1. 会場へ連絡 ${eigCitation}\n* 資料を準備 ${eigCitation}` });
  const { text } = formatCaseProgress(id, input, undefined, now);
  assert.match(text, /決定事項: 会場を確定 ／ \[要確認\] 見積を確定/);
  assert.match(text, /未完了・次の一手: 会場へ連絡 ／ 資料を準備/);
  assert.ok(!text.includes('20261030-session'));
  assert.ok(!text.includes('2026-11-02T12:05:46.218Z'));
});
test('260430EIG splits numbered paragraphs and moves only matching items to kim waiting once', () => {
  const input = eigState({
    customer: `- 社外送信はkimの送信OK必須 ${eigCitation}`,
    files: '- kimの判断履歴: archive.md',
    next: `1. 会場確認 ${eigCitation} 2. kimの判断: 見積送信OK ${eigCitation} 3. 資料準備 4. 日程確認 5. 四つ目の通常作業 6. kimの返事を確認 7. kimによる承認 8. kim待ち: 予算確認 9. [x] kimの判断: 完了済み`,
  });
  const { text } = formatCaseProgress(id, input, undefined, now);
  const nextLine = text.split('\n').find(s => s.startsWith('未完了・次の一手:'));
  const waitingLine = text.split('\n').find(s => s.startsWith('kim の判断待ち:'));
  assert.equal(nextLine, '未完了・次の一手: 会場確認 ／ 資料準備 ／ 日程確認');
  assert.equal(waitingLine, 'kim の判断待ち: kimの判断: 見積送信OK ／ kimの返事を確認 ／ kimによる承認 ／ kim待ち: 予算確認');
  assert.equal(text.match(/見積送信OK/g)?.length, 1);
  for (const unwanted of ['社外送信', 'archive.md', '四つ目の通常作業', '完了済み']) assert.ok(!text.includes(unwanted), unwanted);
});
test('260430EIG limits each item to 80 characters and each case to 600 while retaining all sections', () => {
  const long = 'あ'.repeat(100);
  const single = formatCaseProgress(id, eigState({ decisions: `- ${long} ${eigCitation}`, next: `1. ${long}` }), undefined, now).text;
  assert.equal(single.split('\n')[1], `決定事項: ${'あ'.repeat(79)}…`);
  assert.equal(single.split('\n')[2], `未完了・次の一手: ${'あ'.repeat(79)}…`);
  const input = eigState({
    decisions: Array.from({ length: 10 }, (_, i) => `- 決定${i}${long} ${eigCitation}`).join('\n'),
    next: Array.from({ length: 8 }, (_, i) => `${i + 1}. ${i < 3 ? `作業${i}` : 'kimの判断'}${long} ${eigCitation}`).join(' '),
  });
  const { text } = formatCaseProgress(id, input, undefined, now + 86400000);
  assert.ok(text.length <= 600, text.length);
  assert.equal(text.split('\n').length, 5);
  for (const expected of ['作業0', '作業1', '作業2', '停滞', '決定事項:', '未完了・次の一手:', 'kim の判断待ち:', `最終更新: ${source.account} / ${source.pc} / ${source.timestamp}`]) assert.ok(text.includes(expected), expected);
  const first = formatCaseProgress(id, input, undefined, now);
  const unchanged = formatCaseProgress(id, input, first.checkpoint, now);
  assert.equal(unchanged.text.split('\n').length, 1);
  assert.ok(unchanged.text.length <= 600);
});

test('260430EIG splits adjacent numbered sentences and keeps the first three non-kim steps', () => {
  const next = '1. Cqree回答待ち、5社再打診（締切11/13）→kimの送信OK後に代理送信。2. 地域交流センター神宮前の空き確認（エイトBO待ち）。3. 11/5 17:00 MTGまでにチラシ初稿PDF作成。4. 声かけ学生団体一覧共有待ち（明大マーケ研11/9回答予定）。5. Peatix 12/12用に更新。';
  const { text } = formatCaseProgress(id, eigState({ next }), undefined, now);
  assert.equal(text.split('\n')[2], '未完了・次の一手: 地域交流センター神宮前の空き確認（エイトBO待ち）。 ／ 11/5 17:00 MTGまでにチラシ初稿PDF作成。 ／ 声かけ学生団体一覧共有待ち（明大マーケ研11/9回答予定）。');
  assert.equal(text.split('\n')[3], 'kim の判断待ち: Cqree回答待ち、5社再打診（締切11/13）→kimの送信OK後に代理送信。');
  assert.ok(!text.includes('Peatix'));
});
test('C0039 splits parenthesized numbering and excludes completed items', () => {
  const next = '1) kimの送信OK待ち 2) 地域交流センター確認 3) [x] 完了済み 4) チラシ初稿作成 5) 声かけ学生団体確認 6) 四つ目';
  const { text } = formatCaseProgress('C0039', eigState({ next }), undefined, now);
  assert.equal(text.split('\n')[2], '未完了・次の一手: 地域交流センター確認 ／ チラシ初稿作成 ／ 声かけ学生団体確認');
  assert.equal(text.split('\n')[3], 'kim の判断待ち: kimの送信OK待ち');
});
test('numbered markers split after whitespace and punctuation without splitting dates, times or decimals', () => {
  for (const separator of [' ', '\n', '。', '、', '；', ';']) {
    for (const markers of [['1.', '2.', '3.'], ['1)', '2)', '3)'], ['1．', '2．', '3．'], ['1）', '2）', '3）'], ['①', '②', '⑳']]) {
      const next = `${markers[0]} 締切11/13 17:00 12/12 1.5倍${separator}${markers[1]} kimの判断待ち${separator}${markers[2]} [x] 完了済み`;
      const { text } = formatCaseProgress(id, eigState({ next }), undefined, now);
      const punctuation = separator.trim();
      assert.equal(text.split('\n')[2], `未完了・次の一手: 締切11/13 17:00 12/12 1.5倍${punctuation}`, next);
      assert.equal(text.split('\n')[3], `kim の判断待ち: kimの判断待ち${punctuation}`, next);
    }
  }
  const next = '1. 作業A2. 続きA③続き、1.5倍；12/12 17:00';
  assert.equal(formatCaseProgress(id, eigState({ next }), undefined, now).text.split('\n')[2], '未完了・次の一手: 作業A2. 続きA③続き、1.5倍；12/12 17:00');
});
