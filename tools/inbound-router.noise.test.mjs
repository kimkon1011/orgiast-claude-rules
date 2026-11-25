import test from 'node:test'; import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { isBeeperNoise, writeDigest, initialState } from './inbound-router.mjs';
const cfg = { noiseChatTitles: ['^Yahoo!オークション$'] };
test('OTP/広告/空文は除外、普通の質問は残す', () => {
  assert.equal(isBeeperNoise({ text: '認証コードは 123456 です' }, cfg), true);
  assert.equal(isBeeperNoise({ text: '' }, cfg), true);
  assert.equal(isBeeperNoise({ text: 'クーポンをプレゼント！' }, cfg), true);
  assert.equal(isBeeperNoise({ title: 'Yahoo!オークション', text: '落札されました' }, cfg), true);
  assert.equal(isBeeperNoise({ title: 'なお', text: 'トライアルの課題で質問です。締切はいつですか？' }, cfg), false);
});
test('中身なしの「渡したが未着手」は1行に集約、要判断件数に入れない', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ir-')); const rep = path.join(dir, 'gb-reports');
  const state = initialState ? initialState() : { unknown: [], digests: {} };
  state.unknown = [{ id: 'a1', reason: '渡したが未着手', route: 'sales' }, { id: 'a2', reason: '渡したが未着手', route: 'sales' }, { id: 'x', item: { kind: 'beeper', title: 'なお', sender: 'なお', text: '質問です', time: 't' }, candidates: ['sales'] }];
  state.digests = {};
  const f = writeDigest({ state, now: Date.parse('2026-11-25T09:30:00Z'), reportDir: rep });
  const body = fs.readFileSync(f, 'utf8');
  assert.match(body, /要判断=1/); assert.match(body, /- sales: 2件/); assert.match(body, /### なお/);
});
test('18時台にも定時ダイジェストが出る', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ir-')); const rep = path.join(dir, 'gb-reports');
  const state = { unknown: [{ id: 'x', item: { title: 'A', text: 'b' } }], digests: { '2026-11-25-15': 1 } };
  assert.ok(writeDigest({ state, now: Date.parse('2026-11-25T09:30:00Z'), reportDir: rep }));
});
