import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkPromise, checkProgressSummary } from './auto-progress-check.mjs';
import { notifyOwner } from './notify-owner.mjs';
import { listItems as allInboxItems, markSeen } from './kim-inbox.mjs';
import { routeOwnerDm, deferredFile } from './lib/owner-dm-policy.mjs';
import { compactDigest } from './lib/owner-dm-digest.mjs';
import { isKimHumanProgress, deliverHumanProgress } from './lib/auto-progress-human-inbox.mjs';
const listItems = home => allInboxItems(home).filter(item => !item.dailyProgress);
const now = Date.parse('2026-11-06T00:00:00Z');
const row = () => ({ sessionId: 'human-session', ts: '2026-11-05T00:00:00Z', owner: 'kim@orgiast.jp', transcriptPath: '/transcript.jsonl', label: '保存の確認', promise: '保存されたら確認', status: 'open', check: 'check-command', deadlineAt: '2026-11-08T00:00:00Z', nextKim: '', nextClaude: '権限を確認する' });
function home(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'human-progress-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'kim@orgiast.jp' } }));
  return dir;
}
test('A/B human changes bypass quota and digest-only, preserve deferred bytes, deliver to inbox only', async t => {
  const dir = home(t), r = row();
  // Fill another member's unchanged DM quota; kim no longer enters this queue.
  for (let i = 0; i < 9; i++) await routeOwnerDm('other@example.com', `質問${i}`, { home: dir, now, kind: 'action' });
  const before = fs.readFileSync(deferredFile(dir), 'utf8');
  let code = 1, text = 'まだ保存されていません\n詳細';
  const opts = { home: dir, now, patch: (_, change) => Object.assign(r, change), io: {
    executeCheck: () => ({ code, text }), notifyOwner: () => assert.fail('no DM'), queueCheckFollowup: () => {},
  } };
  await checkPromise(r, opts);
  let items = listItems(dir); assert.equal(items.length, 1);
  assert.equal(allInboxItems(dir).filter(item => item.dailyProgress).length, 1);
  assert.equal(items[0].text, '依頼名: 保存の確認\nいまの状態: まだ保存されていません\nClaude の次の手: 権限を確認する');
  markSeen(dir, items[0].id);
  text = 'まだ保存されていません\n変化する詳細';
  await checkPromise(r, { ...opts, now: now + 7 * 3600000 });
  assert.equal(listItems(dir).length, 1);
  r.nextKim = '設定を保存してください'; await checkPromise(r, opts);
  r.state = 'waiting'; await checkPromise(r, opts);
  r.status = 'waiting_user'; await checkPromise(r, opts);
  text = '保存待ちです'; await checkPromise(r, opts);
  code = 2; await checkPromise(r, opts);
  code = 1; await checkPromise(r, opts); // returning to a previous state is a new transition
  await checkPromise(r, opts);
  assert.equal(listItems(dir).length, 7);
  code = 0; text = '保存を確認しました'; await checkPromise(r, opts); await checkPromise(r, opts);
  assert.equal(listItems(dir).length, 8); assert.ok(r.doneInboxVerifiedAt);
  assert.equal(fs.readFileSync(deferredFile(dir), 'utf8'), before);
});
test('A strict provenance and policy exemption do not exempt unrelated automatic jobs', async t => {
  const dir = home(t), r = row();
  for (const patch of [{ owner: 'other@example.com' }, { transcriptPath: '' }, { label: '', promise: '' }]) {
    assert.equal(isKimHumanProgress({ ...r, ...patch }), false);
    assert.equal((await routeOwnerDm('other@example.com', '進捗', { home: dir, now, kind: 'automatic', session: { ...r, ...patch, owner: 'other@example.com' } })).delivered, 'deferred');
  }
  const before = fs.readFileSync(deferredFile(dir), 'utf8');
  for (const session of [r, { ...r, transcriptPath: '' }]) {
    const result = await routeOwnerDm(r.owner, '進捗', { home: dir, now, kind: 'automatic', session, fetchImpl: () => assert.fail('no Discord') });
    assert.equal(result.delivered, 'session-inbox');
    assert.equal(result.channel, 'kim-inbox');
    assert.ok(listItems(dir).some(item => item.id === result.id && item.text === '進捗'));
  }
  assert.equal(fs.readFileSync(deferredFile(dir), 'utf8'), before);
});
test('B notifyOwner routes overdue human progress directly and deduplicates without Discord', async t => {
  const dir = home(t), r = { ...row(), status: 'overdue_reported', checkResult: 'unmet', checkText: '保存待ちです' };
  const options = { home: dir, now, session: r, kind: 'automatic', fetchImpl: () => assert.fail('no Discord') };
  assert.equal((await notifyOwner(r.owner, 'old report', options)).channel, 'kim-inbox');
  assert.equal((await notifyOwner(r.owner, 'old report', options)).unchanged, true);
  assert.equal(listItems(dir).length, 1);
});
test('B failed read-back and failed ledger receipt retry without duplicate inbox items', async t => {
  const dir = home(t), r = row();
  await assert.rejects(deliverHumanProgress(dir, r, { io: { listKimInboxItems: () => [] } }), /read-back/);
  await deliverHumanProgress(dir, r); assert.equal(listItems(dir).length, 1);
  const opts = { home: dir, now, patch: () => false, io: { executeCheck: () => ({ code: 1, text: '待機中です' }) } };
  assert.equal(await checkPromise(r, opts), 'ledger_error'); assert.equal(listItems(dir).length, 1);
  let patches = 0;
  opts.patch = (_, changes) => { if (++patches === 2) return false; Object.assign(r, changes); };
  assert.equal(await checkPromise(r, opts), 'ledger_error');
  opts.patch = (_, changes) => Object.assign(r, changes);
  await checkPromise(r, opts); assert.equal(listItems(dir).length, 2);
});
test('B simultaneous identical deliveries create one item', async t => {
  const dir = home(t), r = row();
  const result = await Promise.all([deliverHumanProgress(dir, r), deliverHumanProgress(dir, r)]);
  assert.equal(result[0].id, result[1].id); assert.equal(listItems(dir).length, 1);
});
test('C digest lists ten requests with first summary and nextKim, then overflow count', () => {
  const rows = Array.from({ length: 12 }, (_, i) => ({ ...row(), label: `依頼${i}`, checkText: JSON.stringify({ summary: `保存確認${i}\n詳細` }), nextKim: i ? '確認してください' : '' }));
  const text = compactDigest(rows, [], now, { owner: 'kim@orgiast.jp' }).text.split('あなたが頼んだこと\n')[1];
  assert.equal((text.match(/nextKim:/g) || []).length, 10);
  assert.match(text, /依頼0 ／ 保存確認0 ／ nextKim: なし/);
  assert.match(text, /依頼9 ／ 保存確認9 ／ nextKim: 確認してください/);
  assert.doesNotMatch(text, /依頼10|詳細/); assert.match(text, /ほか 2件/);
});
test('D Japanese first line and JSON summary take precedence; legacy fallback remains', () => {
  assert.equal(checkProgressSummary('保存待ちです\n詳細: NG'), '保存待ちです');
  assert.equal(checkProgressSummary('{"summary":"保存されました","count":1}'), '保存されました');
  assert.equal(checkProgressSummary('{\n"summary":"保存待ちです"\n}'), '保存待ちです');
  assert.match(checkProgressSummary('[]'), /判定不明 1件/);
  assert.match(checkProgressSummary('OK\nNG'), /達成 1件 \/ 未達 1件/);
  assert.match(checkProgressSummary('{"count":0}'), /判定不明/);
});

test('A JSON state changes notify even when summary and exit code stay the same', async t => {
  const dir = home(t), r = { ...row(), checkResult: 'unmet', checkText: '保存待ちです\n{"state":"waiting_export"}' };
  await deliverHumanProgress(dir, r);
  r.checkText = '保存待ちです\n{"state":"export_missing"}';
  await deliverHumanProgress(dir, r); await deliverHumanProgress(dir, r);
  assert.equal(listItems(dir).length, 2);
});

test('C explicit kim human provenance stays in requested work when checked by an automatic worker', () => {
  const text = compactDigest([{ ...row(), headless: true, checkText: '保存待ちです' }], [], now).text;
  assert.match(text, /あなたが頼んだこと\n完了 0件 \/ 進行中 1件/);
  assert.match(text, /保存待ちです ／ nextKim: なし/);
});
