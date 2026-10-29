import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { judgeNextAction, SESSION_PHRASES } from './next-action-gate.mjs';

const report = (body, autopilot = 'なし') => `${body}\n次に kim がすること: なし\nこの後の自動進行: ${autopilot}\nこのセッション: ${SESSION_PHRASES.delete}`;
const handoff = '[手渡し判定]\nDiscord の転送操作をお願いします。';
const code = 'NEXT-ACTION-HUMAN-WAIT-NEEDS-CHECK';

// 既存テストと同じ ORGIAST_HOME 注入点で、実台帳には触れずに検証する。
function withLedger(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'next-action-user-wait-'));
  const previous = process.env.ORGIAST_HOME;
  process.env.ORGIAST_HOME = home;
  t.after(() => {
    if (previous === undefined) delete process.env.ORGIAST_HOME;
    else process.env.ORGIAST_HOME = previous;
    fs.rmSync(home, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(home, '.claude'));
  return path.join(home, '.claude', 'auto-progress-ledger.jsonl');
}

test('本文の手渡し判定は nextAction=なしでも台帳なしなら block', t => {
  withLedger(t);
  const result = judgeNextAction(report(handoff), '', { session_id: 'user-wait' });
  assert.equal(result.decision, 'block');
  assert.equal(result.code, code);
  assert.ok(result.reason.startsWith('user 本人への手渡し（[手渡し判定]／お願いする操作）も人待ちです。'));
});

test('本人手渡しでも理由付き NO-AUTOCHECK-OK なら pass', t => {
  withLedger(t);
  assert.equal(judgeNextAction(report(`${handoff}\n[NO-AUTOCHECK-OK: 転送結果を自動取得できないため]`)).decision, 'pass');
  for (const reason of ['', '   ']) {
    assert.equal(judgeNextAction(report(`${handoff}\n[NO-AUTOCHECK-OK: ${reason}]`)).code, code);
  }
});

test('手渡しマーカーのない nextAction=なしは従来どおり pass', t => {
  withLedger(t);
  assert.equal(judgeNextAction(report('修正を完了しました。')).decision, 'pass');
});

test('お願いする操作と行頭の手間監査も本人手渡しとして扱う', t => {
  withLedger(t);
  for (const body of ['お願いする操作: Discord の転送', '手間監査: 本人の転送操作が必要']) {
    assert.equal(judgeNextAction(report(body)).code, code, body);
  }
  assert.equal(judgeNextAction(report('説明中の手間監査: という表記')).decision, 'pass');
});

test('本人手渡しには同一 session の open 台帳行だけを認める', t => {
  const file = withLedger(t);
  const input = { session_id: 'user-wait' };
  for (const status of ['open', 'done', 'superseded', 'waiting_user', 'stalled', 'resumed']) {
    fs.writeFileSync(file, JSON.stringify({ sessionId: input.session_id, status, check: 'node check.mjs' }) + '\n');
    const result = judgeNextAction(report(handoff), '', input);
    if (status === 'open') assert.equal(result.decision, 'pass');
    else assert.equal(result.code, code, status);
  }
  fs.writeFileSync(file, JSON.stringify({ sessionId: 'other', status: 'open', check: 'node check.mjs' }) + '\n');
  assert.equal(judgeNextAction(report(handoff), '', input).code, code);
});

test('本人手渡しマーカーがあってもチャット返信だけなら pass', t => {
  withLedger(t);
  assert.equal(judgeNextAction(report('[手渡し判定]\nA案とB案のどちらか教えてください。')).decision, 'pass');
});

test('手渡しマーカーは footer より前だけを検査する', t => {
  withLedger(t);
  assert.equal(judgeNextAction(report('作業を完了しました。', 'なし（お願いする操作はありません）')).decision, 'pass');
});
