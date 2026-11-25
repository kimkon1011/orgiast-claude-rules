import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ownerRecipientContext } from './sessionstart-owner-recipient.mjs';

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-recipient-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return { home, now: new Date(2026, 10, 5, 9).getTime(), resolveOwnerFn: () => 'nishi@orgiast.jp' };
}

test('宛先ありなら出力しない', t => {
  const options = fixture(t);
  const output = ownerRecipientContext({ ...options, resolveOwnerDiscordIdFn: () => '123' });
  assert.equal(output, null);
  assert.equal(fs.existsSync(path.join(options.home, '.claude', 'logs', 'owner-recipient-selfheal.json')), false);
});

test('宛先なしなら自動登録の additionalContext を出す', t => {
  const options = fixture(t);
  const output = ownerRecipientContext({ ...options, resolveOwnerDiscordIdFn: () => '' });
  assert.equal(output.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(output.hookSpecificOutput.additionalContext, /search_members/);
  assert.match(output.hookSpecificOutput.additionalContext, /715211007307284530/);
  assert.match(output.hookSpecificOutput.additionalContext, /orgiast-discord-user-id\.txt/);
  assert.match(output.hookSpecificOutput.additionalContext, /notifyOwner/);
  assert.match(output.hookSpecificOutput.additionalContext, /user には頼まず/);
});

test('同日2回目は出力しない', t => {
  const options = fixture(t);
  const unresolved = { ...options, resolveOwnerDiscordIdFn: () => '' };
  assert.ok(ownerRecipientContext(unresolved));
  assert.equal(ownerRecipientContext({ ...unresolved, now: options.now + 60_000 }), null);
});
