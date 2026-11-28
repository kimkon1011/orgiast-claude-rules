import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  weekRange, pctChange, formatPct, sheetInquiries, unansweredRows, isTestInquiry,
  formatWeeklyMessage, formatUnansweredMessage, splitDiscordMessages,
  matchProperty, gmailQueryForSite, gmailToInquiry, summarizeInquiries,
  fallbackSummary, runWeekly, runUnanswered, parseArgs,
} from './site-weekly-report.mjs';

const HEADERS = ['問い合わせ日時', 'お名前', 'メールアドレス', '電話番号', 'お問い合わせ内容', '会社名', '', '', '', '', '', '', '対応状況', '備考', '', '', '営業担当'];

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'site-weekly-test-'));
}

test('weekRange returns previous complete Mon-Sun in JST', () => {
  // 2026-11-27 Fri JST → week Mon 11/16 〜 Sun 11/22
  const week = weekRange(new Date('2026-11-27T01:00:00+09:00'));
  assert.equal(week.startDate, '2026-11-16');
  assert.equal(week.endDate, '2026-11-22');
  assert.equal(week.prevStartDate, '2026-11-09');
  assert.equal(week.prevEndDate, '2026-11-15');
  assert.match(week.label, /11\/16〜11\/22/);
});

test('pctChange and formatPct', () => {
  assert.equal(pctChange(120, 100), 20);
  assert.equal(pctChange(80, 100), -20);
  assert.equal(pctChange(10, 0), null);
  assert.equal(formatPct(20), '前週比 +20%');
  assert.equal(formatPct(-5), '前週比 -5%');
  assert.equal(formatPct(null), '前週比 —');
});

test('sheetInquiries filters week and excluded', () => {
  const week = weekRange(new Date('2026-11-27T12:00:00+09:00'));
  const values = [
    HEADERS,
    ['2026-11-18 10:00:00', 'A', 'a@x', '', 'ブース見積希望', '株式会社テスト', '', '', '', '', '', '', '', '', '', '', ''],
    ['2026-11-18 11:00:00', 'B', 'b@x', '', '営業です', 'スパム社', '', '', '', '', '', '', '除外', '', '', '', ''],
    ['2026-11-01 10:00:00', 'C', 'c@x', '', '古い', '旧会社', '', '', '', '', '', '', '', '', '', '', ''],
  ];
  const rows = sheetInquiries(values, week);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].company, '株式会社テスト');
  assert.equal(rows[0].row, 2);
});

test('unansweredRows skips completed, young, and already notified', () => {
  const now = Date.parse('2026-11-27T12:00:00+09:00');
  const values = [
    HEADERS,
    ['2026-11-20 10:00:00', '', '', '', '対応待ち案件', '未完了社', '', '', '', '', '', '', '対応中', '', '', '', ''],
    ['2026-11-27 10:00:00', '', '', '', '新しい', '新規社', '', '', '', '', '', '', '', '', '', '', ''],
    ['2026-11-20 10:00:00', '', '', '', '済', '完了社', '', '', '', '', '', '', '完了', '', '', '', ''],
    ['2026-11-19 10:00:00', '', '', '', '再通知しない', '通知済社', '', '', '', '', '', '', '対応中', '', '', '', ''],
  ];
  const rows = unansweredRows(values, { now, notified: { '5': '2026-11-26T00:00:00.000Z' } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].row, 2);
  assert.equal(rows[0].company, '未完了社');
});

test('unansweredRows drops test, excluded sales, and older-than-maxAge', () => {
  const now = Date.parse('2026-11-27T12:00:00+09:00');
  const maxAgeMs = 14 * 24 * 3600 * 1000;
  const values = [
    HEADERS,
    // 24h超〜14日以内・未完了 → 出る
    ['2026-11-20 10:00:00', '', '', '', 'ブース見積の件', '対象社', '', '', '', '', '', '', '対応中', '', '', '', ''],
    // テスト行 → 出ない
    ['2026-11-20 11:00:00', '', '', '', 'アラート通知テストです', '検証用', '', '', '', '', '', '', '', '', '', '', ''],
    // 営業除外（excludedInquiry）→ 出ない
    ['2026-11-20 12:00:00', '', '', '', '突然のご連絡失礼いたします', 'INVERSE HD株式会社', '', '', '', '', '', '', '除外', '', '', '', ''],
    // 15日以上前 → 出ない
    ['2026-11-10 10:00:00', '', '', '', '古い未完了', '古社', '', '', '', '', '', '', '対応中', '', '', '', ''],
    // 24時間以内 → 出ない
    ['2026-11-27 10:00:00', '', '', '', '新着', '新社', '', '', '', '', '', '', '', '', '', '', ''],
  ];
  assert.equal(isTestInquiry(values[2]), true);
  const rows = unansweredRows(values, { now, maxAgeMs });
  assert.deepEqual(rows.map(r => r.row), [2]);
  assert.equal(rows[0].company, '対象社');
});

test('matchProperty prefers config id then name', () => {
  const props = [
    { propertyId: '279040101', displayName: 'orgiast.jp', account: 'Orgiast' },
    { propertyId: '111', displayName: 'rebooth.co.jp / Reブース', account: 'Re' },
  ];
  assert.equal(matchProperty(props, { propertyId: '279040101', domain: 'x', name: 'y' }).propertyId, '279040101');
  assert.equal(matchProperty(props, { propertyId: null, domain: 'rebooth.co.jp', name: 'リブース' }).propertyId, '111');
  assert.equal(matchProperty(props, { propertyId: null, domain: 'missing.example', name: 'なし' }), null);
});

test('gmail helpers', () => {
  const week = { startDate: '2026-11-16', endDate: '2026-11-22' };
  const q = gmailQueryForSite({
    domain: 'rebooth.co.jp', name: 'リブース',
    gmailQuery: 'from:noreply@rebooth.co.jp subject:お問い合わせフォーム',
  }, week);
  assert.match(q, /from:noreply@rebooth\.co\.jp/);
  assert.match(q, new RegExp(`after:${Date.parse('2026-11-16T00:00:00+09:00') / 1000 - 1}`));
  const item = gmailToInquiry({
    id: 'm1',
    subject: 'Reブース｜再利用可能な展示会ブース お問い合わせフォームからの送信',
    body: 'お問い合わせ内容：株式会社FREDの鶴田と申します。ライブコマース用スタジオについて。',
    internalDate: String(Date.parse('2026-11-18T03:00:00Z')),
  }, 'rebooth');
  assert.equal(item.source, 'rebooth');
  assert.equal(item.company, '株式会社FRED');
  assert.match(item.body, /ライブコマース/);
  const iseya = gmailToInquiry({
    id: 'm2',
    subject: 'フォーム',
    body: 'お問い合わせ内容：伊勢湾陸運株式会社 マリン事業部の髙嶋と申します。ブース相談。',
    internalDate: String(Date.parse('2026-11-18T03:00:00Z')),
  }, 'rebooth');
  assert.equal(iseya.company, '伊勢湾陸運株式会社');
});

test('summarizeInquiries falls back when LLM fails', async () => {
  const list = await summarizeInquiries(
    [{ company: 'A社', body: 'とても長い問い合わせ本文です。詳細をここに書きます。追加の文章。' }],
    { askLlm: async () => { throw new Error('down'); } },
  );
  assert.equal(list[0].summary, fallbackSummary('とても長い問い合わせ本文です。詳細をここに書きます。追加の文章。'));
  assert.ok(list[0].summary.length <= 40);
});

test('formatWeeklyMessage and splitDiscordMessages', () => {
  const text = formatWeeklyMessage({
    week: { label: '11/16〜11/22' },
    sites: [
      { id: 'orgiast', name: 'オージャスト', status: 'ok', sessions: 100, pct: 10, inquiryStatus: 'ok' },
      { id: 'rebooth', name: 'リブース', status: 'unconnected', reason: 'GA4未検出' },
    ],
    inquiriesBySite: {
      orgiast: [{ summary: 'ブース見積', company: 'テスト社', date: '2026-11-18T01:00:00.000Z' }],
      rebooth: [],
    },
  });
  assert.match(text, /【自動】今週のサイト状況（11\/16〜11\/22）/);
  assert.match(text, /オージャスト: 100（前週比 \+10%）/);
  assert.match(text, /リブース: 未接続/);
  assert.match(text, /・ブース見積　テスト社/);
  const long = 'あ'.repeat(2500);
  const parts = splitDiscordMessages(long, 2000);
  assert.ok(parts.length >= 2);
  assert.ok(parts.every(p => p.length <= 2000));
});

test('formatUnansweredMessage', () => {
  const text = formatUnansweredMessage([
    { row: 10, summary: 'x', body: '未対応の要件です', company: 'B社', date: '2026-11-20T01:00:00.000Z', status: '対応中' },
  ], new Date('2026-11-27T12:00:00+09:00'), { maxAgeDays: 14 });
  assert.match(text, /対応漏れ検知（2026-11-27）/);
  assert.match(text, /24時間超〜14日以内/);
  assert.match(text, /行10/);
  assert.match(text, /B社/);
});

test('runWeekly dry-run with mocks posts nothing and builds text', async () => {
  const home = tmpHome();
  const config = {
    channelId: '1382930142011326566',
    gmailUser: 'seisaku-team@orgiast.jp',
    sites: [
      { id: 'orgiast', name: 'オージャスト', domain: 'orgiast.jp', propertyId: '279040101', inquirySource: 'sheet' },
      { id: 'rebooth', name: 'リブース', domain: 'rebooth.co.jp', propertyId: null, inquirySource: 'gmail', gmailQueryHints: ['rebooth'] },
      { id: 'toho', name: '東邦鋼業', domain: 'toho-kogyo.com', propertyId: '278904354', inquirySource: 'gmail', gmailQueryHints: ['東邦'] },
    ],
  };
  const week = weekRange(new Date('2026-11-27T12:00:00+09:00'));
  const sheetValues = [
    HEADERS,
    ['2026-11-18 10:00:00', '', '', '', 'HPリニューアル相談', '株式会社デモ', '', '', '', '', '', '', '', '', '', '', ''],
  ];
  const calls = [];
  const result = await runWeekly({ flags: new Set(['dry-run']), dryRun: true }, {
    home,
    config,
    week,
    now: new Date('2026-11-27T12:00:00+09:00'),
    skipConfigWrite: true,
    sheetValues,
    properties: [
      { propertyId: '279040101', displayName: 'orgiast.jp', account: 'O' },
      { propertyId: '278904354', displayName: '東邦鋼業', account: 'T' },
    ],
    ga4Token: 'tok',
    token: 'bot',
    fetchImpl: async (url, init = {}) => {
      calls.push({ url: String(url), method: init.method || 'GET' });
      if (String(url).includes(':runReport')) {
        return { ok: true, json: async () => ({ rows: [{ metricValues: [{ value: '42' }] }] }) };
      }
      if (String(url).includes('/messages') && init.method === 'POST') {
        assert.fail('dry-run must not POST');
      }
      return { ok: true, json: async () => ({}) };
    },
    searchGmailImpl: async () => ({ messages: [] }),
    askLlm: async () => 'デモ要約',
    gateImpl: () => ({ changed: true, reason: 'first-run' }),
    commitImpl: () => {},
    recordRunImpl: () => {},
  });
  assert.equal(result.dryRun, true);
  assert.match(result.text, /オージャスト: 42/);
  assert.match(result.text, /リブース: 未接続/);
  assert.match(result.text, /東邦鋼業: 42/);
  assert.match(result.text, /デモ要約　株式会社デモ/);
  assert.equal(result.posted[0].dryRun, true);
  assert.ok(calls.every(c => c.method !== 'POST' || !String(c.url).includes('discord')));
});

test('runUnanswered dry-run and dedupe state', async () => {
  const home = tmpHome();
  fs.mkdirSync(path.join(home, '.claude', 'state'), { recursive: true });
  const config = { channelId: '1382930142011326566', unansweredMaxAgeDays: 14, sites: [] };
  const sheetValues = [
    HEADERS,
    ['2026-11-20 10:00:00', '', '', '', '放置案件の本文', '放置社', '', '', '', '', '', '', '対応中', '', '', '', ''],
    ['2026-10-23 10:00:00', '', '', '', '突然のご連絡失礼いたします', 'INVERSE HD株式会社', '', '', '', '', '', '', '', '', '', '', ''],
    ['2026-04-12 10:00:00', '', '', '', 'アラート通知テストです', '検証', '', '', '', '', '', '', '', '', '', '', ''],
  ];
  const result = await runUnanswered({ flags: new Set(['dry-run']), dryRun: true }, {
    home,
    config,
    sheetValues,
    now: new Date('2026-11-27T12:00:00+09:00'),
    token: 'bot',
    state: { notifiedUnanswered: {} },
    skipStateWrite: true,
    gateImpl: () => ({ changed: true, reason: 'first-run' }),
    commitImpl: () => {},
    recordRunImpl: () => {},
    fetchImpl: async () => assert.fail('no fetch'),
  });
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].company, '放置社');
  assert.match(result.text, /対応漏れ検知/);
  assert.match(result.text, /24時間超〜14日以内/);
  assert.equal(result.posted[0].dryRun, true);

  const skipped = await runUnanswered({ flags: new Set(['dry-run']), dryRun: true }, {
    home, config, sheetValues,
    now: new Date('2026-11-27T12:00:00+09:00'),
    state: { notifiedUnanswered: { '2': 'already' } },
    skipStateWrite: true,
    gateImpl: () => ({ changed: false, reason: 'empty' }),
    recordRunImpl: () => {},
  });
  assert.equal(skipped.skipped, 'none');
});

test('parseArgs', () => {
  const a = parseArgs(['--dry-run', '--check-unanswered', '--config', 'x.json']);
  assert.ok(a.flags.has('dry-run'));
  assert.ok(a.flags.has('check-unanswered'));
  assert.equal(a.config, 'x.json');
});

test('completed status annotations and exact 24h are not overdue', () => {
  const now = Date.parse('2026-11-27T12:00:00+09:00');
  const row = (date, status) => [date, '', '', '', '相談', 'A社', '', '', '', '', '', '', status];
  const values = [HEADERS, row('2026-11-20', '完了（案件問合せ）'), row('2026-11-20', '完了 (採用)'), row('2026-11-26 12:00:00', ''), row('2026-11-20', '未完了')];
  assert.deepEqual(unansweredRows(values, { now, maxAgeMs: 14 * 24 * 3600 * 1000 }).map(r => r.row), [5]);
});

test('successful AI summaries stay within 30 characters', async () => {
  const result = await summarizeInquiries([{ body: '相談' }], { askLlm: async () => 'あ'.repeat(80) });
  assert.equal(result[0].summary.length, 30);
});

test('unknown inquiry connection is never rendered as zero inquiries', () => {
  const text = formatWeeklyMessage({ week: { label: '11/16〜11/22' }, sites: [{ id: 'x', name: 'X', status: 'ok', sessions: 2, pct: 0, inquiryStatus: 'unconnected', inquiryReason: '通知先未確認' }], inquiriesBySite: {} });
  assert.match(text, /【X】未接続（通知先未確認）/);
  assert.doesNotMatch(text, /0件|・なし/);
});

test('unanswered runs at most once per JST day', async () => {
  const result = await runUnanswered({ dryRun: true }, {
    config: { sites: [] }, now: new Date('2026-11-27T23:00:00+09:00'),
    state: { lastUnansweredAt: '2026-11-27T01:00:00Z', notifiedUnanswered: {} },
    readSheetImpl: async () => assert.fail('already sent today'),
  });
  assert.equal(result.skipped, 'already-today');
});

test('Gmail collects all pages and includes JST Monday midnight', async () => {
  const { collectInquiries } = await import('./site-weekly-report.mjs');
  const week = weekRange(new Date('2026-11-27T12:00:00+09:00'));
  let calls = 0;
  const result = await collectInquiries({ sites: [{ id: 'x', inquirySource: 'gmail', gmailQuery: 'from:form@example.com' }] }, week, {
    searchGmailImpl: async ({ pageToken, query }) => {
      calls++;
      assert.match(query, new RegExp(`after:${week.startMs / 1000 - 1}`));
      return { messages: [{ id: pageToken || 'first', internalDate: String(week.startMs), body: '相談' }], nextPageToken: pageToken ? null : 'second' };
    },
  });
  assert.equal(calls, 2);
  assert.equal(result.bySite.x.length, 2);
});

test('Admin discovery failure does not block configured GA4 metrics', async () => {
  const { collectSiteMetrics } = await import('./site-weekly-report.mjs');
  const result = await collectSiteMetrics({ sites: [{ id: 'x', propertyId: '123' }] }, weekRange(), {
    ga4Token: 'mock', fetchImpl: async url => String(url).includes('accountSummaries')
      ? { ok: false, json: async () => ({ error: { message: 'no admin access' } }) }
      : { ok: true, json: async () => ({ rows: [{ metricValues: [{ value: '17' }] }] }) },
  });
  assert.equal(result.sites[0].sessions, 17);
});

test('GA4 discovery follows pages', async () => {
  const { listGa4Properties } = await import('./site-weekly-report.mjs');
  const result = await listGa4Properties({ token: 'mock', fetchImpl: async url => ({ ok: true, json: async () => ({
    accountSummaries: [{ propertySummaries: [{ property: String(url).includes('pageToken=') ? 'properties/2' : 'properties/1' }] }],
    nextPageToken: String(url).includes('pageToken=') ? null : 'next',
  }) }) });
  assert.deepEqual(result.map(p => p.propertyId), ['1', '2']);
});
