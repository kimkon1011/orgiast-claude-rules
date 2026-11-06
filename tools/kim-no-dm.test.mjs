import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deliverKim, KIM_DISCORD_USER_ID } from './notify-kim.mjs';
import { notifyOwner } from './notify-owner.mjs';
import { sendDiscordDm } from './discord-dm.mjs';
import { listItems } from './kim-inbox.mjs';

function home(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kim-no-dm-'));
  fs.mkdirSync(path.join(dir, '.claude'));
  fs.writeFileSync(path.join(dir, '.claude/cost-reporter.env'), 'REPORTER_LABEL=kim-PC');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
test('all old exception categories and emergency reports use inbox without transport', async t => {
  const dir = home(t);
  for (const [kind, text] of [['action', '判断してください'], ['digest', '【進捗まとめ】'], ['done-requested', '✅ 完了'], ['automatic', '緊急の障害']]) {
    const result = await deliverKim(text, { home: dir, userId: KIM_DISCORD_USER_ID, kind, plainJa: false, token: 'unused', sessionId: 'kim-no-dm-session',
      allowlist: [{ category: 'all', pattern: '.*' }], fetchImpl: () => assert.fail('kim transport forbidden') });
    assert.equal(result.delivered, 'session-inbox');
    assert.equal(result.kind, kind === 'action' ? 'ask' : 'info');
  }
  assert.equal(listItems(dir).length, 4);
  assert.ok(listItems(dir).every(item => item.sessionId === 'kim-no-dm-session'));
});
test('kim has no eight-message quota and ID overrides another fleet account owner', async t => {
  const dir = home(t);
  for (let n = 0; n < 10; n++) {
    const result = await notifyOwner(n % 2 ? 'cr@orgiast.jp' : 'kim@orgiast.jp', `質問 ${n}`, {
      home: dir, kind: 'action', userId: KIM_DISCORD_USER_ID, notify: () => assert.fail('DM forbidden'),
    });
    assert.equal(result.delivered, 'session-inbox'); assert.equal(result.kind, 'ask');
  }
  assert.equal(listItems(dir).length, 10);
  assert.equal(fs.existsSync(path.join(dir, '.claude/logs/owner-dm-reservations.jsonl')), false);
});
test('direct Discord CLI routes kim to inbox but still delivers to employees', async t => {
  const dir = home(t);
  const kim = await sendDiscordDm('kim', 'PR をマージしてください', { home: dir,
    resolve: async () => ({ id: KIM_DISCORD_USER_ID }), fetchImpl: () => assert.fail('DM forbidden'), kind: 'action' });
  assert.equal(kim.delivered, 'session-inbox'); assert.equal(listItems(dir)[0].kind, 'ask');
  const calls = [];
  const employee = await sendDiscordDm('staff', '連絡です', { home: dir, token: 'fixture', noCopyKim: true,
    resolve: async () => ({ id: '123', displayName: '社員' }), fetchImpl: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) }); return Response.json({ id: 'channel' });
    } });
  assert.equal(employee.delivered, true); assert.equal(calls.length, 2);
  assert.equal(calls[0].body.recipient_id, '123');
});

test('raw DM channel transports are audited; new bypasses fail this inventory', () => {
  const root = new URL('./', import.meta.url);
  const audited = new Map([
    ['autopilot-tick.mjs', 'readControls'], // Opens channel only to read incoming commands.
    ['event-shop-reply-context.mjs', 'channels.push'], // Read-only context collection.
    ['kim-push-relay.mjs', 'messages?after='], // Reads old DMs; pushKim is a separate phone push.
    ['discord-dm.mjs', 'const inbox = isKim;'],
    ['feedback-nag.mjs', 'if (deferred) return deferred;'],
    ['notify-kim.mjs', 'return persistKim(home,'],
    ['sga-autopilot.mjs', 'if (userId === KIM_DISCORD_USER_ID) await (deps.deliverKim || deliverKim)'],
    ['feedback-kit/gas/templates/FeedbackRelay.js', 'kim-inbox'],
  ]);
  const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const file = new URL(e.name + (e.isDirectory() ? '/' : ''), dir);
    return e.isDirectory() ? walk(file) : /\.(mjs|js|ts|ps1)$/.test(e.name) && !/\.test\./.test(e.name) ? [file] : [];
  });
  for (const file of walk(root)) {
    const source = fs.readFileSync(file, 'utf8');
    if (!source.includes('recipient_id:') || !source.includes('/users/@me/channels')) continue;
    const name = decodeURIComponent(file.href.slice(root.href.length));
    assert.ok(audited.has(name), `Unaudited raw DM transport: ${name}`);
    assert.ok(source.includes(audited.get(name)), `Missing kim-inbox guard/read-only evidence: ${name}`);
    if (name !== 'kim-push-relay.mjs') assert.doesNotMatch(source, /recipient_id:\s*(?:KIM_\w+|'715210673642012733'|"715210673642012733")/, name === 'kim-push-relay.mjs' ? undefined : name);
  }
});
