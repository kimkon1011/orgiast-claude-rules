import test from 'node:test';
import assert from 'node:assert/strict';
import { buildContractPayload, resolveVendorTargets } from './cloud-contract-fill.mjs';

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

test('buildContractPayload uses median and omits unknowable or ambiguous fields', () => {
  const payload = buildContractPayload({
    medianMonthlyJpy: 28000,
    latestMonthAmount: 32866,
    billingCycle: '',
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
    payers: [{ name: '金立替／アメリカン・エキスプレス', count: 4 }],
  }, '2026-08-30');
  assert.equal(payload.payerName, '金立替／アメリカン・エキスプレス');
  assert.equal(payload.billingCycle, '月次');
  assert.equal(payload.currency, 'JPY');
  assert.equal(payload.checkedAt, '2026-08-30');
  assert.equal(payload.detected, '検出済み');
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
