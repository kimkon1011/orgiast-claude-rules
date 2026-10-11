import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFleetStatus, formatFleetTable, formatAge, fleetLabels } from './fleet-status.mjs';

const NOW = Date.parse('2026-10-11T03:00:00Z');
const pcMap = {
  '_note': '管理用キー',
  'kim-PC': { hostname: 'DESKTOP-2D0R4LI' },
  'nishi-PC': { hostname: 'DESKTOP-04U31RG' },
  'cr-PC': { hostname: '作業用011' }
};
const beacon = (overrides = {}) => ({ label: 'kim-PC', account: 'orgiast.jp', reportedAt: '2026-10-11T02:00:00Z', steps: [], failing: [], pollAt: '', serverPollAt: '', ...overrides });

test('fleetLabels excludes _ keys and lists every label', () => {
  assert.deepEqual(fleetLabels(pcMap), ['kim-PC', 'nishi-PC', 'cr-PC']);
});

test('buildFleetStatus lists all pcMap labels plus beacon-only labels', () => {
  const rows = buildFleetStatus({ pcMap, beacons: [beacon(), beacon({ label: 'extra-PC' })], serverPolls: {}, now: NOW });
  assert.deepEqual(rows.map((row) => row.label), ['kim-PC', 'nishi-PC', 'cr-PC', 'extra-PC']);
  assert.equal(rows.find((row) => row.label === 'nishi-PC').hasBeacon, false);
  assert.equal(rows.find((row) => row.label === 'extra-PC').hasBeacon, true);
});

test('buildFleetStatus picks the newer of server and client poll and marks the source', () => {
  const serverNewer = buildFleetStatus({ pcMap, beacons: [beacon({ pollAt: '2026-10-11T01:00:00Z' })], serverPolls: { 'kim-PC': '2026-10-11T02:30:00Z' }, now: NOW })[0];
  assert.equal(serverNewer.pollSource, 'server');
  assert.equal(serverNewer.pollAt, '2026-10-11T02:30:00.000Z');
  const clientNewer = buildFleetStatus({ pcMap, beacons: [beacon({ pollAt: '2026-10-11T02:45:00Z' })], serverPolls: { 'kim-PC': '2026-10-11T02:30:00Z' }, now: NOW })[0];
  assert.equal(clientNewer.pollSource, 'client');
  assert.equal(clientNewer.pollAt, '2026-10-11T02:45:00.000Z');
});

test('buildFleetStatus marks stale when beacon or poll is older than 24h or unknown', () => {
  const fresh = buildFleetStatus({ pcMap, beacons: [beacon({ reportedAt: '2026-10-11T02:00:00Z' })], serverPolls: { 'kim-PC': '2026-10-11T02:30:00Z' }, now: NOW })[0];
  assert.equal(fresh.stale, false);
  const oldBeacon = buildFleetStatus({ pcMap, beacons: [beacon({ reportedAt: '2026-10-09T00:00:00Z' })], serverPolls: { 'kim-PC': '2026-10-11T02:30:00Z' }, now: NOW })[0];
  assert.equal(oldBeacon.stale, true);
  const noPoll = buildFleetStatus({ pcMap, beacons: [beacon()], serverPolls: {}, now: NOW })[0];
  assert.equal(noPoll.stale, true);
  const noBeacon = buildFleetStatus({ pcMap, beacons: [], serverPolls: { 'nishi-PC': '2026-10-11T02:30:00Z' }, now: NOW }).find((row) => row.label === 'nishi-PC');
  assert.equal(noBeacon.stale, true);
});

test('buildFleetStatus exposes failing ids and account', () => {
  const row = buildFleetStatus({ pcMap, beacons: [beacon({ failing: ['a', 'b'], account: 'x.jp' })], serverPolls: {}, now: NOW })[0];
  assert.deepEqual(row.failing, ['a', 'b']);
  assert.equal(row.account, 'x.jp');
});

test('formatAge renders minutes, hours and days', () => {
  assert.equal(formatAge(30 * 60 * 1000), '30m');
  assert.equal(formatAge(3 * 3600 * 1000), '3h');
  assert.equal(formatAge(2 * 86400 * 1000), '2d');
  assert.equal(formatAge(null), '不明');
});

test('formatFleetTable shows JST time, beacon-less label and stale warning', () => {
  const rows = buildFleetStatus({ pcMap, beacons: [beacon({ reportedAt: '2026-10-11T02:00:00Z' })], serverPolls: { 'kim-PC': '2026-10-11T02:30:00Z' }, now: NOW });
  const table = formatFleetTable(rows, NOW);
  assert.match(table, /kim-PC/);
  assert.match(table, /10\/11 11:00/); // 02:00Z -> 11:00 JST
  assert.match(table, /ビーコン無し/);
  assert.match(table, /⚠/);
});

test('formatFleetTable JST boundary: 15:00Z is next-day 00:00 JST', () => {
  const rows = buildFleetStatus({ pcMap, beacons: [beacon({ reportedAt: '2026-10-11T15:00:00Z' })], serverPolls: { 'kim-PC': '2026-10-11T15:00:00Z' }, now: Date.parse('2026-10-11T15:30:00Z') });
  assert.match(formatFleetTable(rows, Date.parse('2026-10-11T15:30:00Z')), /10\/12 00:00/);
});
