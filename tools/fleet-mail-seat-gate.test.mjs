import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main, parseArgs, seatSendGate } from './fleet-mail.mjs';

test('kim操作席→kim-PCの件名・why・本文の全指定語を遮断', () => {
  for (const word of ['マージ', 'merge', 'push 権限', '権限', '招待', '鍵', 'キー', 'token', 'トークン', 'DWD', 'Vercel', 'Supabase', 'kim-PCにしか', 'kim-PCでしか', 'kim-PC でないと']) {
    for (const field of ['subject', 'why', 'body']) {
      const input = { to: 'kim-PC', kimOperated: true, [field]: word };
      assert(!seatSendGate(input).allowed, `${field}: ${word}`);
      assert(seatSendGate({ ...input, reason: 'ローカル原本の照会' }).allowed);
      assert(!seatSendGate({ ...input, reason: ' ' }).allowed);
      assert(seatSendGate({ ...input, kimOperated: false }).allowed);
      assert(seatSendGate({ ...input, to: 'nishi-PC' }).allowed);
    }
  }
  assert(seatSendGate({ to: 'kim-PC', kimOperated: true, body: '日程の相談' }).allowed);
});
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'seat-mail-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, '.claude'));
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'cr@orgiast.jp' } }));
  fs.writeFileSync(path.join(home, '.claude/fleet-sheet.env'), 'FLEET_SHEET_URL=https://example.invalid\nFLEET_SHEET_TOKEN=fixture\n');
  const body = path.join(home, 'body.txt'); fs.writeFileSync(body, 'マージを依頼');
  const sent = [], errors = [];
  const deps = { home, identity: { hostname: 'test' }, pcMap: {}, stdout() {}, stderr: s => errors.push(s),
    fetchBeacons: async () => ({ ok: true, beacons: [{ label: 'kim-PC' }], serverPolls: { 'kim-PC': new Date().toISOString() } }),
    request: async (kind, payload) => { sent.push(payload); return { mail: payload }; } };
  const args = ['--send', '--to', 'kim-PC', '--kind', 'note', '--why', '確認', '--body-file', body];
  return { home, body, sent, errors, deps, args };
}
test('送信前exit2。--force・dry-runでも遮断し、末尾の語も切り捨て前に検査', async t => {
  const f = fixture(t);
  fs.writeFileSync(f.body, 'x'.repeat(21000) + 'DWD');
  f.deps.fetchBeacons = () => { throw new Error('gate must precede network'); };
  for (const flags of [[], ['--force'], ['--dry-run']]) assert.equal(await main([...f.args, ...flags], f.deps), 2);
  assert.equal(f.sent.length, 0); assert(f.errors.every(s => s.includes('access-doctor.mjs --fix')));
});
test('ホスト名・別名で指定してもkim-PCへ解決した時点で遮断', async t => {
  const f = fixture(t);
  f.deps.pcMap = { 'kim-PC': { hostname: 'host-kim', aliases: ['owner-seat'] } };
  for (const alias of ['host-kim', 'owner-seat']) {
    const args = [...f.args]; args[args.indexOf('--to') + 1] = alias;
    assert.equal(await main([...args, '--force'], f.deps), 2);
  }
  assert.equal(f.sent.length, 0);
});
test('例外理由を送信payloadと送信成功ログに保存、空理由や他actionは拒否', async t => {
  const f = fixture(t), reason = 'kim-PC のローカル原本の確認';
  assert.equal(await main([...f.args, '--kim-pc-only-resource', reason], f.deps), 0);
  assert.equal(f.sent[0].kimPcOnlyResource, reason);
  const logs = fs.readFileSync(path.join(f.home, '.claude/fleet-mail-sent.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert(logs.some(row => row.action === 'sent' && row.kimPcOnlyResource === reason));
  assert.throws(() => parseArgs([...f.args, '--kim-pc-only-resource', ' ']));
  assert.throws(() => parseArgs(['--poll', '--kim-pc-only-resource', reason]));
});
