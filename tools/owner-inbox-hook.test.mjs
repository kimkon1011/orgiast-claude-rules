import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { consumeOwnerInbox, CHAT_RECIPIENT_NOTICE } from './owner-inbox-hook.mjs';
import { notifyOwner as realNotifyOwner } from './notify-owner.mjs';
import { KIM_DISCORD_USER_ID } from './notify-kim.mjs';

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-hook-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, '.claude'));
  return { home, env: {}, label: 'test-PC', pcMap: { 'test-PC': { account: 'owner@example.com' } }, directory: [], resolveOwnerDiscordId: () => '123' };
}
const input = { session_id: 'session-a', hook_event_name: 'SessionStart' };
const context = out => out?.hookSpecificOutput.additionalContext || '';
// 2026-11-04 仕様変更: 宛先警告の配達テストは定時まとめを明示する。
const notifyOwner = (owner, text, options) => realNotifyOwner(owner, text, { kind: 'digest', ...options });
test('resolved recipient produces no notice', t => {
  assert.equal(consumeOwnerInbox(input, fixture(t)), null);
});

test('unresolved recipient warning appears once per session including interleaved sessions', t => {
  const options = { ...fixture(t), resolveOwnerDiscordId: () => '' };
  assert.ok(context(consumeOwnerInbox(input, options)).includes(CHAT_RECIPIENT_NOTICE));
  assert.equal(consumeOwnerInbox({ ...input, hook_event_name: 'UserPromptSubmit' }, options), null);
  assert.ok(context(consumeOwnerInbox({ ...input, session_id: 'session-b' }, options)).includes(CHAT_RECIPIENT_NOTICE));
  assert.equal(consumeOwnerInbox(input, options), null);
  options.resolveOwnerDiscordId = () => '123';
  assert.equal(consumeOwnerInbox({ ...input, session_id: 'session-c' }, options), null);
});

test('unattended sessions do not show or consume the recipient notice', t => {
  const options = { ...fixture(t), resolveOwnerDiscordId: () => '' };
  assert.equal(consumeOwnerInbox(input, { ...options, env: { CLAUDE_HEADLESS: '1' } }), null);
  assert.ok(context(consumeOwnerInbox(input, options)).includes(CHAT_RECIPIENT_NOTICE));
});

test('failed output does not consume the recipient notice', t => {
  const options = { ...fixture(t), resolveOwnerDiscordId: () => '' };
  assert.equal(consumeOwnerInbox(input, { ...options, emit: () => { throw new Error('stdout closed'); } }), null);
  assert.ok(context(consumeOwnerInbox(input, options)).includes(CHAT_RECIPIENT_NOTICE));
});

test('kim warning is limited to one attempt per day under concurrent notifications', async t => {
  const options = fixture(t), calls = [];
  Object.assign(options, { now: new Date(2026, 10, 3, 9).getTime(), toast: () => false,
    notifyKim: async (text, opts) => { calls.push({ text, opts }); await new Promise(r => setTimeout(r, 10)); return { delivered: 'session-inbox' }; } });
  await Promise.all(['a', 'b'].map(text => notifyOwner('owner@example.com', text, options)));
  await notifyOwner('owner@example.com', 'c', options);
  assert.equal(calls.length, 1);
  assert.match(calls[0].text, /test-PC/);
  assert.match(calls[0].text, /owner@example.com/);
  assert.equal(calls[0].opts.userId, KIM_DISCORD_USER_ID);
  assert.equal(calls[0].opts.plainJa, false);
  options.now += 86400000;
  await notifyOwner('owner@example.com', 'next day', options);
  assert.equal(calls.length, 2);
  const state = JSON.parse(fs.readFileSync(path.join(options.home, '.claude', 'logs', 'owner-recipient-kim-alert.json')));
  assert.equal(state.day, '2026-11-4');
});

test('kim warning failure preserves fallback and resolved recipients do not alert', async t => {
  const options = fixture(t);
  let calls = 0;
  Object.assign(options, { toast: () => false, notifyKim: async () => { calls++; throw new Error('offline'); } });
  assert.equal((await notifyOwner('owner@example.com', '進捗', options)).channel, 'inbox');
  await notifyOwner('owner@example.com', '進捗2', options);
  assert.equal(calls, 1);
  await notifyOwner('owner@example.com', 'DM', { ...options, userId: '123', notify: async () => ({ delivered: 'dm', messageId: 'receipt' }) });
  assert.equal(calls, 1);
});
