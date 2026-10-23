import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveOwner, resolveOwnerDiscordId, notifyOwner } from './notify-owner.mjs';
import { KIM_DISCORD_USER_ID } from './notify-kim.mjs';

test('owner 解決は fleet account を使う', () => {
  assert.equal(resolveOwner({ label: 'cr-PC', pcMap: { 'cr-PC': { account: 'cr@orgiast.jp' } }, gitEmail: 'other@example.com' }), 'cr@orgiast.jp');
});
test('owner Discord ID をメールで解決する', () => {
  assert.equal(resolveOwnerDiscordId('cr@orgiast.jp', { directory: { x: { members: [{ id: '42', emails: ['cr@orgiast.jp'] }] } } }), '42');
});
test('DM 解決不能時は kim 宛に宛先を明記する', async () => {
  let call; const result = await notifyOwner('cr@orgiast.jp', '結果', { home: 'Z:/missing', directory: {}, notify: async (text, options) => { call = { text, options }; return { delivered: 'dm' }; } });
  assert.equal(result.delivered, 'dm'); assert.match(call.text, /^宛先: cr@orgiast.jp（DM 未解決）/); assert.equal(call.options.userId, KIM_DISCORD_USER_ID);
});


test('owner directory reads queries cache and refuses ambiguous email matches', () => {
  const directory = { queries: { cr: { members: [{ id: '42', emails: ['cr@orgiast.jp'] }] } } };
  assert.equal(resolveOwnerDiscordId('cr@orgiast.jp', { directory }), '42');
  directory.queries.other = { members: [{ id: '43', emails: ['cr@orgiast.jp'] }] };
  assert.equal(resolveOwnerDiscordId('cr@orgiast.jp', { directory }), '');
});

test('owner空の旧行はローカル持ち主を解決して通知する', async () => {
  let call;
  await notifyOwner('', '自動進行', { label: 'kim-PC', pcMap: { 'kim-PC': { account: 'kim@orgiast.jp' } }, directory: [{ id: KIM_DISCORD_USER_ID, emails: ['kim@orgiast.jp'] }], notify: async (text, options) => { call = { text, options }; return { delivered: 'dm' }; } });
  assert.equal(call.text, '自動進行');
  assert.equal(call.options.userId, KIM_DISCORD_USER_ID);
});
