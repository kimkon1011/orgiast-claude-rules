import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildContext, FOOTER, main, shouldReceivePoll, receiveIfStale } from './fleet-inbox-context.mjs';

test('zero unread messages use zero context', () => assert.equal(buildContext([]), ''));
test('many messages stay within 1500 characters and retain reply/ack footer', () => {
  const entries = Array.from({ length: 100 }, (_, i) => ({ id: `mail-${i}`, from: 'PC', kind: 'note', why: '確認', body: 'あ'.repeat(20000) }));
  const result = buildContext(entries);
  assert.ok(result.length <= 1500); assert.ok(result.endsWith(FOOTER));
  assert.match(result, /from=PC \/ kind=note \/ why=確認 \/ id=mail-0/);
});
test('context redacts secrets before truncation', () => {
  const result = buildContext([{ id: 'mail-1', from: 'PC', kind: 'note', why: 'token=secret-reason', body: 'x'.repeat(290) + ' api_key=secret-value https://discord.com/api/webhooks/123/secret' }]);
  assert.doesNotMatch(result, /secret-reason|secret-value|webhooks\/123/);
});
test('empty, malformed input and missing inbox produce no hook output', async () => {
  for (const input of ['', '{', '{}', '{"prompt":"hello"}']) {
    const outputs = [];
    await main({ home: '/missing/fleet-inbox-test', readStdin: async () => input, stdout: t => outputs.push(t) });
    assert.deepEqual(outputs, []);
  }
});

test('decision notice follows header, counts body or why once and preserves context budget', () => {
  const entries = Array.from({ length: 100 }, (_, i) => ({ id: `mail-${i}`, from: 'PC', kind: 'note', why: '確認', body: 'あ'.repeat(20000) }));
  // headless を明示指定: テスト実行環境が CLAUDE_HEADLESS=1 を継承していても結果を固定する。
  assert.doesNotMatch(buildContext(entries, { headless: false }), /⚠ 判断依頼/);
  entries[0].why = '  [判断依頼] 承認';
  entries[0].body = '[判断依頼] 詳細';
  entries[99].body = '\n[判断依頼] 確認';
  const result = buildContext(entries, { headless: false });
  assert.equal(result.split('\n')[1], '⚠ 判断依頼 2 件: 他の作業より先に kim へその場で聞き、--reply で返すこと');
  assert.ok(result.length <= 1500);
  assert.ok(result.endsWith(FOOTER));
});

// --- 2026-10-10 事故: hook の自律受信とヘッドレスの判断依頼除外 ---
test('headless context excludes decision-request mails and says so', () => {
  const entries = [
    { id: 'mail-1', from: 'PC', kind: 'note', why: '通常', body: '本文' },
    { id: 'mail-2', from: 'PC', kind: 'note', why: '[判断依頼] 承認', body: '詳細' },
  ];
  const result = buildContext(entries, { headless: true });
  assert.doesNotMatch(result, /mail-2|承認/);
  assert.match(result, /mail-1/);
  assert.match(result, /ヘッドレスセッションのため判断依頼 1 件を除外/);
  assert.ok(result.endsWith(FOOTER));
  // ヘッドレスで判断依頼のみのときは文脈を出さない
  assert.equal(buildContext([entries[1]], { headless: true }), '');
});
test('shouldReceivePoll: fresh markers suppress, stale or missing markers allow', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-inbox-ctx-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, '.claude'); fs.mkdirSync(dir);
  const marker = path.join(dir, '.fleet-mail-last-poll.json');
  assert.equal(receiveIfStale_should(home), true); // 未受信
  fs.writeFileSync(marker, '{"at":"now"}');
  assert.equal(receiveIfStale_should(home), false); // たった今受信済み
  const old = new Date(Date.now() - 3 * 60 * 1000);
  fs.utimesSync(marker, old, old);
  assert.equal(receiveIfStale_should(home), true); // 3分前
  fs.unlinkSync(marker);
  const inflight = path.join(dir, '.fleet-mail-poll.json');
  fs.writeFileSync(inflight, '{}');
  assert.equal(receiveIfStale_should(home), false); // 今まさに受信中
});
function receiveIfStale_should(home) { return shouldReceivePoll(home); }
test('receiveIfStale polls only when stale and swallows poll errors', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-inbox-ctx-'));
  const fresh = path.join(home, '.claude', '.fleet-mail-last-poll.json');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(fresh, '{}');
  const calls = [];
  assert.deepEqual(await receiveIfStale(home, { poll: async () => { calls.push(1); return {}; } }), { skipped: 'fresh' });
  assert.equal(calls.length, 0);
  fs.unlinkSync(fresh);
  assert.deepEqual(await receiveIfStale(home, { poll: async () => { calls.push(1); throw new Error('offline'); } }), { skipped: 'error' });
  assert.equal(calls.length, 1);
  const seen = [];
  await receiveIfStale(home, { poll: async deps => { seen.push(deps); return { received: [] }; } });
  assert.equal(seen[0].executePrompts, false, 'hook 経由の受信は prompt を実行しない');
});
test('main polls when stale before injecting context', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-inbox-ctx-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, '.claude', 'fleet-inbox'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'fleet-inbox', 'mail-a1.json'), JSON.stringify({ id: 'mail-a1', from: 'PC', kind: 'note', why: 'w', body: 'b', createdAt: '2026-10-10T00:00:00Z' }));
  const polls = [];
  const outputs = [];
  await main({ home, readStdin: async () => '{"prompt":"hello"}', stdout: t2 => outputs.push(t2), poll: async () => { polls.push(1); return {}; } });
  assert.equal(polls.length, 1);
  assert.equal(outputs.length, 1);
  assert.match(outputs[0], /mail-a1/);
});
