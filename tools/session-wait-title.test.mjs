import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply, desiredTitle, waitPrefix } from './session-wait-title.mjs';

const footer = state => `本文\n\n次に kim がすること: なし\nこの後の自動進行: 毎時の見張りが保存を確かめて報告する\nこのセッション: ${state}`;
const ai = JSON.stringify({ type: 'ai-title', aiTitle: 'トークン待ち', sessionId: 's' });

test('waitPrefix は【26/11/02/20:11まで】の形', () => {
  assert.equal(waitPrefix(new Date(2026, 10, 2, 20, 11)), '【26/11/02/20:11まで】');
});

test('まだ閉じない（期限入り）なら ai-title の頭に期限を付ける', () => {
  assert.equal(desiredTitle(footer('まだ閉じない（作業中・2026-11-02 20:11 まで待つ）'), ai), '【26/11/02/20:11まで】トークン待ち');
  assert.equal(desiredTitle(footer('/session-close をして（まだ閉じない・2026-11-02 20:11 まで待つ）'), ai), '【26/11/02/20:11まで】トークン待ち');
});

test('期限が変わったら付け替え、同じなら書かない', () => {
  const custom = JSON.stringify({ type: 'custom-title', customTitle: '【26/11/01/09:00まで】名前付き', sessionId: 's' });
  assert.equal(desiredTitle(footer('まだ閉じない（作業中・2026-11-02 20:11 まで待つ）'), `${ai}\n${custom}`), '【26/11/02/20:11まで】名前付き');
  assert.equal(desiredTitle(footer('まだ閉じない（作業中・2026-11-01 09:00 まで待つ）'), `${ai}\n${custom}`), null);
});

test('閉じてよいになったら期限だけ外す。フッター無し・期限を付けていないなら何もしない', () => {
  const custom = JSON.stringify({ type: 'custom-title', customTitle: '【26/11/01/09:00まで】名前付き', sessionId: 's' });
  assert.equal(desiredTitle(footer('/session-close は終わっているので、このセッションを閉じてよい'), custom), '名前付き');
  assert.equal(desiredTitle(footer('/session-close は終わっているので、このセッションを閉じてよい'), ai), null);
  assert.equal(desiredTitle('フッターなし', custom), null);
});

test('apply は transcript に custom-title 行を追記し、subagent には書かない', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swt-'));
  const file = path.join(dir, 's.jsonl');
  const msg = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: footer('まだ閉じない（作業中・2026-11-02 20:11 まで待つ）') }] } });
  fs.writeFileSync(file, `${ai}\n${msg}\n`);
  assert.equal(apply({ transcript_path: file, session_id: 's' }), '【26/11/02/20:11まで】トークン待ち');
  const last = JSON.parse(fs.readFileSync(file, 'utf8').trim().split('\n').at(-1));
  assert.deepEqual(last, { type: 'custom-title', customTitle: '【26/11/02/20:11まで】トークン待ち', sessionId: 's' });
  assert.equal(apply({ transcript_path: file, session_id: 's' }), null);
  assert.equal(apply({ transcript_path: path.join(dir, 'subagents', 'x.jsonl'), session_id: 's' }), null);
});
