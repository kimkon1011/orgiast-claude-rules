import test from 'node:test';
import assert from 'node:assert/strict';
import { isStale } from './purge-remote-sessions.mjs';

const now = Date.parse('2026-10-15T12:00:00Z');
const at = (hours) => new Date(now - hours * 3_600_000).toISOString();

test('archives only active, disconnected sessions idle for 24h or more', () => {
  assert.equal(isStale({ status: 'active', connection_status: 'disconnected', last_event_at: at(25) }, now), true);
  assert.equal(isStale({ status: 'active', connection_status: 'disconnected', last_event_at: at(23) }, now), false);
  assert.equal(isStale({ status: 'active', connection_status: 'connected', last_event_at: at(100) }, now), false);
  assert.equal(isStale({ status: 'archived', connection_status: 'disconnected', last_event_at: at(100) }, now), false);
  assert.equal(isStale({ status: 'active', connection_status: 'disconnected', updated_at: at(48) }, now), true);
  assert.equal(isStale({ status: 'active', connection_status: 'disconnected' }, now), false);
});
