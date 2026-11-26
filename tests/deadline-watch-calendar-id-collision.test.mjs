import test from 'node:test';
import assert from 'node:assert/strict';
import { syncCalendar } from '../tools/deadline-watch.mjs';
import { DEFAULT_CONFIG } from '../tools/deadline-ledger.mjs';
import { AI_CALENDAR } from '../tools/lib/calendar-shared.mjs';
import { deadlineEventId, isDeadlineOwnedEvent, belongsToLedger } from '../tools/lib/deadline-calendar.mjs';

const sheetId = 'ledger-current';
const config = { ...DEFAULT_CONFIG, sheetId, vehicleSheetId: '', calendar: { enabled: true, calendarId: AI_CALENDAR } };
const base = { id: 'V01', title: 'メルセデス・ベンツ V220d 車検', company: '社内・車両', due: '2026-10-27', kind: '車検', status: '未着手', assignee: 'kim', vehicleName: 'メルセデス・ベンツ V220d' };

test('deadlineEventId は sheetId:rowId の sha256', () => {
  assert.equal(deadlineEventId(sheetId, 'V01').length, 64);
  assert.notEqual(deadlineEventId(sheetId, 'V01'), deadlineEventId('other-sheet', 'V01'));
});

test('決定的ID枠は旧 deadlineSheetId でも自台帳扱い', () => {
  const id = deadlineEventId(sheetId, 'V01');
  const stale = { id, extendedProperties: { private: { deadlineId: 'V01', deadlineSheetId: 'ledger-retired' } } };
  assert.equal(belongsToLedger(stale, config), false);
  assert.equal(isDeadlineOwnedEvent(stale, base, config), true);
  assert.equal(isDeadlineOwnedEvent({ id, extendedProperties: { private: { deadlineId: 'OTHER' } } }, base, config), false);
});

test('409+旧sheetIdの自deadlineIdはPATCHで取り戻し、throwしない', async () => {
  const id = deadlineEventId(sheetId, base.id);
  const existing = {
    id, status: 'confirmed', summary: '旧件名', start: { date: base.due },
    extendedProperties: { private: { deadlineId: base.id, deadlineSheetId: 'ledger-retired' } },
  };
  const calls = [];
  const request = async (url, options = {}) => {
    calls.push({ url, ...options });
    if (options.method === 'POST' && !url.includes('/move')) throw Object.assign(new Error('conflict'), { status: 409 });
    // list/search finds nothing (e.g. cancelled filtered elsewhere); only GET-by-id sees the occupant
    if (!options.method && url.includes('?')) return { items: [] };
    if (!options.method && url.endsWith(`/${id}`)) return structuredClone(existing);
    if (options.method === 'PATCH') {
      Object.assign(existing, options.body);
      return structuredClone(existing);
    }
    return { items: [] };
  };
  const warnings = [];
  await syncCalendar(base, { config, state: {}, request, warnings });
  assert.equal(warnings.length, 0);
  assert.ok(calls.some(c => c.method === 'POST'));
  assert.ok(calls.some(c => c.method === 'PATCH'));
  assert.equal(existing.extendedProperties.private.deadlineSheetId, sheetId);
  assert.match(existing.summary, /社内・車両/);
});

test('409+cancelledスタブ（deadlineIdなし）はconfirmedへ復元', async () => {
  const id = deadlineEventId(sheetId, base.id);
  const existing = { id, status: 'cancelled', start: { dateTime: '2000-01-01T00:00:00Z' } };
  const request = async (url, options = {}) => {
    if (options.method === 'POST' && !url.includes('/move')) throw Object.assign(new Error('conflict'), { status: 409 });
    if (!options.method && url.endsWith(`/${id}`)) return structuredClone(existing);
    if (options.method === 'PATCH') {
      Object.assign(existing, options.body);
      return structuredClone(existing);
    }
    return { items: [] };
  };
  await syncCalendar(base, { config, state: {}, request, warnings: [] });
  assert.equal(existing.status, 'confirmed');
  assert.equal(existing.extendedProperties.private.deadlineId, base.id);
  assert.equal(existing.start.date, base.due);
});

test('409+別deadlineIdはPATCHせずwarningsへ（throwしない）', async () => {
  const id = deadlineEventId(sheetId, base.id);
  const existing = {
    id, status: 'confirmed', summary: '他人の予定',
    extendedProperties: { private: { deadlineId: 'FOREIGN-99', deadlineSheetId: sheetId } },
  };
  const calls = [];
  const request = async (url, options = {}) => {
    calls.push({ url, ...options });
    if (options.method === 'POST' && !url.includes('/move')) throw Object.assign(new Error('conflict'), { status: 409 });
    if (!options.method && url.endsWith(`/${id}`)) return structuredClone(existing);
    return { items: [] };
  };
  const warnings = [];
  await syncCalendar(base, { config, state: {}, request, warnings });
  assert.equal(calls.some(c => c.method === 'PATCH'), false);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].id, base.id);
  assert.equal(warnings[0].phase, 'Calendar sync');
  assert.match(warnings[0].warning, /Calendar ID衝突: V01/);
  assert.equal(existing.summary, '他人の予定');
});

test('listで旧sheetIdの自枠が見えても更新し、POSTしない', async () => {
  const id = deadlineEventId(sheetId, base.id);
  const existing = {
    id, status: 'confirmed', summary: '旧件名', start: { date: '2026-01-01' },
    description: '期限台帳: https://docs.google.com/spreadsheets/d/ledger-retired/edit',
    extendedProperties: { private: { deadlineId: base.id, deadlineSheetId: 'ledger-retired' } },
  };
  const calls = [];
  const request = async (url, options = {}) => {
    calls.push({ url, ...options });
    if (options.method === 'POST') throw new Error('should not create');
    if (options.method === 'PATCH') {
      Object.assign(existing, options.body);
      return structuredClone(existing);
    }
    return { items: [structuredClone(existing)] };
  };
  await syncCalendar(base, { config, state: {}, request, warnings: [] });
  assert.ok(calls.some(c => c.method === 'PATCH'));
  assert.equal(existing.extendedProperties.private.deadlineSheetId, sheetId);
  assert.equal(existing.start.date, base.due);
});
