import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ARRIVAL_TEXT_RE,
  HEADER,
  alreadyLogged,
  buildRow,
  captionOf,
  clusterArrivals,
  clusterMessageIds,
  collectLoggedMessageIds,
  downloadWithRetry,
  parseArgs,
  parseVisionJson,
  receivedAtOf,
  stripHtml,
  toJst,
} from './osaka-mail-arrival-sync.mjs';

function msg(overrides) {
  return {
    id: '1',
    senderName: 'yurie',
    timestamp: '2026-11-18T02:14:13.978Z',
    type: 'IMAGE',
    attachments: [{ mimeType: 'image/jpeg' }],
    ...overrides,
  };
}

test('stripHtml removes br and tags', () => {
  assert.equal(stripHtml('@きむこん☺ <br>代引きだったので¥6,420'), '@きむこん☺ 代引きだったので¥6,420');
});

test('toJst converts UTC to Asia/Tokyo', () => {
  assert.equal(toJst('2026-11-20T03:26:02.391Z'), '2026-11-20 12:26');
});

test('cluster groups same-sender images within 3 minutes and keeps caption', () => {
  const messages = [
    msg({ id: '36378', timestamp: '2026-11-20T01:49:10.907Z', senderName: 'ほなみ', sortKey: '86440' }),
    msg({ id: '36379', timestamp: '2026-11-20T01:49:11.315Z', senderName: 'ほなみ', sortKey: '86441' }),
    msg({ id: '36786', type: 'TEXT', text: 'こちらオージャスト宛のアルミ板、代引きだったので¥6,420', timestamp: '2026-11-20T03:25:43.726Z', senderName: 'ほなみ', attachments: [] }),
    msg({ id: '36787', timestamp: '2026-11-20T03:26:02.391Z', senderName: 'ほなみ' }),
    msg({ id: '32843', timestamp: '2026-11-18T06:07:44.834Z', senderName: 'yurie' }),
    { id: 'r1', type: 'REACTION', senderName: 'ほなみ', timestamp: '2026-11-20T03:26:10.000Z' },
  ];
  const clusters = clusterArrivals(messages);
  assert.equal(clusters.length, 3);
  assert.deepEqual(clusterMessageIds(clusters[0]), ['32843']);
  assert.deepEqual(clusterMessageIds(clusters[1]), ['36378', '36379']);
  assert.deepEqual(clusterMessageIds(clusters[2]), ['36786', '36787']);
  assert.match(captionOf(clusters[2]), /アルミ板/);
  assert.equal(toJst(receivedAtOf(clusters[2])), '2026-11-20 12:25');
});

test('cluster drops own-account work requests without photos', () => {
  const messages = [
    msg({
      id: '4959',
      type: 'TEXT',
      text: 'ラハイナへ WEBカメラとスピーカーを発送してください',
      senderName: 'オージャスト金(読取専用)',
      isSender: true,
      attachments: [],
      timestamp: '2026-11-09T04:01:50.668Z',
    }),
    msg({
      id: '14093',
      type: 'TEXT',
      text: 'カフェが17時までなのでスタッフ退勤済みです',
      senderName: 'ほなみ',
      attachments: [],
      timestamp: '2026-11-13T08:43:49.670Z',
    }),
  ];
  assert.equal(clusterArrivals(messages).length, 0);
});

test('cluster keeps staff arrival text even without a photo', () => {
  const messages = [
    msg({
      id: 't1',
      type: 'TEXT',
      text: '郵便物が届きました',
      senderName: 'yurie',
      attachments: [],
      timestamp: '2026-11-18T01:00:00.000Z',
    }),
  ];
  const clusters = clusterArrivals(messages);
  assert.equal(clusters.length, 1);
  assert.deepEqual(clusterMessageIds(clusters[0]), ['t1']);
});

test('dedup uses every message id in the logged cell', () => {
  const rows = [['', '', '', '', '', '', '', '', '36378,36379']];
  const ids = collectLoggedMessageIds(rows);
  assert.equal(alreadyLogged(['36378'], ids), true);
  assert.equal(alreadyLogged(['36787'], ids), false);
});

test('parseVisionJson reads fenced JSON and arrival flag', () => {
  const parsed = parseVisionJson('```json\n{"is_arrival":true,"sender":"株式会社勇商事","addressee":"株式会社オージャスト 金功勇","kind":"佐川（アルミ板）","carrier":"佐川急便","tracking":"1409-4020","notes":"代引き"}\n```');
  assert.equal(parsed.isArrival, true);
  assert.equal(parsed.sender, '株式会社勇商事');
  assert.equal(parsed.carrier, '佐川急便');
});

test('parseVisionJson rejects non-arrival photos', () => {
  const parsed = parseVisionJson('{"is_arrival":false,"reason":"スクリーンショット"}');
  assert.equal(parsed.isArrival, false);
  assert.equal(parsed.reason, 'スクリーンショット');
});

test('buildRow writes JST time, ids, and 未確認', () => {
  const cluster = {
    senderName: 'ほなみ',
    messages: [
      msg({ id: '36786', type: 'TEXT', text: '代引きだったので¥6,420', timestamp: '2026-11-20T03:25:43.726Z', attachments: [] }),
      msg({ id: '36787', timestamp: '2026-11-20T03:26:02.391Z' }),
    ],
  };
  const row = buildRow({
    cluster,
    extracted: { sender: '勇商事', addressee: 'オージャスト 金功勇', kind: 'アルミ板', carrier: '佐川急便', tracking: '1409-4020', notes: '代引き' },
    photoUrls: ['https://drive.google.com/file/d/abc/view?authuser=kim@orgiast.jp'],
    ingestedAt: '2026-11-20T08:50:00.000Z',
  });
  assert.equal(row[0], '2026-11-20 12:25');
  assert.equal(row[1], '勇商事');
  assert.equal(row[7], 'ほなみ');
  assert.equal(row[8], '36786,36787');
  assert.match(row[9], /代引き/);
  assert.equal(row[10], '未確認');
  assert.equal(row.length, HEADER.length);
});

test('parseArgs accepts known flags and rejects others', () => {
  assert.deepEqual(parseArgs(['--live', '--backfill']), { live: true, backfill: true, dryRun: false, setup: false, register: false });
  assert.throws(() => parseArgs(['--send']), /未知の引数/);
});

test('arrival text regex matches office captions', () => {
  assert.equal(ARRIVAL_TEXT_RE.test('郵便物が届きました'), true);
  assert.equal(ARRIVAL_TEXT_RE.test('代引きだったので'), true);
  assert.equal(ARRIVAL_TEXT_RE.test('カフェが17時まで'), false);
});

test('downloadWithRetry retries then succeeds', async () => {
  let calls = 0;
  const bytes = await downloadWithRetry(async () => {
    calls += 1;
    if (calls < 3) throw new Error('Beeper asset download failed');
    return Buffer.from('ok');
  }, {}, { tries: 3, delayMs: 1, sleepFn: async () => {} });
  assert.equal(calls, 3);
  assert.equal(bytes.toString(), 'ok');
});
