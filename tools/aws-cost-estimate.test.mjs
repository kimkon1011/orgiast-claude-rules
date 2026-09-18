import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CATALOG, DEFAULT_BUDGET_JPY, PLANS, estimate, estimatePlan, formatReport, lineItem,
} from './aws-cost-estimate.mjs';

const opts = { usdJpy: 100, budgetJpy: 30000 };

test('未計測(usd:null)は合計に足さず、件数として必ず表面化する', () => {
  const r = estimate([{ id: 'ls-small-2gb' }, { id: 'rds-t4g-micro-tokyo' }], opts);
  assert.equal(r.totalUsd, 12);
  assert.equal(r.unmeasuredCount, 1);
  assert.equal(r.certainty, 'partial');
});

test('未計測/未確認を含むプランのレポートは「一部未確定」と注記する', () => {
  const catalog = {
    ...CATALOG,
    'ls-snapshot': { ...CATALOG['ls-snapshot'], usd: null, verified: false },
  };
  const text = formatReport({ ...opts, planIds: ['A'], catalog });
  assert.match(text, /一部未確定/);
  assert.match(text, /未計測 1 件（実費はこれより大きい）/);
  assert.equal(estimatePlan('A', { ...opts, catalog }).certainty, 'partial');
});

test('未確認(verified:false)は確定分と別枠で集計し、確定と言い切らない', () => {
  const r = estimate([{ id: 'ls-small-2gb' }, { id: 'ec2-t4g-medium-tokyo' }], opts);
  assert.equal(r.certainty, 'partial');
  assert.equal(r.confirmedJpy, 1200);
  assert.ok(r.unverifiedJpy > 0);
  assert.equal(r.confirmedJpy + r.unverifiedJpy, r.totalJpy);
});

test('全項目が一次情報なら certainty=confirmed', () => {
  const r = estimatePlan('B', opts);
  assert.equal(r.certainty, 'confirmed');
  assert.equal(r.unverifiedJpy, 0);
  assert.equal(r.unmeasuredCount, 0);
});

test('予算判定はちょうど予算額を within に含める', () => {
  assert.equal(estimate([{ id: 'ls-small-2gb' }], { usdJpy: 2500, budgetJpy: 30000 }).verdict, 'within');
  assert.equal(estimate([{ id: 'ls-small-2gb' }], { usdJpy: 2501, budgetJpy: 30000 }).verdict, 'over');
});

test('数量は gb-month 明細で GB 数として掛かる', () => {
  assert.equal(lineItem('ls-snapshot', 40).usd, 2);
  assert.equal(estimate([{ id: 'ls-snapshot', qty: 40 }], opts).totalUsd, 2);
});

test('不正入力は例外にする（0除算・未知ID・負数・未知プラン）', () => {
  assert.throws(() => estimate([{ id: 'nope' }], opts), /未知の価格ID/);
  assert.throws(() => estimate([{ id: 'ls-small-2gb', qty: -1 }], opts), /数量/);
  assert.throws(() => estimate([{ id: 'ls-small-2gb' }], { usdJpy: 0 }), /為替レート/);
  assert.throws(() => estimate([{ id: 'ls-small-2gb' }], { usdJpy: 1, budgetJpy: 0 }), /予算/);
  assert.throws(() => estimatePlan('Z', opts), /未知のプラン/);
});

test('全プランが同じ予算・レートで評価でき、明細が空でない', () => {
  for (const p of PLANS) {
    const r = estimatePlan(p.id, opts);
    assert.ok(r.lines.length > 0, `${p.id} の明細が空`);
    assert.ok(Number.isFinite(r.totalJpy));
  }
});

test('D案(メモリ最適化64GB)は既定予算を超える = 3万円の境界を示す', () => {
  const r = estimatePlan('D', { usdJpy: 156, budgetJpy: DEFAULT_BUDGET_JPY });
  assert.equal(r.verdict, 'over');
});

test('レポートは全プランを含み、出典の無い金額を出さない', () => {
  const text = formatReport({ usdJpy: 156 });
  for (const p of PLANS) assert.ok(text.includes(p.name), `${p.name} が無い`);
  for (const item of Object.values(CATALOG)) {
    assert.ok(typeof item.source === 'string' && item.source.length > 0, '出典の無い価格がある');
    assert.equal(typeof item.verified, 'boolean');
  }
});
