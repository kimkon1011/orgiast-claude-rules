import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateFleet, dedupeAliasRows, buildAliasIndex } from './cost-improve-loop.mjs';

const HOST = 'desktop-2d0r4li';
function row(label, reportedAt, delegRatio, claudeUsd, hostname = HOST) {
  return { pcName: '', label, hostname, reportedAt, delegRatio, claudeUsd, cheapAiUse: 'groq:5', livenessState: '生存' };
}

test('同一ホスト名3行は最新報告の1行だけを採用し、他を alias_of として除外する', () => {
  const rows = [
    row('kim-PC', '2026-08-28 09:00', '61.2%', '3'),
    row('DESKTOP-2D0R4LI', '2026-09-01 08:00', '55.0%', '2'),
    row('kim-PC(開発機/kim)', '2026-08-20 09:00', '10%', '5'),
  ];
  const { rows: chosen, excluded } = dedupeAliasRows(rows, new Map(), new Date('2026-09-02T00:00:00.000Z'));
  assert.equal(chosen.length, 1);
  assert.equal(chosen[0].label, 'DESKTOP-2D0R4LI');
  assert.equal(excluded.length, 2);
  assert.ok(excluded.every((x) => x.aliasOf === 'DESKTOP-2D0R4LI' && String(x.host).toLowerCase() === HOST));
});

test('evaluateFleet は alias 除去後に違反判定する(古い別表記行を stale にしない)', () => {
  const rows = [
    row('kim-PC', '2026-08-28 09:00', '61.2%', '3'),
    row('DESKTOP-2D0R4LI', '2026-09-01 08:00', '55.0%', '2'),
    row('kim-PC(開発機/kim)', '2026-08-20 09:00', '10%', '5'),
  ];
  const now = new Date('2026-09-02T00:00:00.000Z');
  const result = evaluateFleet({ rows, ledgerCounts: { groq: 5 }, localState: { pcName: 'self', delegRatio: 0.6, configuredProviders: [] }, now });
  assert.equal(result.pcs.length, 1);
  const stale = result.violations.filter((v) => v.kind === 'stale_report');
  assert.equal(stale.length, 0, JSON.stringify(stale));
  // 集計値も除外後の1行だけが対象(avgDelegRatio は55%相当)。
  assert.ok(Math.abs(result.fleet.avgDelegRatio - 0.55) < 0.001, `avg=${result.fleet.avgDelegRatio}`);
});

test('buildAliasIndex はラベルと aliases をホストへ写像する', () => {
  const index = buildAliasIndex({
    'kim-PC': { hostname: 'DESKTOP-2D0R4LI', aliases: ['DESKTOP-2D0R4LI', 'kim-PC(開発機/kim)'] },
    'kimko-PC': { sheetName: '作業用011', aliases: ['作業用011(=DESKTOP-PPD5V8I)'] },
  });
  assert.equal(index.get('kim-pc'), 'DESKTOP-2D0R4LI');
  assert.equal(index.get('desktop-2d0r4li'), 'DESKTOP-2D0R4LI');
  assert.equal(index.get('kim-pc(開発機/kim)'), 'DESKTOP-2D0R4LI');
  assert.equal(index.get('kimko-pc'), '作業用011');
  assert.equal(index.get('作業用011(=desktop-ppd5v8i)'), '作業用011');
});

test('hostname 列が無い行でも fleet-pc-map の aliases で同一機体にまとめる', () => {
  const index = buildAliasIndex({ 'kim-PC': { hostname: 'DESKTOP-2D0R4LI', aliases: ['kim-PC(開発機/kim)'] } });
  const rows = [
    { pcName: '', label: 'kim-PC', reportedAt: '2026-08-28 09:00', delegRatio: '61.2%', claudeUsd: '3' },
    { pcName: '', label: 'kim-PC(開発機/kim)', reportedAt: '2026-08-20 09:00', delegRatio: '10%', claudeUsd: '5' },
  ];
  const { rows: chosen, excluded } = dedupeAliasRows(rows, index, new Date('2026-09-02T00:00:00.000Z'));
  assert.equal(chosen.length, 1);
  assert.equal(chosen[0].label, 'kim-PC');
  assert.equal(excluded.length, 1);
  assert.equal(excluded[0].pc, 'kim-PC(開発機/kim)');
});
