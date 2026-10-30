import assert from 'node:assert/strict';
import { candidateForDay, dateRange, groupEvents, parseReply, makeBatch, unasked, reportRow } from './daytrip-detect.mjs';
export const fixtureEvent = (overrides = {}) => ({ id: 'event-1', summary: '商談', location: '京都駅', start: { dateTime: '2026-11-02T10:00:00+09:00' }, end: { dateTime: '2026-11-02T11:30:00+09:00' }, attendees: [{ email: 'kim@orgiast.jp', self: true }, { email: 'staff@orgiast.jp' }, { email: 'customer@example.com' }], ...overrides });
export const fixtureRange = dateRange({ from: '2026-11-02', to: '2026-11-02' });
export const fixtureDay = () => groupEvents([fixtureEvent()], fixtureRange).get('2026-11-02');
export const fixtureCandidate = () => candidateForDay('2026-11-02', fixtureDay(), [{ km: 50/1.3 }]);
export async function runSelfTest(log = console.log) {
  const day = fixtureDay();
  const boundary = candidateForDay('2026-11-02', day, [{ km: 50/1.3 }]);
  assert.equal(boundary.roadKm, 50); assert.equal(boundary.hours, 4);
  const atFourHours = { ...day[0], end: day[0].start + (4 - 2*51*1.3/40)*3600000 };
  assert.ok(candidateForDay('2026-11-02', [atFourHours], [{ km: 51 }]));
  assert.equal(candidateForDay('2026-11-02', [{ ...atFourHours, end: atFourHours.end - 1 }], [{ km: 51 }]), null);
  log('ok: road distance 50km / absence 4h boundary');
  assert.equal(candidateForDay('2026-11-02', [{ ...day[0], end: day[0].start + 60000 }], [{ km: 51 }]), null);
  assert.ok(candidateForDay('2026-11-02', day, [{ km: 35 }]).notes.some(n => n.includes('要確認')));
  assert.equal(candidateForDay('2026-11-02', day, [{ km: 34.999 }]), null);
  log('ok: below 4h excluded; straight 35–50km review band');
  const excluded = [fixtureEvent({ location: 'meet.google.com/cez-xwkk-yeq' }), fixtureEvent({ location: '' }), fixtureEvent({ location: 'https://meet.google.com/abc-defg-hij' }), fixtureEvent({ location: 'Zoom https://zoom.us/j/1' }), fixtureEvent({ location: 'Teams https://teams.microsoft.com/l/meetup-join/a' }), fixtureEvent({ start: { date: '2026-11-02' }, end: { date: '2026-11-03' } }), fixtureEvent({ summary: '【自動】商談' })];
  assert.equal(groupEvents(excluded, fixtureRange).size, 0);
  assert.equal(groupEvents([fixtureEvent(), fixtureEvent()], fixtureRange).get('2026-11-02').length, 1);
  log('ok: online / all-day / automated duplicate exclusion');
  const dining = candidateForDay('2026-11-02', [{ ...day[0], title: '会食・懇親会' }], [{ km: 60 }]);
  assert.ok(dining.notes.includes('会食のみの可能性'));
  assert.ok(candidateForDay('2026-11-02', day, [null]).notes.some(n => n.includes('距離不明')));
  log('ok: dining-only annotation and unknown distance retained');
  const batch = makeBatch([boundary], []);
  assert.deepEqual(unasked([boundary], [batch]), []);
  assert.equal(makeBatch([boundary], [batch]), null);
  assert.equal(makeBatch([{ ...boundary, date: '2026-11-03' }], [batch]).items[0].number, 2);
  assert.deepEqual(parseReply('はい 1,3\nいいえ 2'), [{ number: 1, accepted: true }, { number: 3, accepted: true }, { number: 2, accepted: false }]);
  assert.deepEqual(parseReply('はい 1 かもしれません'), []);
  assert.equal(reportRow(boundary)[8], 'customer@example.com');
  log('ok: date ledger deduplication / stable reply numbers / external attendees');
  log('daytrip-detect self-test: PASS (network-free)');
}

import { isEntry } from './is-entry.mjs';
if (isEntry(import.meta.url)) await runSelfTest();
