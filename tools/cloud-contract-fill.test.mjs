import test from 'node:test';
import assert from 'node:assert/strict';
import { buildContractPayload, classifyBilling, resolveVendorTargets } from './cloud-contract-fill.mjs';

const keys = [
  ['Anthropic (Claude Code)', 'claude@example.jp'],
  ['Anthropic API', 'api@example.jp'],
  ['Groq', 'dev@example.jp'],
];

test('resolveVendorTargets preserves ambiguity and resolves only one ledger row', () => {
  const anthropic = resolveVendorTargets('ANTHROPIC', keys);
  assert.equal(anthropic.status, 'ambiguous');
  assert.equal(anthropic.targets.length, 2);
  assert.deepEqual(resolveVendorTargets('GROQ', keys), {
    status: 'resolved', targets: [{ service: 'Groq', account: 'dev@example.jp' }],
  });
  assert.equal(resolveVendorTargets('UNKNOWN VENDOR', keys).status, 'missing');
});

test('buildContractPayload uses recent charges and omits unknowable or ambiguous fields', () => {
  const payload = buildContractPayload({
    medianMonthlyJpy: 28000,
    latestMonthAmount: 32866,
    billingCycle: '',
    monthly: { '2026-08': 28000, '2026-07': 28000 },
    payers: [{ name: 'A', count: 2 }, { name: 'B', count: 1 }],
  }, '2026-08-30');
  assert.equal(payload.monthlyAmount, 28000);
  assert(!Object.hasOwn(payload, 'payerName'));
  assert(!Object.hasOwn(payload, 'billingCycle'));
  const serialized = JSON.stringify(payload);
  assert(!serialized.includes('プラン'));
  assert(!serialized.includes('支払い元カード(下4桁)'));
});

test('buildContractPayload includes a sole payer and a nonempty billing cycle', () => {
  const payload = buildContractPayload({
    medianMonthlyJpy: 9800,
    billingCycle: '月次',
    monthly: {
      '2026-08': 9800, '2026-07': 9800, '2026-06': 9800,
      '2026-05': 9800, '2026-04': 9800, '2026-03': 9800,
    },
    payers: [{ name: '金立替／アメリカン・エキスプレス', count: 4 }],
  }, '2026-08-30');
  assert.equal(payload.payerName, '金立替／アメリカン・エキスプレス');
  assert.equal(payload.billingCycle, '月次');
  assert.equal(payload.currency, 'JPY');
  assert.equal(payload.checkedAt, '2026-08-30');
  assert.equal(payload.detected, '検出済み');
});

test('OPENAI相当: 4か月課金がなければ stale とし、金額と通貨を送らない', () => {
  const summary = {
    monthly: { '2026-04': 36408, '2026-03': 36376, '2026-02': 35101, '2026-01': 36268, '2025-12': 36518 },
    medianMonthlyJpy: 36376,
  };
  assert.deepEqual(classifyBilling(summary.monthly, '2026-08-30'), {
    status: 'stale', monthlyJpy: null, billingCycle: '', lastChargedMonth: '2026-04', activeMonths: 5,
  });
  const payload = buildContractPayload(summary, '2026-08-30');
  assert(!Object.hasOwn(payload, 'monthlyAmount'));
  assert(!Object.hasOwn(payload, 'currency'));
});

test('TACTIQ相当: 課金が1回だけなら月額を書かない', () => {
  const monthly = { '2026-05': 26361 };
  assert.equal(classifyBilling(monthly, '2026-08-30').status, 'stale');
  assert(!Object.hasOwn(buildContractPayload({ monthly }, '2026-08-30'), 'monthlyAmount'));
});

test('ANTHROPIC相当: 現在の月額は直近3か月の中央値を使う', () => {
  const monthly = {
    '2026-08': 62353, '2026-07': 1201172, '2026-06': 634890, '2026-05': 3193, '2026-04': 28200,
    '2026-03': 24000, '2026-02': 19000, '2026-01': 18000, '2025-12': 17000, '2025-11': 16000,
  };
  const result = classifyBilling(monthly, '2026-08-30');
  assert.equal(result.status, 'active');
  assert.equal(result.monthlyJpy, 634890);
});

test('billingCycle は集計値でなく直近6か月の課金月数から判定する', () => {
  const allSix = { '2026-08': 1, '2026-07': 2, '2026-06': 3, '2026-05': 4, '2026-04': 5, '2026-03': 6 };
  const onlyThree = { '2026-08': 1, '2026-07': 2, '2026-04': 5 };
  assert.equal(classifyBilling(allSix, '2026-08-30').billingCycle, '月次');
  assert.equal(classifyBilling(onlyThree, '2026-08-30').billingCycle, '');
});

test('課金なしは none とし、payload に金額系や禁止フィールドを含めない', () => {
  assert.deepEqual(classifyBilling({}, '2026-08-30'), {
    status: 'none', monthlyJpy: null, billingCycle: '', lastChargedMonth: null, activeMonths: 0,
  });
  const serialized = JSON.stringify(buildContractPayload({
    monthly: {}, medianMonthlyJpy: 9999, billingCycle: '月次', plan: 'Pro', card: '1234',
  }, '2026-08-30'));
  for (const forbidden of ['monthlyAmount', 'currency', 'プラン', '支払い元カード', 'plan', 'card']) {
    assert(!serialized.includes(forbidden), forbidden);
  }
});

// 集計側(ai-cost-reconcile)は GOOGLE_CLOUD のようにアンダースコアで返す。
// 区切りを揃えないと辞書に当たらず全ベンダーが missing になる（2つのタスクの継ぎ目のバグ）。
test('アンダースコア区切りのベンダー名も辞書に当たる', () => {
  const keys = [['Google Cloud', 'aujust-sales-automation'], ['Google Workspace', 'orgiast.jp']];
  assert.equal(resolveVendorTargets('GOOGLE_CLOUD', keys).status, 'resolved');
  assert.equal(resolveVendorTargets('GOOGLE_WORKSPACE', keys).status, 'resolved');
  // どちらとも決められない素の GOOGLE は書かない
  assert.equal(resolveVendorTargets('GOOGLE', keys).status, 'ambiguous');
  // 集計側が「Googleだが用途不明」として返す印は、台帳のどの行にも当てない
  assert.equal(resolveVendorTargets('GOOGLE_UNKNOWN', keys).status, 'missing');
});
