import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { watchFleetMail, run } from './auto-progress-watch.mjs';
test('expired・failed・未実施doneを1通にまとめて通知し24時間以内は抑止、失敗は再試行', async t => {
 const home = fs.mkdtempSync(path.join(os.tmpdir(), 'progress-fleet-'));
 t.after(() => fs.rmSync(home, { recursive: true, force: true }));
 const dir = path.join(home, '.claude'); fs.mkdirSync(dir);
 const now = Date.parse('2026-10-26T00:00:00Z');
 const recent = new Date(now - 3600000).toISOString();
 const rows = Object.fromEntries([
  ['expired', 'expired', ''], ['failed', 'failed', ''], ['blocker', 'done', 'BLOCKED'], ['unperformed', 'done', '判定不能（未実施）'], ['empty', 'done', ' '], ['ok', 'done', '完了しました']
 ].map(([id, status, resultBody]) => [id, { id, kind: 'prompt', status, resultBody, from: 'nishi-PC', to: 'kim-PC', why: '調査', expiresAt: recent }]));
 rows.foreign = { id: 'foreign', from: 'other-PC', status: 'expired', expiresAt: recent };
 rows.old = { id: 'old', from: 'nishi-PC', kind: 'prompt', status: 'expired', expiresAt: new Date(now - 8 * 86400000).toISOString() };
 rows.note = { id: 'note', from: 'nishi-PC', kind: 'note', status: 'done', resultBody: '', expiresAt: recent };
 rows['mail-reply-x'] = { id: 'mail-reply-x', from: 'nishi-PC', kind: 'prompt', status: 'expired', expiresAt: recent };
 fs.writeFileSync(path.join(dir, 'fleet-mail-sent-status.json'), JSON.stringify(rows));
 let calls = 0, delivered = 'toast', last = '';
 const options = { home, now, io: { label: 'nishi-PC', localOwner: 'nishi@orgiast.jp', notifyOwner: async (_, text) => { calls++; last = text; return { delivered, channel: delivered }; } } };
 assert.deepEqual(await watchFleetMail({ ...options, dryRun: true }), { fleetExpired: 1, fleetBlocked: 4 });
 assert.equal(calls, 0);
 assert.deepEqual(await watchFleetMail(options), { fleetExpired: 1, fleetBlocked: 4 });
 assert.equal(calls, 1);
 assert.match(last, /依頼 5 件/);
 assert.match(last, /再送: fleet-mail --send を同じ body で/);
 assert.doesNotMatch(last, /・(old|note|foreign|mail-reply-x|ok)（/);
 await watchFleetMail({ ...options, now: now + 86400000 - 1 }); assert.equal(calls, 1);
 delivered = 'none';
 await watchFleetMail({ ...options, now: now + 86400000 }); assert.equal(calls, 2);
 delivered = 'dm';
 await watchFleetMail({ ...options, now: now + 86400000 }); assert.equal(calls, 3);
 await watchFleetMail({ ...options, now: now + 86400000 }); assert.equal(calls, 3);
 const summary = await run({ ...options, now: now + 86400000, io: { ...options.io, digest: async () => ({}) } });
 assert.equal(summary.fleetExpired, 1); assert.equal(summary.fleetBlocked, 4);
 assert.match(fs.readFileSync(path.join(dir, 'logs', 'auto-progress-watch.summary.log'), 'utf8'), /"fleetBlocked":4/);
});
