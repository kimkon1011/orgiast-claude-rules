import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReport, shouldReport, DAY_TARGET_PCT, aggregateAccountSnapshots } from './claude-pace-report.mjs';

const config = {
  targetLanding: 90,
  staleHours: 3,
  reportHost: '011',
  reportFallbackHost: '018',
};

test('結論は日次差でなく status をそのまま集計する', () => {
  const now = Date.parse('2026-11-27T12:00:00.000Z');
  const onpace = buildReport({
    snapshots: [{ ts: new Date(now).toISOString(), account: 'a@x', host: '018', sevenDayPct: 20, status: 'onpace' }],
    config,
    now,
  }).markdown;
  assert.match(onpace, /遅れ 0 \/ ちょうど 1 \/ 進みすぎ 0/);

  const mixed = buildReport({
    snapshots: [
      { ts: new Date(now).toISOString(), account: 'behind@x', host: '014', sevenDayPct: 10, status: 'behind' },
      { ts: new Date(now).toISOString(), account: 'ahead@x', host: '011', sevenDayPct: 80, status: 'ahead' },
    ],
    config,
    now,
  }).markdown;
  assert.match(mixed, /遅れ 1 \/ ちょうど 0 \/ 進みすぎ 1/);
});

test('buildReport がアカウント別・予測着地・措置・次作業・新サービスを含む', () => {
  const now = Date.parse('2026-11-27T22:30:00.000Z');
  const snapshots = [
    {
      ts: new Date(now - 25 * 3600_000).toISOString(),
      host: '011',
      account: 'cr@orgiast.jp',
      sevenDayPct: 40,
      target: 38,
      deltaPt: 2,
      projectedLanding: 88,
      status: 'onpace',
      launch: false,
      hold: false,
      reasons: [],
      codex: [{ window: 300, usedPercent: 12 }],
    },
    {
      ts: new Date(now).toISOString(),
      host: '011',
      account: 'cr@orgiast.jp',
      sevenDayPct: 52,
      target: 45,
      deltaPt: 7,
      projectedLanding: 92,
      status: 'ahead',
      launch: false,
      hold: true,
      reasons: ['ahead'],
      codex: [{ window: 300, usedPercent: 15 }],
    },
    {
      ts: new Date(now).toISOString(),
      host: '014',
      account: 'seisaku-team@orgiast.jp',
      sevenDayPct: 30,
      target: 45,
      deltaPt: -15,
      projectedLanding: 70,
      status: 'behind',
      launch: true,
      hold: false,
      reasons: ['behind'],
      codex: [],
    },
  ];
  const queue = {
    tasks: [
      { id: 'Q-014-01', host: '014', priority: 1, title: 'ブース調査', prompt: '調査', state: '未着手' },
      { id: 'Q-018-01', host: '018', priority: 1, title: '学会リスト', prompt: 'リスト', state: '未着手' },
      { id: 'Q-011-01', host: '011', priority: 2, title: '粗利ゲート', prompt: '実装', state: '未着手' },
    ],
    newOfferings: [
      { id: 'N-01', host: '014', title: 'Reブース販売ページ', state: '着手' },
      { id: 'N-02', host: '018', title: '学会パッケージ', state: '未着手' },
    ],
  };
  const { markdown, json } = buildReport({ snapshots, queue, config, now });
  assert.match(markdown, /cr@orgiast\.jp/);
  assert.match(markdown, /seisaku-team@orgiast\.jp/);
  assert.match(markdown, /予測着地/);
  assert.match(markdown, /92\.0%/);
  assert.match(markdown, /進みすぎ|hold|遅れ|作業起動/);
  assert.match(markdown, /Q-014-01/);
  assert.match(markdown, /Reブース販売ページ/);
  assert.match(markdown, /Codex/);
  assert.match(markdown, new RegExp(String(DAY_TARGET_PCT).replace('.', '\\.')));
  assert.ok(json.accounts.length >= 2);
  assert.ok(json.nextTasks.length >= 1);
  assert.equal(json.newOfferingsStarted.length, 1);
});

test('計測できなかったPCが本文に出る', () => {
  const { markdown, json } = buildReport({
    snapshots: [
      { host: '999', missing: true, missingReason: 'Drive読取失敗' },
    ],
    queue: { tasks: [], newOfferings: [] },
    config,
    now: Date.parse('2026-11-27T22:30:00.000Z'),
    missingHosts: [{ host: '004', reason: 'paceファイル無し' }],
  });
  assert.match(markdown, /計測できなかったPC/);
  assert.match(markdown, /999/);
  assert.match(markdown, /004/);
  assert.ok(json.missingHosts.some((m) => m.host === '004'));
});

test('shouldReport は 011 既定、011 が stale なら 018', () => {
  const now = Date.parse('2026-11-27T12:00:00.000Z');
  const fresh = { '011': now - 30 * 60_000 };
  assert.equal(shouldReport('011', config, fresh, now), true);
  assert.equal(shouldReport('018', config, fresh, now), false);
  assert.equal(shouldReport('014', config, fresh, now), false);

  const stale = { '011': now - 4 * 3600_000 };
  assert.equal(shouldReport('011', config, stale, now), false);
  assert.equal(shouldReport('018', config, stale, now), true);
  assert.equal(shouldReport('014', config, stale, now), false);

  assert.equal(shouldReport('018', config, {}, now), true);
});

test('aggregateAccountSnapshots が前日増分を付ける', () => {
  const now = Date.parse('2026-11-27T12:00:00.000Z');
  const rows = [
    { ts: new Date(now - 24 * 3600_000).toISOString(), account: 'a@x', host: '011', sevenDayPct: 40, projectedLanding: 80 },
    { ts: new Date(now).toISOString(), account: 'a@x', host: '011', sevenDayPct: 50, projectedLanding: 85, status: 'onpace' },
  ];
  const [a] = aggregateAccountSnapshots(rows, now);
  assert.equal(a.dayDelta, 10);
  assert.ok(Math.abs(a.dayDeltaVsTarget - (10 - DAY_TARGET_PCT)) < 1e-9);
  assert.equal(a.unusedForecast, 15);
});
