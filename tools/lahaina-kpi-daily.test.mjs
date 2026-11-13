import test from 'node:test';
import assert from 'node:assert/strict';
import { parseJalanDetails, parseOfficial, buildRow, HEADERS, isoLocal } from './lahaina-kpi-daily.mjs';
import { taskCommand } from './lahaina-kpi-daily-register.mjs';

test('じゃらんの最安値とプラン数を抽出', () =>
  assert.deepEqual(parseJalanDetails('planName 15,000円 planCassette 12,500円 planCassette 13,000円 planCassette'), { minPrice: 12500, planCount: 3, error: '' }));

test('じゃらん html=null / undefined / 空本文の例外回避とエラー記述', () => {
  assert.deepEqual(parseJalanDetails(''), { minPrice: '', planCount: 0, error: 'じゃらんHTML取得失敗 (HTMLが空/null)' });
  assert.deepEqual(parseJalanDetails(null), { minPrice: '', planCount: 0, error: 'じゃらんHTML取得失敗 (HTMLが空/null)' });
  assert.deepEqual(parseJalanDetails(undefined), { minPrice: '', planCount: 0, error: 'じゃらんHTML取得失敗 (HTMLが空/null)' });
});

test('公式HPの予約導線・語句・最新日を抽出', () =>
  assert.deepEqual(parseOfficial('<a href="https://jalan.net/a">予約</a><a href="/reserve">予約</a>営業継続 牡蠣 2026/09/01 2026-10-20'), { reservationCount: 2, continuing: true, oyster: true, latestNoticeDate: '2026-10-20', error: '' }));

test('公式HP html=null / undefined / 空本文の例外回避とエラー記述', () => {
  assert.deepEqual(parseOfficial(''), { reservationCount: 0, continuing: false, oyster: false, latestNoticeDate: '', error: '公式HP HTML取得失敗 (HTMLが空/null)' });
  assert.deepEqual(parseOfficial(null), { reservationCount: 0, continuing: false, oyster: false, latestNoticeDate: '', error: '公式HP HTML取得失敗 (HTMLが空/null)' });
  assert.deepEqual(parseOfficial(undefined), { reservationCount: 0, continuing: false, oyster: false, latestNoticeDate: '', error: '公式HP HTML取得失敗 (HTML重空/null)' } ? { reservationCount: 0, continuing: false, oyster: false, latestNoticeDate: '', error: '公式HP HTML取得失敗 (HTMLが空/null)' } : null);
});

test('日付はローカル日付', () => assert.equal(isoLocal(new Date(2026, 9, 29, 1)), '2026-10-29'));

test('行の列数とエラー結合', () => {
  const row = buildRow({
    date: '2026-10-29',
    exposureScore: '2/6',
    jalan: { status: 'buyable', minPrice: 10000, planCount: 2 },
    rakuten: 'delisted',
    official: { reservationCount: 1, continuing: false },
    airbnb: 'not_listed',
    booking: 'unmeasurable',
    instagram: { followers: '10', posts: '3' },
    ga4: { sessions: '4', users: '2', sources: ['google:3'] },
    gsc: { clicks: 1, impressions: 8, queries: ['犬:1/8'] },
    errors: ['x', 'y'],
  });
  assert.equal(row.length, HEADERS.length);
  assert.equal(row.at(-1), 'x | y');
});

test('1媒体が取得失敗(null)でも1日分の行が問題なく組み立てられること', () => {
  const jalanFailed = parseJalanDetails(null);
  const row = buildRow({
    date: '2026-11-13',
    exposureScore: '1/6',
    jalan: { status: 'unmeasurable', ...jalanFailed },
    rakuten: 'delisted',
    official: { reservationCount: 1, continuing: true },
    airbnb: 'not_listed',
    booking: 'unmeasurable',
    instagram: { followers: '1150', posts: '166' },
    ga4: { sessions: '', users: '', sources: [] },
    gsc: { clicks: '', impressions: '', queries: [] },
    errors: [`じゃらん: HTTP 503 Service Unavailable (URL: https://www.jalan.net/yad353005/plan/, HTTP: 503)`],
  });
  assert.equal(row.length, HEADERS.length);
  assert.equal(row[0], '2026-11-13');
  assert.equal(row[2], 'unmeasurable'); // じゃらん状態
  assert.equal(row[3], ''); // 最安
  assert.equal(row[4], 0); // プラン数
  assert.equal(row.at(-1), 'じゃらん: HTTP 503 Service Unavailable (URL: https://www.jalan.net/yad353005/plan/, HTTP: 503)');
});

test('タスクコマンドはnode絶対パスで直接起動', () => {
  const c = taskCommand({ node: 'C:\\Program Files\\nodejs\\node.exe', script: 'C:\\repo x\\daily.mjs', home: 'C:\\Users\\kim' });
  assert.equal(c.task, '"C:\\Program Files\\nodejs\\node.exe" "C:\\repo x\\daily.mjs"');
  assert.match(c.log, /run\.log/);
});
