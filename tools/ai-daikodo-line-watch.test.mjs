import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { customerPending, ESCALATION, generateDecision, guardReply, main, parseDecision, processThreads, uuidV5 } from './ai-daikodo-line-watch.mjs';
const now = new Date('2026-11-24T10:00:00Z');
const thread = { threadId: 't1', lineUserId: 'Uabc', displayName: '顧客', messages: [{ id: 'm1', at: '2026-11-20T00:00:00Z', author: 'customer', text: '質問です' }] };
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-line-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, '.claude', 'ai-daikodo-line'); fs.mkdirSync(dir, { recursive: true });
  const state = {}, sent = [], notices = [];
  return { home, dir, state, sent, notices, opts: { home, now, state, decide: async () => ({ category: 'normal', reply: '承知しました。' }), send: async x => sent.push(x), notify: async x => notices.push(x) } };
}
test('customer判定と安定したUUID v5', () => {
  assert.equal(customerPending(thread), true);
  assert.equal(customerPending({ messages: [{ author: 'staff' }] }), false);
  assert.match(uuidV5('t1:m1'), /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(uuidV5('t1:m1'), uuidV5('t1:m1')); assert.notEqual(uuidV5('t1:m1'), uuidV5('t1:m2'));
});
test('通常返信を即時送信しinfo全文・重複はLLMも呼ばない', async t => {
  const f = fixture(t); let calls = 0;
  f.opts.decide = async () => { calls++; return { category: 'normal', reply: '承知しました。' }; };
  await processThreads([thread], f.opts); await processThreads([thread], f.opts);
  assert.equal(f.sent.length, 1); assert.equal(calls, 1); assert.equal(f.notices[0].kind, 'info');
  assert.match(f.notices[0].body, /質問です/); assert.match(f.notices[0].body, /承知しました/);
});
test('エスカレーションは定型文+askとinfoを各1件', async t => {
  const f = fixture(t); f.opts.decide = async () => ({ category: 'escalation', reply: '担当へ' });
  await processThreads([thread], f.opts);
  assert.equal(f.sent[0].text, ESCALATION); assert.deepEqual(f.notices.map(x => x.kind), ['info', 'ask']);
});
test('顧客の値引き要求は通常分類されてもエスカレーション', async t => {
  const f = fixture(t);
  await processThreads([{ ...thread, messages: [{ ...thread.messages[0], text: '値引きしてください' }] }], f.opts);
  assert.equal(f.sent[0].text, ESCALATION);
});
test('ガード違反は不送信+ask、再監視でLLM・通知を重複しない', async t => {
  const f = fixture(t); let calls = 0;
  f.opts.decide = async () => { calls++; return { category: 'normal', reply: '必ず2日までに納品します。3,000円です。' }; };
  await processThreads([thread], f.opts); await processThreads([thread], f.opts);
  assert.equal(f.sent.length, 0); assert.equal(f.notices.length, 1); assert.equal(calls, 1); assert.equal(f.notices[0].kind, 'ask');
});
test('金額・条件・納期・連絡先を機械検査', () => {
  for (const reply of ['1円です', '12円', '150,000円', '￥3000', '５０％割引', '初月無料', 'キャンペーンは2027-12-31まで', '3ヶ月契約', '毎月25,000円（税込）', '明日納品します', '3日以内に完成します', 'https://example.com', 'example.jp', 'x@example.jp', '09012345678', '03-1234-5678', 'あ'.repeat(1001)]) assert.ok(guardReply(reply, [], now).length, reply);
  assert.deepEqual(guardReply('月額50,000円（税抜）＋AIクレジット実費。初回1点無料＋初月半額¥25,000（税抜）。2026-12-31まで。相談無料。月単位・いつでも解約。', [], now), []);
  assert.deepEqual(guardReply(ESCALATION, [], now), []);
  assert.ok(guardReply('初月半額25,000円です', [], new Date('2027-01-01')).length);
});
test('3回目を30分間ガード', () => {
  const h = Array.from({ length: 2 }, () => ({ sentAt: now.toISOString() }));
  assert.ok(guardReply('返信', h, now).includes('30分以内に3回以上'));
  assert.deepEqual(guardReply('返信', h, new Date(+now + 1800001)), []);
});
test('キルスイッチは下書き+ask、解除後同じ返信を一度だけ送信', async t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.dir, 'autosend-off'), '');
  await processThreads([thread], f.opts); await processThreads([thread], f.opts);
  assert.equal(f.sent.length, 0); assert.equal(f.notices.length, 1);
  assert.equal(fs.readdirSync(path.join(f.dir, 'drafts')).length, 1);
  fs.unlinkSync(path.join(f.dir, 'autosend-off')); await processThreads([thread], f.opts);
  assert.equal(f.sent.length, 1);
});
test('生成中キルスイッチON、送信前スタッフ返信を再照合', async t => {
  const f = fixture(t);
  f.opts.refresh = async () => [{ ...thread, messages: [{ id: 'staff', author: 'staff' }] }];
  assert.equal((await processThreads([thread], f.opts))[0].action, 'superseded'); assert.equal(f.sent.length, 0);
  f.opts.refresh = async () => { fs.writeFileSync(path.join(f.dir, 'autosend-off'), ''); return [thread]; };
  await processThreads([thread], f.opts); assert.equal(f.sent.length, 0);
});
test('通知失敗後も送信台帳を保存し通知だけ再試行', async t => {
  const f = fixture(t); let disk;
  f.opts.persist = () => { disk = JSON.parse(JSON.stringify(f.state)); };
  f.opts.notify = async () => { throw Error('通知失敗'); };
  await assert.rejects(processThreads([thread], f.opts));
  assert.equal(disk.sent.length, 1); assert.equal(disk.outbox.length, 1);
  await processThreads([thread], { ...f.opts, state: disk, notify: async x => f.notices.push(x) });
  assert.equal(f.sent.length, 1); assert.equal(f.notices.length, 1);
});
test('送信結果不明の再試行は本文とUUIDを固定、23時間後は停止', async t => {
  const f = fixture(t); const attempts = [];
  f.opts.send = async x => { attempts.push(x); throw Error('timeout'); };
  await assert.rejects(processThreads([thread], f.opts));
  f.opts.decide = async () => assert.fail('regenerated');
  await assert.rejects(processThreads([thread], f.opts)); assert.deepEqual(attempts[0], attempts[1]);
  await processThreads([thread], { ...f.opts, now: new Date(+now + 24 * 3600000) });
  assert.equal(attempts.length, 2); assert.equal(f.notices[0].kind, 'ask');
});
test('新着なしはLLMを呼ばずstate更新', async t => {
  const f = fixture(t);
  assert.equal(await main({ ...f.opts, line: async () => ({ body: [] }), decide: async () => assert.fail() }), 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir, 'state.json'))).lastCheckedAt, now.toISOString());
});
test('古い未返信も復旧し、環境変数より保存鍵を優先', async t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.home, '.claude', 'tanom-admin.env'), 'TANOM_ADMIN_KEY=new-key\n');
  fs.writeFileSync(path.join(f.dir, 'state.json'), JSON.stringify({ lastCheckedAt: now.toISOString() }));
  fs.writeFileSync(path.join(f.dir, 'autosend-off'), '');
  const code = await main({ ...f.opts, env: { TANOM_ADMIN_KEY: 'old-key' }, fetchImpl: async (url, init) => {
    assert.equal(init.headers.Authorization, 'Bearer new-key');
    assert.equal(new URL(url).searchParams.get('since'), '2026-11-17T00:00:00Z'); return Response.json([thread]);
  } });
  assert.equal(code, 0); assert.equal(f.notices[0].kind, 'ask');
});
test('部分取得では送信せずカーソルも進めない', async t => {
  const f = fixture(t);
  assert.equal(await main({ ...f.opts, error: () => {}, line: async () => ({ body: { threads: [thread], incomplete: true } }), decide: async () => assert.fail() }), 1);
  assert.equal(f.sent.length, 0); assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir, 'state.json'))).lastCheckedAt, undefined);
});
test('同原因の2連続失敗でask1件・回復を挟んでもdedupe', async t => {
  const f = fixture(t); const opt = { ...f.opts, error: () => {}, line: async () => { throw Error('admin API HTTP 401'); } };
  for (let i = 0; i < 3; i++) assert.equal(await main(opt), 1);
  assert.equal(f.notices.length, 1);
  assert.equal(await main({ ...opt, line: async () => ({ body: [] }) }), 0);
  for (let i = 0; i < 2; i++) await main(opt);
  assert.equal(f.notices.length, 1);
});
test('壊れたstateは上書きせず停止、並行監視は実行しない', async t => {
  const f = fixture(t), sf = path.join(f.dir, 'state.json'); fs.writeFileSync(sf, 'broken');
  assert.equal(await main({ ...f.opts, error: () => {}, line: async () => assert.fail() }), 1);
  assert.equal(fs.readFileSync(sf, 'utf8'), 'broken');
  fs.writeFileSync(path.join(f.dir, 'watch.lock'), String(process.pid));
  assert.equal(await main({ ...f.opts, line: async () => assert.fail() }), 0);
});
test('LLM不正JSONは次の他AIへ、Claudeも自動fallbackも禁止', async t => {
  const f = fixture(t), calls = [];
  const d = await generateDecision(f.home, 'guide', thread, { exec: (_, args) => {
    calls.push(args); return { status: 0, stdout: calls.length < 3 ? '{}' : '{"category":"normal","reply":"承知しました"}' };
  } });
  assert.equal(d.category, 'normal'); assert.equal(calls.length, 3);
  for (const args of calls) { assert.ok(args.includes('--no-fallback')); assert.ok(args.includes('--prefer-provider')); assert.doesNotMatch(args[args.indexOf('--model') + 1], /claude|anthropic/i); }
  for (const value of ['{}', '{"reply":"x"}', '{"category":"normal","reply":""}']) assert.throws(() => parseDecision(value));
});
