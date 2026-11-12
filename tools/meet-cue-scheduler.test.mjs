import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  isTargetEvent,
  checkMechanicalConditions,
  buildClassificationJevState,
  buildClassificationJevQuestions,
  isOptInEvent,
  classifyEvent,
  deduplicateEvents,
  isExternalEmail,
  extractMeetInfo,
  buildCompanionEventBody,
  createOrUpdateCompanionEvent,
  findSeisakuProfileName,
  runScheduler,
} from './meet-cue-scheduler.mjs';

import { copyProfileFromChrome } from './meet-cue.mjs';
import { findHeaderInsertIndex } from './lib/meet-cue-doc.mjs';

test('isExternalEmail: 社外ドメインと staff-addresses の判定', () => {
  const staff = ['personal@gmail.com'];
  assert.equal(isExternalEmail('tanaka@orgiast.jp', staff), false, 'orgiast.jp は社内');
  assert.equal(isExternalEmail('personal@gmail.com', staff), false, 'staff-addresses にあるメールは除外');
  assert.equal(isExternalEmail('client@example.com', staff), true, '社外メールは true');
  assert.equal(isExternalEmail('', staff), false, '空文字は false');
});

test('extractMeetInfo: Meet URL と会議コードの抽出', () => {
  const event1 = { hangoutLink: 'https://meet.google.com/abc-defg-hij' };
  const info1 = extractMeetInfo(event1);
  assert.equal(info1.conferenceCode, 'abc-defg-hij');
  assert.equal(info1.meetUrl, 'https://meet.google.com/abc-defg-hij');

  const event2 = {
    conferenceData: {
      entryPoints: [{ entryPointType: 'video', uri: 'https://meet.google.com/xyz-uvwx-rst' }],
      conferenceId: 'xyz-uvwx-rst',
    },
  };
  const info2 = extractMeetInfo(event2);
  assert.equal(info2.conferenceCode, 'xyz-uvwx-rst');
});

test('isTargetEvent: 対象予定の厳格なフィルター判定', () => {
  const now = new Date('2026-11-12T10:00:00.000Z');
  const staffAddresses = ['staff-personal@gmail.com'];

  const validEvent = {
    status: 'confirmed',
    summary: '〇〇社様 AI導入打合せ',
    hangoutLink: 'https://meet.google.com/abc-defg-hij',
    start: { dateTime: '2026-11-12T10:30:00.000Z' },
    end: { dateTime: '2026-11-12T11:30:00.000Z' },
    attendees: [
      { email: 'tanaka@orgiast.jp' },
      { email: 'client@example.com' },
    ],
  };

  assert.equal(isTargetEvent(validEvent, { staffAddresses, now }), true, '条件を満たす打合せは対象');

  // Case 1: Internal only (no external attendees) - mechanical check passes (handed to Jev)
  const internalEvent = {
    ...validEvent,
    attendees: [{ email: 'tanaka@orgiast.jp' }, { email: 'kim@orgiast.jp' }],
  };
  assert.equal(isTargetEvent(internalEvent, { staffAddresses, now }), true, '社外参加者無しの機械条件判定は true（Jev に任せる）');

  // Case 2: Contains "カンペ不要" or "no-kanpe"
  const noKanpe1 = { ...validEvent, summary: '社外打合せ（カンペ不要）' };
  const noKanpe2 = { ...validEvent, description: 'no-kanpe でお願いします' };
  assert.equal(isTargetEvent(noKanpe1, { staffAddresses, now }), false, '「カンペ不要」は対象外');
  assert.equal(isTargetEvent(noKanpe2, { staffAddresses, now }), false, '「no-kanpe」は対象外');

  // Case 3: Cancelled status
  const cancelledEvent = { ...validEvent, status: 'cancelled' };
  assert.equal(isTargetEvent(cancelledEvent, { staffAddresses, now }), false, 'キャンセル済みは対象外');

  // Case 4: Private / confidential visibility
  const privateEvent = { ...validEvent, visibility: 'private' };
  assert.equal(isTargetEvent(privateEvent, { staffAddresses, now }), false, '非公開予定は対象外');

  // Case 5: Missing Meet link
  const noMeetEvent = { ...validEvent, hangoutLink: '' };
  assert.equal(isTargetEvent(noMeetEvent, { staffAddresses, now }), false, 'Meet リンク無しは対象外');

  // Case 6: Outside 24h window (30 hours later)
  const farFutureEvent = {
    ...validEvent,
    start: { dateTime: '2026-11-13T17:00:00.000Z' },
  };
  assert.equal(isTargetEvent(farFutureEvent, { staffAddresses, now }), false, '24時間外は対象外');
});

test('deduplicateEvents: 会議コードによる重複排除', () => {
  const ev1 = {
    event: {
      summary: 'カレンダーA',
      hangoutLink: 'https://meet.google.com/abc-defg-hij',
      start: { dateTime: '2026-11-12T10:00:00.000Z' },
    },
    calendarId: 'kim@orgiast.jp',
  };
  const ev2 = {
    event: {
      summary: 'カレンダーB',
      hangoutLink: 'https://meet.google.com/abc-defg-hij',
      start: { dateTime: '2026-11-12T10:00:00.000Z' },
    },
    calendarId: 'seisaku-team@orgiast.jp',
  };

  const deduplicated = deduplicateEvents([ev1, ev2]);
  assert.equal(deduplicated.length, 1, '同じ Meet コード・時刻の予定は1件に統合');
  assert.equal(deduplicated[0].calendarId, 'kim@orgiast.jp');
});

test('buildCompanionEventBody: 社外・個人 Gmail が参加者に入らず private, transparent, extendedProperties が設定されること', () => {
  const originalEvent = {
    id: 'orig123',
    summary: '〇〇社商談',
    start: { dateTime: '2026-11-12T10:00:00.000Z' },
    end: { dateTime: '2026-11-12T11:00:00.000Z' },
  };

  const docUrl = 'https://docs.google.com/document/d/doc123/edit';
  const orgiastAttendees = ['tanaka@orgiast.jp', 'kim@orgiast.jp'];

  const companion = buildCompanionEventBody({ originalEvent, docUrl, orgiastAttendees });

  assert.equal(companion.summary, '📝カンペ: 〇〇社商談');
  assert.match(companion.description, /doc123/);
  assert.equal(companion.visibility, 'private');
  assert.equal(companion.transparency, 'transparent');
  assert.equal(companion.extendedProperties.private.meetCueSource, 'orig123');
  assert.deepEqual(companion.attendees, [{ email: 'tanaka@orgiast.jp' }, { email: 'kim@orgiast.jp' }]);
});

test('createOrUpdateCompanionEvent: 冪等性（既存があれば再作成しない）', async () => {
  const token = 'fake-token';
  const calendarId = 'tanaka@orgiast.jp';
  const originalEvent = {
    id: 'orig999',
    summary: '打合せ',
    start: { dateTime: '2026-11-12T10:00:00.000Z' },
    end: { dateTime: '2026-11-12T11:00:00.000Z' },
  };

  let postCount = 0;
  const mockFetch = async (url, opts = {}) => {
    if (url.includes('privateExtendedProperty=')) {
      return {
        ok: true,
        json: async () => ({
          items: [{
            id: 'existing-companion-1',
            summary: '📝カンペ: 打合せ',
            start: { dateTime: '2026-11-12T10:00:00.000Z' },
            end: { dateTime: '2026-11-12T11:00:00.000Z' },
          }],
        }),
      };
    }
    if (opts.method === 'POST') {
      postCount++;
      return { ok: true, json: async () => ({ id: 'new-companion' }) };
    }
    return { ok: true, json: async () => ({ id: 'existing-companion-1' }) };
  };

  const companion = await createOrUpdateCompanionEvent({
    token,
    calendarId,
    originalEvent,
    docUrl: 'https://docs.google.com/...',
    orgiastAttendees: ['tanaka@orgiast.jp'],
    fetchImpl: mockFetch,
  });

  assert.equal(companion.id, 'existing-companion-1');
  assert.equal(postCount, 0, '既存があるため POST は呼ばれない');
});

test('findSeisakuProfileName: Chrome Local State から seisaku-team の Profile 名を特定', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-user-data-'));
  const localState = {
    profile: {
      info_cache: {
        'Profile 1': { user_name: 'other@gmail.com' },
        'Profile 2': { user_name: 'seisaku-team@orgiast.jp' },
      },
    },
  };

  fs.writeFileSync(path.join(tmpDir, 'Local State'), JSON.stringify(localState), 'utf8');

  const profileName = findSeisakuProfileName(tmpDir);
  assert.equal(profileName, 'Profile 2');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('copyProfileFromChrome: Cookies ロック時に exit code 75 で失敗を返すこと', () => {
  const tmpAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'appdata-test-'));
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'home-test-'));
  const profileDir = path.join(tmpAppData, 'Google', 'Chrome', 'User Data', 'Profile 2');
  fs.mkdirSync(path.join(profileDir, 'Network'), { recursive: true });

  const result = copyProfileFromChrome('Profile 2', { home: tmpHome, localAppData: tmpAppData, isCookiesLocked: true });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'chrome_running');
  assert.equal(result.code, 75);

  fs.rmSync(tmpAppData, { recursive: true, force: true });
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

test('findHeaderInsertIndex: 区切り線から挿入位置を算出', async () => {
  const mockApi = async (token, url) => {
    return {
      ok: true,
      json: async () => ({
        body: {
          content: [
            { paragraph: { elements: [{ textRun: { content: '【Meetカンペ】打合せ\n' } }] } },
            { paragraph: { elements: [{ textRun: { content: '----------------------------------------\n' } }] }, endIndex: 150 },
          ],
        },
      }),
    };
  };

  const index = await findHeaderInsertIndex({
    docId: 'test-doc',
    getToken: async () => 'fake-token',
    api: mockApi,
  });

  assert.equal(index, 150, '区切り線の直後の endIndex (150) が返ること');
});

test('runScheduler: seatHostname 不一致で何もせずスキップ', async () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'meet-cue-home-'));
  const configPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'config', 'meet-cue.json');

  const originalConfig = fs.readFileSync(configPath, 'utf8');
  try {
    const customConfig = JSON.parse(originalConfig);
    customConfig.seatHostname = 'NON_EXISTENT_HOSTNAME_123';
    fs.writeFileSync(configPath, JSON.stringify(customConfig), 'utf8');

    const res = await runScheduler({ home: tmpHome });
    assert.equal(res.ok, true);
    assert.equal(res.skipped, 'seat_hostname_mismatch');
    assert.equal(res.skippedHost, true);
    assert.deepEqual(res.actions, []);
    assert.deepEqual(res.skippedEvents, []);
  } finally {
    fs.writeFileSync(configPath, originalConfig, 'utf8');
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('runScheduler: options.hostname 注入による seatHostname 不一致のスキップ', async () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'meet-cue-home-'));
  try {
    const res = await runScheduler({ home: tmpHome, hostname: 'ci-runner-host' });
    assert.equal(res.ok, true);
    assert.equal(res.skipped, 'seat_hostname_mismatch');
    assert.equal(res.skippedHost, true);
    assert.deepEqual(res.actions, []);
    assert.deepEqual(res.skippedEvents, []);
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

function createMockEvent(overrides = {}) {
  return {
    id: 'ev123',
    status: 'confirmed',
    summary: '〇〇社商談',
    description: '商談の件',
    hangoutLink: 'https://meet.google.com/abc-defg-hij',
    start: { dateTime: '2026-11-12T10:30:00.000Z' },
    end: { dateTime: '2026-11-12T11:30:00.000Z' },
    attendees: [
      { email: 'tanaka@orgiast.jp' },
      { email: 'client@example.com' },
    ],
    ...overrides,
  };
}

function createMockSchedulerOptions(events, askJevImpl, tmpHome) {
  const eventList = Array.isArray(events) ? events : [events];
  return {
    home: tmpHome,
    hostname: 'DESKTOP-2D0R4LI',
    deps: { hostname: 'DESKTOP-2D0R4LI' },
    now: new Date('2026-11-12T10:00:00.000Z'),
    dryRun: true,
    getToken: async () => 'fake-token',
    fetchImpl: async (url) => {
      if (url.includes('/events?')) {
        return {
          ok: true,
          json: async () => ({ items: eventList }),
        };
      }
      return { ok: true, json: async () => ({}) };
    },
    readSheet: async () => [],
    askJevImpl,
  };
}

test('buildClassificationJevState & buildClassificationJevQuestions & isOptInEvent', () => {
  const ev = createMockEvent({
    summary: '〇〇社 AI導入商談',
    description: '<p>詳細な商談内容</p>',
    attendees: [
      { email: 'tanaka@orgiast.jp' },
      { email: 'client1@client.co.jp' },
      { email: 'client2@client.co.jp' },
    ],
  });

  const state = buildClassificationJevState(ev, []);
  assert.equal(state.title, '〇〇社 AI導入商談');
  assert.equal(state.description, '詳細な商談内容');
  assert.deepEqual(state.externalDomains, ['client.co.jp']);
  assert.equal(state.internalCount, 1);
  assert.equal(state.organizerIsInternal, true);

  const questions = buildClassificationJevQuestions();
  assert.ok(questions.kind?.criteria?.customer_meeting);

  assert.equal(isOptInEvent({ summary: 'カンペ要 打合せ' }), true);
  assert.equal(isOptInEvent({ summary: 'カンペ不要 打合せ' }), false);
});

test('runScheduler Jev: community / internal は対象外', async () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'meet-cue-jev-test-'));
  try {
    const communityEvent = createMockEvent({ summary: '🧘経営者のための瞑想会' });
    const internalEvent = createMockEvent({ id: 'ev456', summary: '倉庫リーダーMTG', hangoutLink: 'https://meet.google.com/xyz-uvwx-rst' });

    let jevCallCount = 0;
    const askJevImpl = async ({ state }) => {
      jevCallCount++;
      if (state.title.includes('瞑想会')) {
        return { ok: true, answers: { kind: { type: 'choice', choice: 'community', confidence: 0.95 } } };
      }
      return { ok: true, answers: { kind: { type: 'choice', choice: 'internal', confidence: 0.9 } } };
    };

    const res = await runScheduler(createMockSchedulerOptions([communityEvent, internalEvent], askJevImpl, tmpHome));
    assert.equal(res.ok, true);
    assert.equal(res.actions.length, 0, '商談ではないため対象アクション0件');
    assert.equal(res.skipped.length, 2);
    assert.equal(res.skipped[0].reason, 'jev:community');
    assert.equal(res.skipped[1].reason, 'jev:internal');
    assert.equal(jevCallCount, 2);
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('runScheduler Jev: customer_meeting 確信度 0.9 は対象', async () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'meet-cue-jev-test-'));
  try {
    const validEvent = createMockEvent({ summary: 'M:鹿沼ケーブルテレビ小川直久様' });

    const askJevImpl = async () => ({
      ok: true,
      answers: { kind: { type: 'choice', choice: 'customer_meeting', confidence: 0.9 } },
    });

    const res = await runScheduler(createMockSchedulerOptions(validEvent, askJevImpl, tmpHome));
    assert.equal(res.ok, true);
    assert.equal(res.actions.length, 1);
    assert.deepEqual(res.actions[0].classification, {
      kind: 'customer_meeting',
      confidence: 0.9,
      source: 'jev',
    });
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('runScheduler Jev: customer_meeting 確信度 0.5 (0.7未満) は対象外', async () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'meet-cue-jev-test-'));
  try {
    const validEvent = createMockEvent({ summary: '曖昧な予定' });

    const askJevImpl = async () => ({
      ok: true,
      answers: { kind: { type: 'choice', choice: 'customer_meeting', confidence: 0.5 } },
    });

    const res = await runScheduler(createMockSchedulerOptions(validEvent, askJevImpl, tmpHome));
    assert.equal(res.ok, true);
    assert.equal(res.actions.length, 0);
    assert.equal(res.skipped.length, 1);
    assert.equal(res.skipped[0].reason, 'jev:low_confidence');
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('runScheduler Jev: Jev 失敗・タイムアウトは対象外で retry 記録', async () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'meet-cue-jev-test-'));
  try {
    const validEvent = createMockEvent({ summary: '澤山さん×オージャスト' });

    const askJevImpl = async () => ({ ok: false, reason: 'timeout' });

    const res = await runScheduler(createMockSchedulerOptions(validEvent, askJevImpl, tmpHome));
    assert.equal(res.ok, true);
    assert.equal(res.actions.length, 0);
    assert.equal(res.skipped.length, 1);
    assert.equal(res.skipped[0].reason, 'jev:failed');
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('runScheduler Jev: キャッシュ利用で2回目は Jev を呼ばない', async () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'meet-cue-jev-test-'));
  try {
    const validEvent = createMockEvent({ summary: '鈴木さんと打合せ' });
    let jevCalls = 0;

    const askJevImpl1 = async () => {
      jevCalls++;
      return { ok: true, answers: { kind: { type: 'choice', choice: 'customer_meeting', confidence: 0.95 } } };
    };

    const state = {};
    const opts1 = createMockSchedulerOptions(validEvent, askJevImpl1, tmpHome);
    opts1.state = state;
    const res1 = await runScheduler(opts1);
    assert.equal(res1.actions.length, 1);
    assert.equal(res1.actions[0].classification.source, 'jev');
    assert.equal(jevCalls, 1);

    const askJevImpl2 = async () => {
      throw new Error('Jev should not be called!');
    };

    const opts2 = createMockSchedulerOptions(validEvent, askJevImpl2, tmpHome);
    opts2.state = state;
    const res2 = await runScheduler(opts2);
    assert.equal(res2.actions.length, 1);
    assert.equal(res2.actions[0].classification.source, 'cache');
    assert.equal(jevCalls, 1, '2回目の実行で Jev は呼ばれないこと');
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('runScheduler Jev: 題名「カンペ」は optin で Jev を呼ばずに対象化', async () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'meet-cue-jev-test-'));
  try {
    const optInEvent = createMockEvent({ summary: 'カンペ要 社外プロジェクト進捗' });

    let jevCalled = false;
    const askJevImpl = async () => {
      jevCalled = true;
      return { ok: true, answers: { kind: { type: 'choice', choice: 'internal', confidence: 0.9 } } };
    };

    const res = await runScheduler(createMockSchedulerOptions(optInEvent, askJevImpl, tmpHome));
    assert.equal(res.ok, true);
    assert.equal(res.actions.length, 1);
    assert.deepEqual(res.actions[0].classification, {
      kind: 'customer_meeting',
      confidence: 1.0,
      source: 'optin',
    });
    assert.equal(jevCalled, false, 'オプトイン時は Jev を呼ばないこと');
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('runScheduler Jev: 社外参加者なしでも題名「M:○○株式会社様」は customer_meeting 0.9 で対象になり、「倉庫リーダーMTG」は internal で対象外', async () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'meet-cue-no-external-jev-test-'));
  try {
    const customerEventNoExternal = createMockEvent({
      id: 'ev_cust_1',
      summary: 'M:岩谷マテリアル株式会社様(Reブース)',
      hangoutLink: 'https://meet.google.com/abc-defg-hij',
      attendees: [{ email: 'tanaka@orgiast.jp' }, { email: 'kim@orgiast.jp' }],
    });
    const internalEventNoExternal = createMockEvent({
      id: 'ev_int_2',
      summary: '倉庫リーダーMTG',
      hangoutLink: 'https://meet.google.com/xyz-uvwx-rst',
      attendees: [{ email: 'tanaka@orgiast.jp' }, { email: 'kim@orgiast.jp' }],
    });

    const askJevImpl = async ({ state }) => {
      assert.equal(state.hasExternalAttendees, false);
      assert.deepEqual(state.externalAttendeeDomains, []);
      if (state.title.includes('岩谷マテリアル')) {
        return { ok: true, answers: { kind: { type: 'choice', choice: 'customer_meeting', confidence: 0.9 } } };
      }
      return { ok: true, answers: { kind: { type: 'choice', choice: 'internal', confidence: 0.9 } } };
    };

    const res = await runScheduler(createMockSchedulerOptions([customerEventNoExternal, internalEventNoExternal], askJevImpl, tmpHome));
    assert.equal(res.ok, true);
    assert.equal(res.actions.length, 1);
    assert.equal(res.actions[0].title, 'M:岩谷マテリアル株式会社様(Reブース)');
    assert.equal(res.actions[0].classification.kind, 'customer_meeting');

    assert.equal(res.skipped.length, 1);
    assert.equal(res.skipped[0].title, '倉庫リーダーMTG');
    assert.equal(res.skipped[0].reason, 'jev:internal');
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('runScheduler: Meetリンクが無い予定（no_meet）は題名に「様」があっても除外される', async () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'meet-cue-no-meet-test-'));
  try {
    const noMeetCustomerEvent = createMockEvent({
      summary: 'M:クラフトフィックス様(訪問)',
      hangoutLink: '',
    });

    const res = await runScheduler(createMockSchedulerOptions(noMeetCustomerEvent, async () => {}, tmpHome));
    assert.equal(res.ok, true);
    assert.equal(res.actions.length, 0);
    assert.equal(res.skipped.length, 1);
    assert.equal(res.skipped[0].reason, 'no_meet');
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});
