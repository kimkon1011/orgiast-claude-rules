import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { successfulPollIsFresh } from './lib/fleet-poll-health.mjs';
import { pollIsFresh, STALE_POLL_MS } from './register-fleet-mail.mjs';
import { shouldReceivePoll, POLL_STALE_MS } from './fleet-inbox-context.mjs';

test('recent error writes cannot mask an old successful poll in either recovery path', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-health-regression-'));
  const dir = path.join(home, '.claude');
  fs.mkdirSync(dir);
  const file = path.join(dir, '.fleet-mail-last-poll.json');
  const now = Date.now();
  fs.writeFileSync(file, JSON.stringify({ at: new Date(now - STALE_POLL_MS - 1).toISOString(), errorStreak: 5, errorAt: new Date(now).toISOString() }));
  assert.equal(pollIsFresh(home, () => now), false);
  assert.equal(shouldReceivePoll(home, { now: () => now }), true);
  fs.writeFileSync(file, JSON.stringify({ at: new Date(now).toISOString() }));
  assert.equal(pollIsFresh(home, () => now + STALE_POLL_MS), true);
  assert.equal(shouldReceivePoll(home, { now: () => now + POLL_STALE_MS }), false);
  for (const content of ['{}', 'null', '{broken', JSON.stringify({ at: 'invalid' }), JSON.stringify({ at: new Date(now + 1).toISOString() })]) {
    fs.writeFileSync(file, content);
    assert.equal(successfulPollIsFresh(home, STALE_POLL_MS, () => now), false);
  }
});
