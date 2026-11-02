import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply as applyReal, desiredTitle, sweepAll as sweepAllReal, waitPrefix } from './session-wait-title.mjs';

const apply = input => applyReal(input, { resolvePcNumber: () => '' });
const sweepAll = options => sweepAllReal({ ...options, resolvePcNumber: () => '' });

const footer = state => `本文\n\n次に kim がすること: なし\nこの後の自動進行: 毎時の見張りが保存を確かめて報告する\nこのセッション: ${state}`;
const ai = JSON.stringify({ type: 'ai-title', aiTitle: 'トークン待ち', sessionId: 's' });
const custom = title => JSON.stringify({ type: 'custom-title', customTitle: title, sessionId: 's' });
const WAIT = 'まだ閉じない（作業中・2026-11-02 20:11 まで待つ）';

test('waitPrefix は年なしの【11/02/20:11まで】', () => {
  assert.equal(waitPrefix(new Date(2026, 10, 2, 20, 11)), '【11/02/20:11まで】');
});

test('まだ閉じない（期限入り）なら ai-title の頭に期限を付ける', () => {
  assert.equal(desiredTitle(footer(WAIT), ai), '【11/02/20:11まで】トークン待ち');
  assert.equal(desiredTitle(footer('/session-close をして（まだ閉じない・2026-11-02 20:11 まで待つ）'), ai), '【11/02/20:11まで】トークン待ち');
});

test('期限が変わったら付け替え、同じなら書かない。旧形式（年あり）は新形式へ付け替える', () => {
  assert.equal(desiredTitle(footer(WAIT), `${ai}\n${custom('【11/01/09:00まで】名前付き')}`), '【11/02/20:11まで】名前付き');
  assert.equal(desiredTitle(footer(WAIT), `${ai}\n${custom('【11/02/20:11まで】名前付き')}`), null);
  assert.equal(desiredTitle(footer(WAIT), `${ai}\n${custom('【26/11/02/20:11まで】名前付き')}`), '【11/02/20:11まで】名前付き');
});

test('閉じてよいになったら期限だけ外す（旧形式も）。フッター無し・期限を付けていないなら何もしない', () => {
  const closed = footer('/session-close は終わっているので、このセッションを閉じてよい');
  assert.equal(desiredTitle(closed, custom('【11/01/09:00まで】名前付き')), '名前付き');
  assert.equal(desiredTitle(closed, custom('【26/11/01/09:00まで】名前付き')), '名前付き');
  assert.equal(desiredTitle(closed, ai), null);
  assert.equal(desiredTitle('フッターなし', custom('【11/01/09:00まで】名前付き')), null);
});

const assistant = text => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } });

test('apply は transcript に custom-title 行を追記し、subagent には書かない', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swt-'));
  const file = path.join(dir, 's.jsonl');
  fs.writeFileSync(file, `${ai}\n${assistant(footer(WAIT))}\n`);
  assert.equal(apply({ transcript_path: file, session_id: 's' }), '【11/02/20:11まで】トークン待ち');
  const last = JSON.parse(fs.readFileSync(file, 'utf8').trim().split('\n').at(-1));
  assert.deepEqual(last, { type: 'custom-title', customTitle: '【11/02/20:11まで】トークン待ち', sessionId: 's', source: 'orgiast-auto' });
  assert.equal(apply({ transcript_path: file, session_id: 's' }), null);
  assert.equal(apply({ transcript_path: path.join(dir, 'subagents', 'x.jsonl'), session_id: 's' }), null);
});

test('sweepAll は全プロジェクトの待ちセッションに付け、1時間以内の再実行は飛ばす', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'swt-all-'));
  const proj = path.join(base, 'projects', 'p1');
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, 'aaaaaaaa-1.jsonl'), `${ai}\n${assistant(footer(WAIT))}\n`);
  fs.writeFileSync(path.join(proj, 'bbbbbbbb-2.jsonl'), `${ai}\n${assistant(footer('/session-close は不要なので、このセッションを閉じてよい'))}\n`);
  const now = Date.now();
  const result = sweepAll({ base, now });
  assert.equal(result.scanned, 2);
  assert.deepEqual(result.titled, [{ session: 'aaaaaaaa', title: '【11/02/20:11まで】トークン待ち' }]);
  const last = JSON.parse(fs.readFileSync(path.join(proj, 'aaaaaaaa-1.jsonl'), 'utf8').trim().split('\n').at(-1));
  assert.equal(last.sessionId, 'aaaaaaaa-1');
  assert.deepEqual(sweepAll({ base, now: now + 1000 }), { skipped: 'cooldown' });
});

const auto = title => JSON.stringify({ type: 'custom-title', customTitle: title, source: 'orgiast-auto' });
test('PC番号: フッターなしでも付与し、同じタイトルは追記しない', () => {
  assert.equal(desiredTitle('本文', ai, '018'), '018｜トークン待ち');
  assert.equal(desiredTitle('本文', custom('018｜トークン待ち'), '018'), null);
  assert.equal(desiredTitle('本文', custom('【11/02/20:11まで】名前'), '018'), '018｜【11/02/20:11まで】名前');
  assert.equal(desiredTitle('本文', custom('018｜【11/02/20:11まで】名前'), '018'), null);
});
test('PC番号: 期限付与・変更・解除でも番号が先頭', () => {
  assert.equal(desiredTitle(footer(WAIT), ai, '018'), '018｜【11/02/20:11まで】トークン待ち');
  assert.equal(desiredTitle(footer(WAIT), custom('018｜【11/01/09:00まで】名前'), '018'), '018｜【11/02/20:11まで】名前');
  assert.equal(desiredTitle(footer('閉じてよい'), custom('018｜【11/02/20:11まで】名前'), '018'), '018｜名前');
});
test('自動タイトルの後のAI名を採用し、人のrenameは保持する', () => {
  const newer = JSON.stringify({ type: 'ai-title', aiTitle: '請求書確認' });
  assert.equal(desiredTitle('', `${auto('018｜最初の発言')}\n${newer}`, '018'), '018｜請求書確認');
  assert.equal(desiredTitle('', `${custom('手で付けた名前')}\n${newer}`, '018'), '018｜手で付けた名前');
  assert.equal(desiredTitle('', `${newer}\n${auto('018｜最初の発言')}`, '018'), null);
  assert.equal(desiredTitle('', `${auto('018｜最初の発言')}\n${newer}\n${custom('手で付けた名前')}`, '018'), '018｜手で付けた名前');
});
test('PC番号なしはフッターなし・期限なしで従来どおり何もしない', () => {
  assert.equal(desiredTitle('', ai, ''), null);
  assert.equal(desiredTitle(footer('閉じてよい'), ai, ''), null);
});
test('sweepAll は注入したPC番号を全件に適用し、追記は冪等', t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'swt-pc-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const proj = path.join(base, 'projects', 'p');
  fs.mkdirSync(proj, { recursive: true });
  const file = path.join(proj, 's.jsonl');
  fs.writeFileSync(file, ai);
  const options = { base, force: true, resolvePcNumber: () => '018' };
  assert.equal(sweepAllReal(options).titled[0].title, '018｜トークン待ち');
  const raw = fs.readFileSync(file, 'utf8');
  assert.equal(JSON.parse(raw.trim().split('\n').at(-1)).source, 'orgiast-auto');
  assert.equal(sweepAllReal(options).titled.length, 0);
  assert.equal(fs.readFileSync(file, 'utf8'), raw);
});
