import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildCronFlags } from './cost-work-loop.mjs';

describe('buildCronFlags', () => {
  it('GitHub workflow 由来の never は gh run list の点検手順を添える', () => {
    const flags = buildCronFlags([
      { key: 'kimkon1011/orgiast-weekly-bot#weekly.yml', label: '週次経営指示(weekly.yml)', status: 'never', lastSuccess: null, ageDays: null, line: '🚨 週次経営指示(weekly.yml): schedule の成功履歴なし' },
    ]);
    assert.equal(flags.length, 1);
    assert.ok(flags[0].includes('🚨 cron停止'), flags[0]);
    assert.ok(flags[0].includes('schedule の成功履歴なし'), flags[0]);
    assert.ok(flags[0].includes('gh run list --event=schedule'), flags[0]);
  });

  it('GitHub workflow 由来の stale は最終成功日と経過日数を出す', () => {
    const flags = buildCronFlags([
      { key: 'kimkon1011/aujust-sales-automation#dunning-push.yml', label: 'aujust督促(dunning-push.yml)', status: 'stale', lastSuccess: '2026-11-06T01:02:03Z', ageDays: 15.4, line: '🚨 aujust督促(dunning-push.yml): schedule の最終成功 2026-11-06 (15日前)' },
    ]);
    assert.equal(flags.length, 1);
    assert.ok(flags[0].includes('schedule の最終成功 2026-11-06'), flags[0]);
    assert.ok(flags[0].includes('15日前'), flags[0]);
    assert.ok(flags[0].includes('gh run list --event=schedule'), flags[0]);
  });

  it('local# 由来の never は点検側の line をそのまま使い gh run list を混ぜない', () => {
    const flags = buildCronFlags([
      { key: 'local#top3-delivery', label: '日次TOP3(配達)', status: 'never', lastSuccess: null, ageDays: null, line: '🚨 日次TOP3(配達): 一度も届いていません' },
    ]);
    assert.deepEqual(flags, ['🚨 日次TOP3(配達): 一度も届いていません']);
  });

  it('local# 由来の stale も line をそのまま使う', () => {
    const flags = buildCronFlags([
      { key: 'local#rule-compliance-loop', label: 'ルール遵守監査', status: 'stale', lastSuccess: '2026-11-15T00:00:00Z', ageDays: 7, line: '🚨 ルール遵守監査: 最終実行 2026-11-15' },
    ]);
    assert.deepEqual(flags, ['🚨 ルール遵守監査: 最終実行 2026-11-15']);
  });

  it('#delivery 由来の alert も line をそのまま使う', () => {
    const flags = buildCronFlags([
      { key: 'aujust#dunning-push#delivery', label: 'aujust督促(配達)', status: 'alert', lastSuccess: null, ageDays: null, line: '🚨 aujust督促(配達): 直近runで 1件の失敗 — 正本未確認' },
    ]);
    assert.deepEqual(flags, ['🚨 aujust督促(配達): 直近runで 1件の失敗 — 正本未確認']);
  });

  it('GitHub workflow 由来の alert も line を使い、成功履歴なしと言い換えない', () => {
    const flags = buildCronFlags([
      { key: 'kimkon1011/orgiast-claude-rules#cost-monitor.yml', label: 'コスト監視(cost-monitor.yml)', status: 'alert', lastSuccess: null, ageDays: null, line: '🚨 コスト監視(cost-monitor.yml): 直近runで失敗' },
    ]);
    assert.deepEqual(flags, ['🚨 コスト監視(cost-monitor.yml): 直近runで失敗']);
  });

  it('line が無い場合はラベルと状態でフォールバックする', () => {
    const flags = buildCronFlags([
      { key: 'local#handoff-gate-skips', label: 'gate判定スキップ', status: 'alert', lastSuccess: null, ageDays: null },
    ]);
    assert.deepEqual(flags, ['🚨 gate判定スキップ: 状態 alert']);
  });

  it('ok / skip / unknown は警告を出さない', () => {
    const flags = buildCronFlags([
      { key: 'kimkon1011/orgiast-weekly-bot#weekly.yml', label: '週次経営指示(weekly.yml)', status: 'ok', lastSuccess: '2026-11-22T00:00:00Z', ageDays: 0, line: '✅ ok' },
      { key: 'local#top3-delivery', label: '日次TOP3(配達)', status: 'skip', lastSuccess: null, ageDays: null, line: '⚪ この席は配達担当外' },
      { key: 'kimkon1011/orgiast-claude-rules#cost-monitor.yml', label: 'コスト監視(cost-monitor.yml)', status: 'unknown', lastSuccess: null, ageDays: null, line: '⚠️ 取得できません' },
    ]);
    assert.deepEqual(flags, []);
  });

  it('空配列と undefined は空配列を返す', () => {
    assert.deepEqual(buildCronFlags([]), []);
    assert.deepEqual(buildCronFlags(undefined), []);
  });
});
