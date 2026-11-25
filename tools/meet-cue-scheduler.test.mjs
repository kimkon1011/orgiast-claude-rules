import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
  deliverCueUrl,
  findSeisakuProfileName,
  runScheduler,
  botLoginPath,
  loadSchedulerState,
  saveSchedulerState,
  readConfig,
  JOIN_WINDOW_BEFORE_MS,
  JOIN_WINDOW_AFTER_MS,
  JOIN_ERROR_COOLDOWN_MS,
} from './meet-cue-scheduler.mjs';

import { copyProfileFromChrome } from './meet-cue.mjs';
import { GREETING_LINE } from './lib/meet-cue-core.mjs';
import { findHeaderInsertIndex, insertGreetingIfNeeded } from './lib/meet-cue-doc.mjs';

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
  try {
    const res = await runScheduler({
      home: tmpHome,
      hostname: '000KimPC',
      config: { seatHostname: 'NON_EXISTENT_HOSTNAME_123' },
    });
    assert.equal(res.ok, true);
    assert.equal(res.skipped, 'seat_hostname_mismatch');
    assert.equal(res.skippedHost, true);
    assert.deepEqual(res.actions, []);
    assert.deepEqual(res.skippedEvents, []);
  } finally {
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

test('runScheduler: 新旧の席ホスト名をどちらも許可する', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'meet-cue-home-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const config = readConfig();
  assert.deepEqual(config.seatHostnames, ['kim-PC']);
  for (const hostname of ['000KimPC', 'desktop-2d0r4li']) {
    const res = await runScheduler({ home, hostname, config: { ...config, enabled: false } });
    assert.equal(res.skipped, 'disabled');
  }
  const legacy = await runScheduler({
    home,
    hostname: 'desktop-2d0r4li',
    config: { seatHostname: 'DESKTOP-2D0R4LI', enabled: false },
  });
  assert.equal(legacy.skipped, 'disabled');
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

test('参加窓の境界（-5分/+15分）の定数および判定の動作検証', () => {
  assert.equal(JOIN_WINDOW_BEFORE_MS, 5 * 60 * 1000, '開始5分前 (300,000ms)');
  assert.equal(JOIN_WINDOW_AFTER_MS, 15 * 60 * 1000, '開始後15分 (900,000ms)');

  const nowMs = new Date('2026-11-12T10:00:00.000Z').getTime();

  // Exactly -5 minutes (10:05 event when now is 10:00) -> in join window
  const eventInWindowStart = createMockEvent({
    start: { dateTime: new Date(nowMs + JOIN_WINDOW_BEFORE_MS).toISOString() },
    end: { dateTime: new Date(nowMs + 60 * 60 * 1000).toISOString() },
  });
  const mechStart = checkMechanicalConditions(eventInWindowStart, { now: new Date(nowMs) });
  assert.equal(mechStart.ok, true);

  // Exactly +15 minutes (09:45 event when now is 10:00) -> in join window
  const eventInWindowEnd = createMockEvent({
    start: { dateTime: new Date(nowMs - JOIN_WINDOW_AFTER_MS).toISOString() },
    end: { dateTime: new Date(nowMs + 30 * 60 * 1000).toISOString() },
  });
  const mechEnd = checkMechanicalConditions(eventInWindowEnd, { now: new Date(nowMs) });
  assert.equal(mechEnd.ok, true);

  // +16 minutes ago (09:44 event when now is 10:00) -> outside window
  const eventOutsidePast = createMockEvent({
    start: { dateTime: new Date(nowMs - (JOIN_WINDOW_AFTER_MS + 60000)).toISOString() },
    end: { dateTime: new Date(nowMs + 30 * 60 * 1000).toISOString() },
  });
  const mechOutsidePast = checkMechanicalConditions(eventOutsidePast, { now: new Date(nowMs) });
  assert.equal(mechOutsidePast.ok, false);
  assert.equal(mechOutsidePast.reason, 'outside_window');
});

test('runScheduler: joinError 発生後 10 分以内の再試行抑止', async () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'meet-cue-retry-test-'));
  try {
    const nowMs = new Date('2026-11-12T10:00:00.000Z').getTime();

    const event = createMockEvent({
      summary: 'M:テスト商談様',
      start: { dateTime: new Date(nowMs + 2 * 60 * 1000).toISOString() }, // in join window
      end: { dateTime: new Date(nowMs + 60 * 60 * 1000).toISOString() },
    });

    const eventKey = 'abc-defg-hij_' + new Date(nowMs + 2 * 60 * 1000).toISOString();

    // 1. State with recent joinError (3 minutes ago)
    const stateWithRecentError = {
      [eventKey]: {
        docId: 'doc123',
        cardsFile: 'cards.json',
        joinError: 'redirected_to_landing',
        lastJoinErrorTime: nowMs - 3 * 60 * 1000,
      },
    };

    const askJevImpl = async () => ({
      ok: true,
      answers: { kind: { type: 'choice', choice: 'customer_meeting', confidence: 0.9 } },
    });

    const optsRecent = createMockSchedulerOptions(event, askJevImpl, tmpHome);
    optsRecent.now = new Date(nowMs);
    optsRecent.dryRun = false;
    optsRecent.state = stateWithRecentError;

    const resRecent = await runScheduler(optsRecent);
    assert.equal(resRecent.ok, true);
    assert.equal(resRecent.actions.length, 1);
    assert.equal(resRecent.actions[0].actionStatus, 'join_error_cooldown', '10分以内の joinError は再試行スキップされること');

    // 2. State with old joinError (11 minutes ago) -> allowed
    const stateWithOldError = {
      [eventKey]: {
        docId: 'doc123',
        cardsFile: 'cards.json',
        joinError: 'redirected_to_landing',
        lastJoinErrorTime: nowMs - 11 * 60 * 1000,
      },
    };

    const optsOld = createMockSchedulerOptions(event, askJevImpl, tmpHome);
    optsOld.now = new Date(nowMs);
    optsOld.dryRun = true; // dryRun to prevent actual spawn
    optsOld.state = stateWithOldError;

    const resOld = await runScheduler(optsOld);
    assert.equal(resOld.ok, true);
    assert.equal(resOld.actions.length, 1);
    assert.notEqual(resOld.actions[0].actionStatus, 'join_error_cooldown', '10分経過後は join_error_cooldown にならないこと');
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

// ─── A. News behavior: append to description, DM, migration ───

test('社内主催・社内参加者のみなら元の予定の説明欄へ追記し、再実行しても増やさない', async () => {
  const calendarId = 'kim@orgiast.jp';
  const event = { id: 'internal', organizer: { email: calendarId }, description: '元の説明', etag: 'v1' };
  const itemState = { staffUrl: 'https://docs.google.com/document/d/doc123/edit' };
  let writes = 0;
  const args = {
    event, itemState, calendarId,
    getToken: async ({ impersonate }) => { assert.equal(impersonate, calendarId); return 'mock'; },
    fetchImpl: async (url, opts) => {
      writes++;
      assert.match(url, /internal\?sendUpdates=none$/);
      assert.equal(opts.method, 'PATCH');
      assert.equal(opts.headers['If-Match'], 'v1');
      const body = JSON.parse(opts.body);
      assert.deepEqual(body, { description: `元の説明\n📝カンペ（社内用）: ${itemState.staffUrl}` });
      event.description = body.description;
      return { ok: true };
    },
  };
  await deliverCueUrl(args);
  await deliverCueUrl(args);
  assert.equal(writes, 1);
});

test('社外参加者ありなら時刻に関係なく kim-inbox に一度だけ通知し DM は送らない', async () => {
  const notices = [];
  const itemState = { staffUrl: 'https://docs.google.com/document/d/doc123/edit' };
  const args = {
    event: { id: 'external', summary: '商談', organizer: { email: 'kim@orgiast.jp' },
      start: { dateTime: '2026-11-22T01:00:00Z' }, attendees: [{ email: 'client@example.com' }] },
    itemState,
    getToken: () => assert.fail('Calendar write must not be attempted'),
    sendCue: () => assert.fail('DM must not be sent'),
    addInfo: async (_, info) => notices.push(info),
  };
  await deliverCueUrl(args);
  await deliverCueUrl(args);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].kind, 'info');
  assert.match(notices[0].text, /商談/);
  assert.match(notices[0].text, /外部参加者/);
  assert.ok(notices[0].text.includes(itemState.staffUrl));
});

test('migrateCleanupCompanions: 過去と識別マーカーのない予定を除外し成功した削除を記録', async t => {
  const { migrateCleanupCompanions } = await import('./meet-cue-scheduler.mjs');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'meet-cue-migrate-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const now = new Date('2026-11-21T00:00:00Z');
  const marked = { summary: '📝カンペ: テスト', extendedProperties: { private: { meetCueSource: 'original' } } };
  const future = { ...marked, id: 'future', start: { dateTime: '2027-01-01T00:00:00Z' } };
  const deletes = [];
  const options = {
    home, now, calendars: ['kim@orgiast.jp'], getTokenImpl: async () => 'mock',
    fetchImpl: async (url, init) => {
      if (init.method === 'DELETE') {
        deletes.push(url);
        return { ok: true };
      }
      if (new URL(url).searchParams.get('pageToken')) return { ok: true, json: async () => ({ items: [future] }) };
      const items = [
        { ...future, id: 'past', start: { dateTime: '2026-11-20T23:55:00Z' } },
        { ...future, id: 'unmarked', extendedProperties: {} },
      ];
      return { ok: true, json: async () => ({ items, nextPageToken: 'page2' }) };
    },
  };
  const dry = await migrateCleanupCompanions({ ...options, dryRun: true });
  assert.deepEqual(dry.candidates.map(event => event.id), ['future']);
  assert.equal(deletes.length, 0);
  const result = await migrateCleanupCompanions(options);
  assert.equal(result.deletedCount, 1);
  assert.match(deletes[0], /future\?sendUpdates=none$/);
  const report = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'logs', 'meet-cue-companion-cleanup.json')));
  assert.deepEqual(report.deleted.map(event => event.summary), [marked.summary]);
});

test('E: 同じ eventKey の参加中 Bot が生存している場合だけ起動を抑止する', async t => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'meet-cue-dup-test-'));
  t.after(() => fs.rmSync(tmpHome, { recursive: true, force: true }));
  const now = new Date('2026-11-12T10:00:00.000Z');
  const start = new Date(+now + 120000).toISOString();
  const event = createMockEvent({
    start: { dateTime: start },
    end: { dateTime: new Date(+now + 3600000).toISOString() },
  });
  const eventKey = `abc-defg-hij_${start}`;
  const sessionId = '20261112-100000-1234';
  const sessionDir = path.join(tmpHome, '.claude', 'meet-cue', sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });
  const opts = createMockSchedulerOptions(event, async () => ({
    ok: true,
    answers: { kind: { type: 'choice', choice: 'customer_meeting', confidence: 0.9 } },
  }), tmpHome);
  opts.now = now;
  opts.dryRun = true;
  opts.state = { [eventKey]: { docId: 'doc123', cardsFile: 'cards.json' } };
  const cases = [
    [{}, true],
    [{ joinState: 'prejoin' }, true],
    [{ joinState: 'in_lobby' }, true],
    [{ pid: 999999999 }, false],
    [{ endReason: 'meeting_ended' }, false],
    [{ eventKey: 'another-event' }, false],
  ];
  for (const [overrides, running] of cases) {
    fs.writeFileSync(path.join(sessionDir, 'session.json'), JSON.stringify({
      sessionId, eventKey, pid: process.pid, joinState: 'in_call', ...overrides,
    }));
    const result = await runScheduler(opts);
    assert.equal(result.actions.length, 1);
    assert.equal(result.actions[0].actionStatus === 'running', running);
  }
});

test('F: 既存 Doc の見出し直下に太字の案内を一度だけ挿入する', async () => {
  const heading = '【Meetカンペ】打合せ🍵\n';
  const makeParagraph = (text, startIndex) => ({
    startIndex,
    endIndex: startIndex + text.length,
    paragraph: { elements: [{ textRun: { content: text } }] },
  });
  const doc = {
    revisionId: 'revision-1',
    body: { content: [makeParagraph(heading, 1), makeParagraph('日時: ...\n', heading.length + 1)] },
  };
  const updates = [];
  const opts = {
    docId: 'test-doc-id',
    getToken: async () => 'fake-token',
    api: async (_token, url, opts) => {
      if (url.endsWith(':batchUpdate')) {
        const update = JSON.parse(opts.body);
        updates.push(update);
        const { location, text } = update.requests[0].insertText;
        doc.body.content.splice(1, 0, makeParagraph(text, location.index));
      }
      return { json: async () => doc };
    },
  };
  assert.deepEqual(await insertGreetingIfNeeded(opts), { inserted: true });
  assert.deepEqual(await insertGreetingIfNeeded(opts), { inserted: false });
  assert.equal(updates.length, 1);
  const [{ requests, writeControl }] = updates;
  const index = heading.length + 1;
  assert.deepEqual(writeControl, { requiredRevisionId: 'revision-1' });
  assert.deepEqual(requests[0].insertText, { location: { index }, text: `${GREETING_LINE}\n\n` });
  assert.equal(requests[1].updateTextStyle.textStyle.bold, true);
  assert.deepEqual(requests[1].updateTextStyle.range, { startIndex: index, endIndex: index + GREETING_LINE.length });
});

test('F: スケジューラは台帳にある開始前の Doc を準備時に一度だけ更新する', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'meet-cue-greeting-test-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const future = 'abc-defg-hij_2026-11-12T11:00:00.000Z';
  const past = 'abc-defg-hij_2026-11-12T09:00:00.000Z';
  saveSchedulerState({ [future]: { docId: 'future' }, [past]: { docId: 'past' } }, home);
  fs.writeFileSync(botLoginPath(home), JSON.stringify({ ok: true }));

  const checkedDocs = [];
  const opts = {
    ...createMockSchedulerOptions([], async () => assert.fail('Jev を呼ばない'), home),
    dryRun: false,
    insertGreetingIfNeeded: async ({ docId }) => checkedDocs.push(docId),
  };
  assert.equal((await runScheduler(opts)).ok, true);
  assert.equal(loadSchedulerState(home)[future].greetingChecked, true);
  assert.equal((await runScheduler(opts)).ok, true);
  assert.deepEqual(checkedDocs, ['future']);
});

test('個人 Gmail 主催は書き込まず失敗通知を一度だけ記録し DM は送らない', async () => {
  const itemState = { staffUrl: 'https://docs.google.com/document/d/doc123/edit' };
  const sent = [], notices = [];
  const now = new Date('2026-11-25T01:50:00Z');
  const args = { itemState, now, event: { organizer: { email: 'waki.toho@gmail.com' }, start: { dateTime: '2026-11-25T02:00:00Z' }, attendees: [{ email: 'kim@orgiast.jp' }] },
    getToken: () => assert.fail('DWD 不可'), addInfo: async (_, info) => notices.push(info), sendCue: async ({ staffEmail }) => sent.push(staffEmail) };
  await deliverCueUrl(args);
  await deliverCueUrl(args);
  assert.equal(itemState.cueUrlWriteFailed, true);
  assert.equal(itemState.needsClientRemoval, false);
  assert.equal(notices.length, 1);
  assert.deepEqual(sent, []);
  assert.ok(notices[0].text.includes(itemState.staffUrl));
});

test('主催者カレンダーを選択して古いカンペ行を更新する', async () => {
  const event = { id: 'event', organizer: { email: 'seisaku-team@orgiast.jp' }, description: '説明\n📝カンペ（社内用）: old\n📝カンペ（社内用）: old2', attendees: [{ email: 'waki.toho@gmail.com' }] };
  const itemState = { staffUrl: 'https://docs.google.com/document/d/doc123/edit' };
  let patches = 0;
  await deliverCueUrl({ event, itemState, calendarId: 'kim@orgiast.jp', getToken: async ({ impersonate }) => { assert.equal(impersonate, 'seisaku-team@orgiast.jp'); return 'token'; }, fetchImpl: async (url, opts) => {
    assert.match(url, /seisaku-team%40orgiast.jp/);
    if (opts.method === 'PATCH') { patches++; assert.equal(JSON.parse(opts.body).description, `説明\n📝カンペ（社内用）: ${itemState.staffUrl}`); }
    return { ok: true, json: async () => event };
  } });
  assert.equal(patches, 1);
  assert.equal(itemState.cueUrlAppended, true);
});

test('report-client-invites: 今後の社内主催 Meet の顧客招待だけを重複なく抽出する', async () => {
  const { reportClientInvites } = await import('./meet-cue-scheduler.mjs');
  const now = new Date('2026-11-25T00:00:00Z');
  const base = { id: 'one', iCalUID: 'one', summary: '商談', description: '社内カンペ https://docs.google.com/document/d/secret/edit', organizer: { email: 'kim@orgiast.jp' }, start: { dateTime: '2026-11-26T00:00:00Z' }, hangoutLink: 'https://meet.google.com/abc-defg-hij', attendees: [{ email: 'waki.toho@gmail.com' }, { email: 'client@example.com' }] };
  const result = await reportClientInvites({ now, getToken: async () => 'mock', fetchImpl: async (url, init) => {
    assert.equal(init.method, undefined);
    return { ok: true, json: async () => url.includes('admin.googleapis.com') ? { users: [] } : { items: [
      base, { ...base, id: 'external', organizer: { email: 'client@example.com' } },
      { ...base, id: 'internal', attendees: [{ email: 'waki.toho@gmail.com' }] },
      { ...base, id: 'past', start: { dateTime: '2026-11-24T23:59:00Z' } },
      { ...base, id: 'no-meet', hangoutLink: undefined },
    ] } };
  } });
  assert.equal(result.total, 1);
  assert.equal(result.rows[0].clients, 'client@example.com');
  assert.equal(result.rows[0].organizer, 'kim@orgiast.jp');
  assert.ok(result.rows[0].mailBody.includes(base.hangoutLink));
  assert.match(result.rows[0].mailBody, /seisaku-team@orgiast\.jp/);
  assert.doesNotMatch(result.rows[0].mailBody, /docs\.google\.com/);
  assert.match(result.rows[0].mailBody, /2026年11月26日/);
});

test('主催者の予定にのみ顧客がいる場合も書き込まず一度だけ通知する', async () => {
  const notices = [];
  const itemState = { staffUrl: 'https://docs.google.com/document/d/doc123/edit' };
  const event = { id: 'hidden', summary: '商談', organizer: { email: 'seisaku-team@orgiast.jp' },
    start: { dateTime: '2026-11-26T00:00:00Z' }, attendees: [{ email: 'kim@orgiast.jp' }] };
  const args = {
    event, itemState, calendarId: 'kim@orgiast.jp', getToken: async () => 'mock',
    fetchImpl: async (_, opts) => {
      assert.equal(opts.method, undefined);
      return { ok: true, json: async () => ({ ...event, attendees: [{ email: 'client@example.com' }] }) };
    },
    grantAccess: () => assert.fail('Must not share'),
    sendCue: () => assert.fail('DM must not be sent'),
    addInfo: async (_, info) => notices.push(info),
  };
  await deliverCueUrl(args);
  await deliverCueUrl(args);
  assert.equal(itemState.needsClientRemoval, true);
  assert.equal(notices.length, 1);
  assert.match(notices[0].text, /主催者予定に外部参加者/);
  assert.ok(notices[0].text.includes(itemState.staffUrl));
});
