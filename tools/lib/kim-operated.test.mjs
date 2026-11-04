import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isKimOperated, KIM_OPERATED_ACCOUNTS } from './kim-operated.mjs';
import { KIM_DISCORD_USER_ID } from './kim-identity.mjs';
function seat(t, label = 'test-seat', row) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kim-operated-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, '.claude'));
  fs.writeFileSync(path.join(home, '.claude/cost-reporter.env'), `REPORTER_LABEL=${label}`);
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'seisaku-team@orgiast.jp' } }));
  if (row) fs.writeFileSync(path.join(home, '.claude/fleet-pc-map.json'), JSON.stringify({ [label]: row }));
  return home;
}
test('operator overrides notification recipient and shared account', t => {
  for (const operator of ['佐藤優奈', '', null, 'KIM']) {
    assert.equal(isKimOperated(seat(t, 'test-seat', { operator, notifyDiscordId: KIM_DISCORD_USER_ID })), false);
  }
  assert.equal(isKimOperated(seat(t, 'test-seat', { operator: 'kim', notifyDiscordId: 'employee' }), 'employee@example.test'), true);
});
test('notifyDiscordId alone identifies the operator', t => {
  assert.equal(isKimOperated(seat(t, 'test-seat', { notifyDiscordId: KIM_DISCORD_USER_ID }), 'employee@example.test'), true);
  for (const notifyDiscordId of ['1423319951980232744', '', null]) {
    assert.equal(isKimOperated(seat(t, 'test-seat', { notifyDiscordId })), false);
  }
});
test('no override retains the account fallback including the shared account', t => {
  const home = seat(t);
  for (const account of KIM_OPERATED_ACCOUNTS) assert.equal(isKimOperated(home, ` ${account.toUpperCase()} `), true);
  assert.equal(isKimOperated(home), true);
  assert.equal(isKimOperated(home, 'employee@example.test'), false);
});
test('repo entry and aliases apply; local fields override and retain repo fields', t => {
  assert.equal(isKimOperated(seat(t, '作業用011', { notifyDiscordId: '1423319951980232744' })), false);
  assert.equal(isKimOperated(seat(t, 'DESKTOP-BDOAK99')), false);
  assert.equal(isKimOperated(seat(t, '作業用008')), false);
  assert.equal(isKimOperated(seat(t, 'DESKTOP-BDOAK99', { operator: 'kim' })), true);
  assert.equal(isKimOperated(seat(t, 'DESKTOP-BDOAK99', { account: 'kim@orgiast.jp' })), false);
});
test('hostname fallback and malformed local map do not lose account fallback', t => {
  const home = seat(t, os.hostname(), { operator: 'employee' });
  fs.unlinkSync(path.join(home, '.claude/cost-reporter.env'));
  assert.equal(isKimOperated(home), false);
  fs.writeFileSync(path.join(home, '.claude/cost-reporter.env'), 'REPORTER_LABEL=test-seat');
  fs.writeFileSync(path.join(home, '.claude/fleet-pc-map.json'), '{bad');
  assert.equal(isKimOperated(home), true);
});
