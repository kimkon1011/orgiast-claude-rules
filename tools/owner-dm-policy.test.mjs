import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { notifyOwner } from './notify-owner.mjs';
import { readDeferred } from './lib/owner-dm-policy.mjs';
import { compactDigest } from './lib/owner-dm-digest.mjs';
function fixture(t) {
 const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-policy-'));
 t.after(() => fs.rmSync(home, { recursive: true, force: true }));
 let calls = 0;
 return { home, now: Date.parse('2026-11-04T10:00:00Z'), userId: '123', directory: [], pcMap: {}, notify: async () => { calls++; return { delivered: 'dm', messageId: String(calls) }; }, calls: () => calls };
}
test('autopilot and headless completion is deferred without DM', async t => {
 const o = fixture(t);
 for (const source of ['autopilot', 'headless']) assert.equal((await notifyOwner('nishi@orgiast.jp', '完了', { ...o, kind: 'done-requested', session: { source } })).delivered, 'deferred');
 assert.equal(o.calls(), 0); assert.equal(readDeferred(o.home).length, 2);
});
test('action sends immediately with complete question', async t => {
 const o = fixture(t); const question = 'どちらの日程にしますか？ 11月5日か6日を返信してください。';
 assert.equal((await notifyOwner('nishi@orgiast.jp', question, { ...o, kind: 'action' })).delivered, 'dm'); assert.equal(o.calls(), 1);
});
test('ninth immediate notification is deferred, including action', async t => {
 const o = fixture(t);
 for (let n = 0; n < 8; n++) assert.equal((await notifyOwner('nishi@orgiast.jp', '質問', { ...o, kind: 'action' })).delivered, 'dm');
 assert.equal((await notifyOwner('nishi@orgiast.jp', '九つ目の質問', { ...o, kind: 'action' })).delivered, 'deferred');
 assert.equal(o.calls(), 8); assert.equal(readDeferred(o.home)[0].kind, 'action');
});
test('digest has three sections, ten lines and groups old waiting items', () => {
 const now = Date.parse('2026-11-04T10:00:00Z');
 const result = compactDigest([], [{ id: 'a', kind: 'action', text: '返事をください', at: '2026-10-20' }], now);
 for (const heading of ['あなたの返事待ち', 'あなたが頼んだこと', '自動作業']) assert.ok(result.text.includes(heading));
 assert.ok(result.text.split('\n').length <= 10); assert.ok(result.text.length <= 2000); assert.match(result.text, /古い待ち 1件/);
});
test('human requested completion sends immediately', async t => {
 const o = fixture(t); assert.equal((await notifyOwner('nishi@orgiast.jp', '予約できました', { ...o, kind: 'done-requested', session: { source: 'interactive' } })).delivered, 'dm'); assert.equal(o.calls(), 1);
});
test('untyped human question is promoted and no-action field remains deferred', async t => {
 const o = fixture(t);
 assert.equal((await notifyOwner('nishi@orgiast.jp', 'kim がすること: 日程を選んでください', o)).delivered, 'dm');
 assert.equal((await notifyOwner('nishi@orgiast.jp', 'kim がすること: なし', o)).delivered, 'deferred');
});

test('concurrent calls reserve only eight slots and JST midnight resets the limit', async t => {
 const o = fixture(t);
 const results = await Promise.all(Array.from({ length: 12 }, () => notifyOwner('nishi@orgiast.jp', '質問', { ...o, now: Date.parse('2026-11-04T14:59:00Z'), kind: 'action' })));
 assert.equal(results.filter(r => r.delivered === 'dm').length, 8);
 assert.equal(results.filter(r => r.delivered === 'deferred').length, 4);
 assert.equal((await notifyOwner('nishi@orgiast.jp', '質問', { ...o, now: Date.parse('2026-11-04T15:00:00Z'), kind: 'action' })).delivered, 'dm');
});
test('capped actions precede recent questions even after seven days', () => {
 const result = compactDigest([], [
   { id: 'recent', kind: 'action', text: '最近の質問', at: '2026-11-04' },
   { id: 'capped', kind: 'action', text: '上限を超えた質問の全文です。どちらにしますか？', at: '2026-10-01', reason: 'daily-limit' },
 ], Date.parse('2026-11-04T10:00:00Z'));
 assert.ok(result.text.indexOf('上限を超えた質問') < result.text.indexOf('最近の質問'));
 assert.ok(result.includedIds.includes('capped'));
});
test('deferred secrets are redacted and unknown kinds never reach transport', async t => {
 const o = fixture(t);
 const result = await notifyOwner('nishi@orgiast.jp', 'token=example-secret', { ...o, kind: 'unknown' });
 assert.equal(result.delivered, 'deferred'); assert.equal(o.calls(), 0);
 assert.ok(!fs.readFileSync(path.join(o.home, '.claude/logs/owner-dm-deferred.jsonl'), 'utf8').includes('example-secret'));
});
test('a human request in the nightly-repo repository is still requested work', async t => {
 const o = fixture(t);
 assert.equal((await notifyOwner('nishi@orgiast.jp', '修正が完了しました', { ...o, kind: 'done-requested', session: { source: 'interactive', cwd: '/work/nightly-repo' } })).delivered, 'dm');
});
