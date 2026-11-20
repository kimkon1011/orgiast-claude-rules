import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { jpHolidays, isBusinessDay, closedStreakAfter, lastBusinessDayOnOrBefore, addBusinessDays } from './lib/jp-business-days.mjs';
import { planItem, stageOf, buildMorningDigest, parseScheduleLines, buildRow, upsertRows, run, withMeta, parseMeta, askText, extractSourceRows, captureHook } from './schedule-autopilot.mjs';

const at = s => new Date(`${s}:00+09:00`);
const row = (over = {}) => ({ id: 'S-1', title: '課題提供企業 第4便の送信', kind: '提出', due: '2026-11-23', status: '未着手', assignee: '008', action: '122社へ送る', notes: '', ...over });

test('祝日: 2026年の振替休日・国民の休日・勤労感謝の日', () => {
  const h = jpHolidays(2026);
  assert.equal(h.get('2026-11-23'), '勤労感謝の日');
  assert.equal(h.get('2026-05-06'), '振替休日');
  assert.equal(h.get('2026-09-22'), '国民の休日');
  assert.equal(jpHolidays(2027).get('2027-03-22'), '振替休日');
  assert.equal(isBusinessDay('2026-11-23'), false);
  assert.equal(isBusinessDay('2026-12-30'), false);
  assert.equal(closedStreakAfter('2026-11-20'), 3);
  assert.equal(lastBusinessDayOnOrBefore('2026-11-23'), '2026-11-20');
  assert.equal(addBusinessDays('2026-11-24', -1), '2026-11-20');
});

test('送信の予定: 期限が連休中なら直前の営業日（金曜）の午前12時に前倒し', () => {
  const p = planItem(row());
  assert.equal(p.type, 'send');
  assert.equal(p.actionDay, '2026-11-20');
  assert.equal(p.actionAt, '2026-11-20T12:00');
  assert.equal(p.startBy, '2026-11-19');
  assert.match(p.moved, /2026-11-23（勤労感謝の日）→2026-11-20/);
  assert.equal(stageOf(p, at('2026-11-19T08:00')), 'prev');
  assert.equal(stageOf(p, at('2026-11-20T08:00')), 'day');
  assert.equal(stageOf(p, at('2026-11-20T09:30')), 'hours');
  assert.equal(stageOf(p, at('2026-11-20T19:42')), 'late');
});

test('やること: 連休明けの期限は前営業日（金曜）に準備として出る', () => {
  const p = planItem(row({ id: 'S-2', title: '答弁書の確認', kind: 'その他', due: '2026-11-24', notes: withMeta('', { time: '10:00', needsKim: '内容でよいか', recommend: 'このまま提出' }) }));
  assert.equal(p.type, 'approval');
  assert.equal(p.prevDay, '2026-11-20');
  assert.equal(p.kimBy, '2026-11-24T07:00');
  assert.equal(stageOf(p, at('2026-11-20T08:00')), 'prev');
});

test('朝の一覧: 連休前の前倒し・判断待ち（推奨と返事例）・遅れの挽回策', () => {
  const plans = [planItem(row()), planItem(row({ id: 'S-2', title: '答弁書の確認', kind: 'その他', due: '2026-11-24', notes: withMeta('', { needsKim: '内容でよいか', recommend: 'このまま提出' }) })),
    planItem(row({ id: 'S-3', title: '見積の送付', due: '2026-11-18' }))];
  const d = buildMorningDigest({ plans, now: at('2026-11-20T08:00'), sources: { items: [{ kind: 'plan', diff: -1, date: '2026-11-19', title: '学会20社へ送付', assignee: '011' }], milestones: [{ week: 'W1', goal: '承認待ちを決着' }] } });
  assert.match(d.text, /明日から3連休/);
  assert.match(d.text, /今日の午前中に送るもの[\s\S]*課題提供企業/);
  assert.match(d.text, /1\. 答弁書の確認.*推奨「このまま提出」.*「1 可」/);
  assert.match(d.text, /遅れ[\s\S]*見積の送付[\s\S]*挽回策/);
  assert.match(d.text, /3億円計画: 今日のタスク 0件／終わっていない過去分 1件/);
  assert.equal(d.counts.asks, 1);
  assert.match(askText(d.asks[0], 1), /^何の件: 答弁書の確認[\s\S]*判断してほしいこと: 内容でよいか（推奨: このまま提出）[\s\S]*返事の例: 1 可/);
});

test('【予定】行を読み取る', () => {
  const lines = parseScheduleLines('結論です\n- 【予定】2026-11-24 09:00｜第4便の送信｜種別:送信｜担当:008｜金さん判断:送ってよいか｜推奨:送る｜文面:https://docs.google.com/x\n【予定】2026/11/27|答弁書の提出|担当:kim');
  assert.equal(lines.length, 2);
  assert.deepEqual({ ...lines[0] }, { due: '2026-11-24 09:00', title: '第4便の送信', type: 'send', assignee: '008', needsKim: '送ってよいか', recommend: '送る', draftUrl: 'https://docs.google.com/x' });
  assert.equal(lines[1].due, '2026/11/27');
});

function fakeLedger(initial = []) {
  const rows = initial.map(r => ({ ...r }));
  return { rows, read: async () => rows.map(r => ({ ...r })), append: async add => { rows.push(...add.map(r => ({ ...r }))); },
    patch: async (id, changes) => { const r = rows.find(x => x.id === id); Object.assign(r, changes); return r; } };
}

test('書き出し: 同じ予定は重複させず期日だけ更新', async () => {
  const ledger = fakeLedger();
  const a = buildRow({ title: '第4便の送信', due: '2026-11-24 09:00', type: 'send' }, { today: '2026-11-20', pc: '008XPS8300' });
  assert.equal(parseMeta(a.notes).time, '09:00');
  await upsertRows([a], { ledger });
  const b = buildRow({ title: '第4便の送信', due: '2026-11-25' }, { today: '2026-11-20', pc: '008XPS8300' });
  const r = await upsertRows([b], { ledger });
  assert.equal(ledger.rows.length, 1);
  assert.equal(ledger.rows[0].due, '2026-11-25');
  assert.deepEqual(r[0].updated.includes('due'), true);
});

test('Stop hook: 【予定】行を台帳へ、失敗時は outbox に保留', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-')); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const ledger = fakeLedger();
  const raw = JSON.stringify({ session_id: 'abc', last_assistant_message: '【予定】2026-11-24 13:00｜古川さんへ電話｜担当:kim' });
  const r = await captureHook({ raw, home, deps: { ledger } });
  assert.equal(r.captured, 1); assert.equal(ledger.rows[0].title, '古川さんへ電話');
  const broken = { read: async () => { throw new Error('offline'); } };
  const q = await captureHook({ raw: JSON.stringify({ last_assistant_message: '【予定】2026-11-25｜請求書の送付' }), home, deps: { ledger: broken } });
  assert.equal(q.ok, false);
  assert.equal(fs.readdirSync(path.join(home, '.claude/deadline-watch/autopilot-outbox')).length, 1);
  await captureHook({ raw, home, deps: { ledger } });
  assert.equal(ledger.rows.length, 2); // 保留分が流れ、古川さんの行は重複しない
});

test('run: 朝は1回だけ一覧と判断依頼、tick は締切3時間前に1回だけ、回答で次工程へ', async () => {
  const ledger = fakeLedger([row({ notes: withMeta('', { needsKim: '送ってよいか', recommend: '送る', pc: '008XPS8300' }) })]);
  const delivered = [], prompts = [], state = {};
  const deps = { ledger, state, config: { ledgerSheetId: 'X', calendar: { enabled: false } }, sources: { items: [], milestones: [] }, deliver: async m => delivered.push(m),
    listItems: () => [], sendPrompt: async (to, body) => prompts.push({ to, body }) };
  await run({ slot: 'morning', now: at('2026-11-20T08:00'), deps, home: os.tmpdir() });
  await run({ slot: 'morning', now: at('2026-11-20T08:05'), deps, home: os.tmpdir() });
  assert.equal(delivered.filter(d => d.kind === 'info').length, 1);
  assert.equal(delivered.filter(d => d.kind === 'ask').length, 1);
  await run({ slot: 'tick', now: at('2026-11-20T09:15'), deps, home: os.tmpdir() });
  await run({ slot: 'tick', now: at('2026-11-20T09:30'), deps, home: os.tmpdir() });
  assert.equal(delivered.filter(d => /あと3時間/.test(d.text)).length, 1);
  deps.listItems = () => [{ id: 'ki-1', source: 'schedule-autopilot', dedupeKey: 'schedule-autopilot:ask:S-1:day', status: 'answered', answer: { text: '可' }, answeredAt: '2026-11-20T01:00:00Z' }];
  const r = await run({ slot: 'tick', now: at('2026-11-20T10:00'), deps, home: os.tmpdir() });
  assert.deepEqual(r.answers, ['S-1']);
  assert.equal(ledger.rows[0].status, '対応中');
  assert.equal(prompts[0].to, '008XPS8300');
  assert.match(prompts[0].body, /^\[作業依頼\][\s\S]*「可」/);
  await run({ slot: 'tick', now: at('2026-11-20T10:15'), deps, home: os.tmpdir() });
  assert.equal(prompts.length, 1);
});

test('休日の朝は急ぎが無ければ一覧を送らない', async () => {
  const delivered = [];
  const deps = { ledger: fakeLedger([row({ id: 'S-9', title: '社内メモ整理', kind: 'その他', due: '2026-12-10' })]), state: {}, config: { calendar: { enabled: false } }, sources: { items: [], milestones: [] }, deliver: async m => delivered.push(m), listItems: () => [], sendPrompt: async () => {} };
  await run({ slot: 'morning', now: at('2026-11-21T08:00'), deps, home: os.tmpdir() });
  assert.equal(delivered.length, 0);
});

test('集約元: 見出し名で列を探し、完了・期間外を除く', () => {
  const values = [['日付', 'タスク（何を・どこまで）', '担当', '状態'], ['2026-11-19', '学会20社へ送付', '011', '実行中'], ['2026-11-19', '完了したもの', 'グロボ', '完了'], ['2026-10-01', '古い', 'x', '']];
  const items = extractSourceRows(values, { name: '3億円', kind: 'plan', date: ['日付'], title: ['タスク（何を・どこまで）'], assignee: ['担当'], status: ['状態'], closedWords: ['完了'], window: [-14, 0] }, '2026-11-20');
  assert.deepEqual(items.map(i => i.title), ['学会20社へ送付']);
  assert.equal(items[0].diff, -1);
});

test('集約元: 見出しが空の列は列番号で拾い、案件は3日以内の納品を朝の一覧に出す', () => {
  const inquiry = extractSourceRows([['注意'], ['問合せ元', '日付'], ['HP', '2026-11-19', '山田']], { name: '問い合わせ一覧', kind: 'inquiry', date: ['日付'], title: [2, '問合せ元'], window: [-3, 0] }, '2026-11-20');
  assert.equal(inquiry[0].title, '山田');
  const project = extractSourceRows([['予算項目', '案件名', '納品日', '営業'], ['確定', '上場の鐘', '2026-11-24', '金'], ['納品完了', '済み案件', '2026-11-24', '金']],
    { name: '案件一覧マスター', kind: 'project', date: ['納品日'], title: ['案件名'], assignee: ['営業'], status: ['予算項目'], closedWords: ['納品完了'], window: [0, 7] }, '2026-11-20');
  assert.deepEqual(project.map(p => p.title), ['上場の鐘']);
  const { text } = buildMorningDigest({ plans: [], now: new Date('2026-11-23T23:00:00Z'), sources: { items: project.map(p => ({ ...p, diff: 0 })), milestones: [] } });
  assert.match(text, /営業・案件・問い合わせ/);
});

test('遅れていて担当PCが分かるものは、朝に1回だけその席へ自動で再依頼する', async () => {
  const prompts = [];
  const deps = { ledger: fakeLedger([row({ id: 'S-7', title: '見積の再送', kind: 'その他', due: '2026-11-19', notes: withMeta('', { pc: '011NEXT', time: '15:00' }) })]), state: {}, config: { calendar: { enabled: false } },
    sources: { items: [], milestones: [] }, deliver: async () => {}, listItems: () => [], sendPrompt: async (to, body) => prompts.push({ to, body }) };
  await run({ slot: 'morning', now: at('2026-11-20T08:00'), deps, home: os.tmpdir() });
  await run({ slot: 'morning', now: at('2026-11-20T08:05'), deps, home: os.tmpdir() });
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].to, '011NEXT');
  assert.match(prompts[0].body, /^\[作業依頼\].*S-7/);
});
