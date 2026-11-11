import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isTargetEvent,
  isStaff,
  extractCompanyName,
  identifyRecipient,
  shouldSendReminder,
  isQuietHours,
  formatSubject,
  formatBody,
  buildAddressName,
  checkGmailSent,
  processEvents,
} from './meeting-url-notice.mjs';

const mockConfig = {
  userEmail: 'kim@orgiast.jp',
  teamEmail: 'seisaku-team@orgiast.jp',
  staffAddresses: ['taka05250925@gmail.com', 'meropp.16@gmail.com'],
  autoSendApproved: false,
  templates: {
    firstNotice: {
      subject: '【会議URLのご案内】{date}（{dow}）{time}〜 オンラインお打ち合わせ（株式会社オージャスト）',
      body: '{addressName}\n\nお世話になっております。\n\nURL：\n{meetUrl}\n\n--\n{signature}',
    },
    reminder: {
      subject: '【リマインド】明日{date}（{dow}）{time}〜 オンラインお打ち合わせ（株式会社オージャスト）',
      body: '{addressName}\n\nお世話になっております。\n\nURL：\n{meetUrl}\n\n--\n{signature}',
    },
  },
  signatures: {
    rebooth: '株式会社オージャスト\n澤山',
    default: '株式会社オージャスト\n制作チーム',
  },
};

test('isTargetEvent — 社外打合せ判定と除外フィルタ', () => {
  const validEvent = {
    summary: 'M: デージーネット様(Reブース)',
    status: 'confirmed',
    start: { dateTime: '2026-11-15T10:00:00+09:00' },
    end: { dateTime: '2026-11-15T11:00:00+09:00' },
    hangoutLink: 'https://meet.google.com/abc-defg-hij',
  };
  assert.equal(isTargetEvent(validEvent), true);

  // 様なし除外
  assert.equal(isTargetEvent({ ...validEvent, summary: 'M: デージーネット' }), false);

  // 社内/事前/準備/面談/定例/朝礼 除外
  assert.equal(isTargetEvent({ ...validEvent, summary: '事前MTG：デージーネット様' }), false);
  assert.equal(isTargetEvent({ ...validEvent, summary: '【定例】デージーネット様' }), false);
  assert.equal(isTargetEvent({ ...validEvent, summary: 'オンライン面談：山田様' }), false);
  assert.equal(isTargetEvent({ ...validEvent, summary: '社内MTG：デージーネット様' }), false);

  // キャンセル除外
  assert.equal(isTargetEvent({ ...validEvent, status: 'cancelled' }), false);

  // Meet URL なし除外
  assert.equal(isTargetEvent({ ...validEvent, hangoutLink: null }), false);
});

test('isStaff — 社員アドレス判定', () => {
  assert.equal(isStaff('kim@orgiast.jp', mockConfig), true);
  assert.equal(isStaff('seisaku-team@orgiast.jp', mockConfig), true);
  assert.equal(isStaff('taka05250925@gmail.com', mockConfig), true);
  assert.equal(isStaff('client@example.com', mockConfig), false);
});

test('extractCompanyName — 会社名抽出', () => {
  assert.equal(extractCompanyName(' M:岩谷マテリアル株式会社様(Reブース)'), '岩谷マテリアル株式会社');
  assert.equal(extractCompanyName('M: 株式会社 デージーネット様(Reブース)'), '株式会社 デージーネット');
  assert.equal(extractCompanyName('M: Gastronomy Japan株式会社様'), 'Gastronomy Japan株式会社');
  assert.equal(extractCompanyName('社内研修'), null);
});

test('identifyRecipient — (a) 参加者から特定', () => {
  const event = { summary: 'M: テスト様', hangoutLink: 'https://meet.google.com/abc-defg-hij' };
  const attendees = [
    { email: 'kim@orgiast.jp', self: true },
    { email: 'client@example.com', displayName: 'Client Name' },
  ];
  const res = identifyRecipient(event, mockConfig, { attendees });
  assert.equal(res.method, 'a');
  assert.equal(res.email, 'client@example.com');
  assert.equal(res.displayName, 'Client Name');
});

test('identifyRecipient — (b) Gmail メッセージから特定', () => {
  const event = { summary: 'M: テスト様', hangoutLink: 'https://meet.google.com/abc-defg-hij' };
  const gmailMessages = [
    { id: 'm1', from: 'Client <client@external.com>', to: 'seisaku-team@orgiast.jp' },
  ];
  const res = identifyRecipient(event, mockConfig, { attendees: [], gmailMessages });
  assert.equal(res.method, 'b');
  assert.equal(res.email, 'client@external.com');
});

test('identifyRecipient — 曖昧な場合 (needs_recipient)', () => {
  const event = { summary: 'M: テスト様', hangoutLink: 'https://meet.google.com/abc-defg-hij' };
  const res = identifyRecipient(event, mockConfig, { attendees: [], gmailMessages: [], recentThreads: [] });
  assert.equal(res.email, null);
  assert.equal(res.method, null);
});

test('checkGmailSent — 送付済み判定と fail-closed', async () => {
  const sent = await checkGmailSent({
    meetCode: 'abc-defg-hij',
    recipientEmail: 'client@example.com',
    gmailChecker: async () => [{ payload: { headers: [{ name: 'subject', value: '【会議URLのご案内】11月10日...' }] } }],
  });
  assert.equal(sent.firstNoticeSent, true);
  assert.equal(sent.reminderSent, false);

  // エラー時は fail-closed (送らない)
  const failed = await checkGmailSent({
    meetCode: 'abc-defg-hij',
    recipientEmail: 'client@example.com',
    gmailChecker: async () => { throw new Error('Network error'); },
  });
  assert.equal(failed.firstNoticeSent, true);
  assert.equal(failed.reminderSent, true);
  assert.notEqual(failed.queryError, null);
});

test('shouldSendReminder & isQuietHours — リマインド時刻判定と深夜抑止', () => {
  // 11/15 10:00 の予定
  const startMs = Date.parse('2026-11-15T10:00:00+09:00');
  const event = { start: { dateTime: '2026-11-15T10:00:00+09:00' } };

  // 前日 11/14 09:00 (JST) -> まだ早い
  const earlyMs = Date.parse('2026-11-14T09:00:00+09:00');
  assert.equal(shouldSendReminder(event, earlyMs), false);

  // 前日 11/14 10:30 (JST) -> リマインド対象
  const remMs = Date.parse('2026-11-14T10:30:00+09:00');
  assert.equal(shouldSendReminder(event, remMs), true);

  // 深夜判定
  const nightMs = Date.parse('2026-11-14T22:00:00+09:00');
  assert.equal(isQuietHours(nightMs), true);

  const dayMs = Date.parse('2026-11-14T14:00:00+09:00');
  assert.equal(isQuietHours(dayMs), false);
});

test('formatSubject & formatBody — 文面生成と署名切替', () => {
  const event = {
    summary: 'M: デージーネット様(Reブース)',
    start: { dateTime: '2026-11-17T14:00:00+09:00' },
    hangoutLink: 'https://meet.google.com/abc-defg-hij',
  };

  const subj = formatSubject('firstNotice', event);
  assert.equal(subj, '【会議URLのご案内】11月17日（火）14:00〜 オンラインお打ち合わせ（株式会社オージャスト）');

  const addr = buildAddressName({ displayName: '' }, '株式会社 デージーネット');
  const body = formatBody('firstNotice', event, mockConfig, addr);
  assert.match(body, /株式会社 デージーネット\nご担当者様/);
  assert.match(body, /株式会社オージャスト\n澤山/); // Reブース署名
});

test('processEvents — 統合処理フロー', async () => {
  const now = Date.parse('2026-11-10T10:00:00+09:00');
  const events = {
    e1: {
      summary: 'M: テスト様',
      start: { dateTime: '2026-11-12T10:00:00+09:00' },
      hangoutLink: 'https://meet.google.com/abc-defg-hij',
      attendees: [{ email: 'client@example.com', displayName: 'Client Name' }],
    },
  };

  const results = await processEvents({
    events,
    config: mockConfig,
    ledger: [],
    now,
    deps: {
      checkGmail: async () => ({ firstNoticeSent: false, reminderSent: false, queryError: null }),
      processEvent: async ({ kind, recipientEmail, subject, body }) => ({
        judgment: 'needs_send', kind, subject, bodyPreview: body.slice(0, 50),
      }),
    },
  });

  assert.equal(results.length, 1);
  assert.equal(results[0].recipient, 'client@example.com');
  assert.equal(results[0].judgment, 'needs_send');
});
