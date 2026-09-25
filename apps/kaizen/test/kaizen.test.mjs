import test from 'node:test';
import assert from 'node:assert/strict';
import { createState, validateItem, addItem, decideItem, reflectItem, completeItem, summarize, toMarkdown, STATUS_LABELS } from '../kaizen-core.mjs';

const input = { occurredOn: '2026-09-26', reporter: '田中', client: 'オージャスト 展示会', event: '受付が混雑' };
const decision = { countermeasure: '受付を増設', owner: '佐藤', due: '2026-10-01' };

test('必須項目・空白・日付形式と実在日付を検証する', () => {
  for (const key of ['occurredOn', 'reporter', 'client', 'event']) {
    const missing = { ...input }; delete missing[key];
    assert.throws(() => validateItem(missing), key === 'occurredOn' ? RangeError : TypeError);
    for (const value of ['', '  ', 123, null]) assert.throws(() => validateItem({ ...input, [key]: value }));
  }
  for (const value of ['2026/09/26', '2026-9-26', '2026-02-30', '2025-02-29']) {
    assert.throws(() => validateItem({ ...input, occurredOn: value }), RangeError);
  }
  assert.throws(() => validateItem(null), TypeError);
  assert.equal(validateItem({ ...input, occurredOn: '2024-02-29' }).occurredOn, '2024-02-29');
  assert.deepEqual(validateItem({ ...input, reporter: ' 田中 ', solution: ' 提案 ' }), { ...input, solution: '提案' });
  assert.equal(validateItem(input).solution, '');
});

test('追加は不変で、既存の連番と衝突しない', () => {
  const prev = createState(); Object.freeze(prev.items); Object.freeze(prev);
  const next = addItem(prev, input);
  assert.notEqual(prev, next); assert.equal(prev.items.length, 0);
  assert.equal(next.items[0].status, 'open');
  const third = addItem(addItem(next, input), input);
  assert.equal(new Set(third.items.map(item => item.id)).size, 3);
  assert.equal(next.items.length, 1);
  const sparse = { items: [{ ...next.items[0], id: 'kz-9' }, next.items[0]] };
  assert.equal(addItem(sparse, input).items.at(-1).id, 'kz-10');
});

test('状態遷移は元の状態を変更せず、不明IDはRangeError', () => {
  const open = addItem(createState(), input); const id = open.items[0].id;
  Object.freeze(open.items[0]); Object.freeze(open.items); Object.freeze(open);
  const decided = decideItem(open, id, decision);
  const reflected = reflectItem(decided, id, { planUrl: ' https://example.invalid/plan ' });
  const done = completeItem(reflected, id);
  assert.deepEqual([open, decided, reflected, done].map(state => state.items[0].status), ['open', 'decided', 'reflected', 'done']);
  assert.equal(reflected.items[0].planUrl, 'https://example.invalid/plan');
  assert.equal(done.items[0].countermeasure, decision.countermeasure);
  assert.notEqual(decided.items[0], open.items[0]);
  for (const change of [decideItem, reflectItem, completeItem]) assert.throws(() => change(open, 'missing'), RangeError);
  for (const key of ['countermeasure', 'owner']) {
    for (const value of [undefined, '', '  ']) assert.throws(() => decideItem(open, id, { ...decision, [key]: value }), TypeError);
  }
  assert.throws(() => decideItem(open, id, { ...decision, due: 'tomorrow' }), RangeError);
  assert.equal(decideItem(open, id, { ...decision, due: ' ' }).items[0].due, '');
  assert.equal(reflectItem(decided, id, {}).items[0].planUrl, '');
});

test('状態別・案件別・担当別を集計し、未担当は担当別に含めない', () => {
  let state = createState();
  for (let i = 0; i < 4; i++) state = addItem(state, { ...input, client: i === 3 ? '別案件' : input.client });
  for (const item of state.items.slice(1)) state = decideItem(state, item.id, decision);
  state = reflectItem(state, 'kz-3', {}); state = completeItem(state, 'kz-4');
  assert.deepEqual(summarize(state), {
    total: 4, byStatus: { open: 1, decided: 1, reflected: 1, done: 1 },
    byClient: { [input.client]: 3, 別案件: 1 }, byOwner: { 佐藤: 3 },
  });
  const special = summarize(addItem(createState(), { ...input, client: '__proto__' }));
  assert.equal(special.byClient.__proto__, 1);
  assert.equal(summarize(createState()).total, 0);
});

test('Markdownは1件1ブロックで未定と日本語状態を出す', () => {
  const open = addItem(createState(), input);
  const output = toMarkdown(open);
  assert.ok(output.startsWith('# 改善項目一覧\n'));
  assert.ok(output.includes(`## ${input.client}｜${input.event}`));
  assert.ok(output.includes('- 対策: （未定）'));
  assert.ok(output.includes(`- 状態: ${STATUS_LABELS.open}`));
  const decided = toMarkdown(decideItem(open, 'kz-1', decision));
  assert.ok(decided.includes(`- 対策: ${decision.countermeasure}`));
  assert.ok(decided.includes(`- 状態: ${STATUS_LABELS.decided}`));
  assert.equal((toMarkdown(addItem(open, input)).match(/^## /gm) || []).length, 2);
  assert.ok(!toMarkdown(addItem(createState(), { ...input, event: '<script>\n## 見出し' })).includes('<script>'));
});
