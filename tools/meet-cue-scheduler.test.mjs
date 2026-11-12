import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  isTargetEvent,
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

  // Case 1: Internal only (no external attendees)
  const internalEvent = {
    ...validEvent,
    attendees: [{ email: 'tanaka@orgiast.jp' }, { email: 'kim@orgiast.jp' }],
  };
  assert.equal(isTargetEvent(internalEvent, { staffAddresses, now }), false, '社内だけは対象外');

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
  } finally {
    fs.writeFileSync(configPath, originalConfig, 'utf8');
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});
