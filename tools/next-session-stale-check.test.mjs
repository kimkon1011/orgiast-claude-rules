import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractReferences,
  classifyLine,
  resolveDelegationHealthStatus,
  STATUS_RESOLVED,
  STATUS_PENDING,
  STATUS_UNKNOWN,
} from './next-session-stale-check.mjs';

const NOW = new Date('2026-11-27T00:00:00.000Z');

test('[delegation-health:id] を参照として抽出する', () => {
  const refs = extractReferences(
    '[delegation-health:lane_outage_unrepaired] grok が直近 4 件すべて失敗',
  );
  assert.deepEqual(refs.delegationHealthIds, ['lane_outage_unrepaired']);
});

test('1行に PR と delegation-health が混在しても両方抽出する', () => {
  const refs = extractReferences(
    'PR #2857 / [delegation-health:lane_outage_unrepaired] の確認',
  );
  assert.deepEqual(refs.prNumbers, [2857]);
  assert.deepEqual(refs.delegationHealthIds, ['lane_outage_unrepaired']);
});

test('1行に delegation-health が複数あればすべて拾う', () => {
  const refs = extractReferences(
    '[delegation-health:lane_outage_unrepaired] と [delegation-health:provider_usage_limit]',
  );
  assert.deepEqual(refs.delegationHealthIds, [
    'lane_outage_unrepaired',
    'provider_usage_limit',
  ]);
});

test('findings に id が無い台帳は解決済み', () => {
  const ledger = {
    generatedAt: '2026-11-26T18:15:23.306Z',
    findings: [{ id: 'other_finding' }],
  };
  assert.equal(
    resolveDelegationHealthStatus(ledger, 'lane_outage_unrepaired', NOW),
    'resolved',
  );
  assert.equal(
    classifyLine(
      '[delegation-health:lane_outage_unrepaired]',
      new Map(),
      new Map(),
      new Map(),
      new Map([['lane_outage_unrepaired', 'resolved']]),
    ),
    STATUS_RESOLVED,
  );
});

test('findings に id が有る台帳は未解決', () => {
  const ledger = {
    generatedAt: '2026-11-26T18:15:23.306Z',
    findings: [{ id: 'lane_outage_unrepaired', severity: 'high' }],
  };
  assert.equal(
    resolveDelegationHealthStatus(ledger, 'lane_outage_unrepaired', NOW),
    'present',
  );
  assert.equal(
    classifyLine(
      '[delegation-health:lane_outage_unrepaired]',
      new Map(),
      new Map(),
      new Map(),
      new Map([['lane_outage_unrepaired', 'present']]),
    ),
    STATUS_PENDING,
  );
});

test('台帳が無い／壊れている／findings が配列でないときは解決済みにしない', () => {
  assert.equal(resolveDelegationHealthStatus(null, 'lane_outage_unrepaired', NOW), undefined);
  assert.equal(resolveDelegationHealthStatus(undefined, 'lane_outage_unrepaired', NOW), undefined);
  assert.equal(
    resolveDelegationHealthStatus({ generatedAt: '2026-11-26T18:15:23.306Z' }, 'lane_outage_unrepaired', NOW),
    undefined,
  );
  assert.equal(
    resolveDelegationHealthStatus(
      { generatedAt: '2026-11-26T18:15:23.306Z', findings: { id: 'lane_outage_unrepaired' } },
      'lane_outage_unrepaired',
      NOW,
    ),
    undefined,
  );
  assert.equal(
    classifyLine(
      '[delegation-health:lane_outage_unrepaired]',
      new Map(),
      new Map(),
      new Map(),
      new Map(),
    ),
    STATUS_UNKNOWN,
  );
});

test('generatedAt が無い、または 7 日以上前なら解決済みにしない', () => {
  assert.equal(
    resolveDelegationHealthStatus({ findings: [] }, 'lane_outage_unrepaired', NOW),
    undefined,
  );
  assert.equal(
    resolveDelegationHealthStatus(
      { generatedAt: '2026-11-19T23:59:59.000Z', findings: [] },
      'lane_outage_unrepaired',
      NOW,
    ),
    undefined,
  );
  assert.equal(
    resolveDelegationHealthStatus(
      { generatedAt: '2026-11-20T00:00:00.000Z', findings: [] },
      'lane_outage_unrepaired',
      NOW,
    ),
    'resolved',
  );
});

test('既存の PR / ki- 参照判定は従来どおり', () => {
  assert.deepEqual(extractReferences('PR #2826 の MERGED 読み戻し').prNumbers, [2826]);
  assert.deepEqual(
    extractReferences('ki-20261126122725-71fd — 重複している判断依頼').inboxIds,
    ['ki-20261126122725-71fd'],
  );
  assert.equal(
    classifyLine(
      'PR #2826 / ki-20261126122725-71fd',
      new Map([[2826, 'MERGED']]),
      new Map([['ki-20261126122725-71fd', 'answered']]),
      new Map(),
    ),
    STATUS_RESOLVED,
  );
  assert.equal(
    classifyLine('PR #2826', new Map([[2826, 'OPEN']]), new Map(), new Map()),
    STATUS_PENDING,
  );
  assert.equal(
    classifyLine('返信は送信済み', new Map(), new Map(), new Map()),
    STATUS_UNKNOWN,
  );
});
