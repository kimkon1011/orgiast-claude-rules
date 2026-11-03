import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { judgeNextAction, SESSION_PHRASES } from './next-action-gate.mjs';

const report = body => `${body}\n次に kim がすること: なし\nこの後の自動進行: なし\nこのセッション: ${SESSION_PHRASES.delete}`;
const row = (type, content) => JSON.stringify({ type, message: { role: type, content } });
const call = row('assistant', [{ type: 'tool_use', name: 'CronCreate', id: 'cron', input: { cron: '*/20 * * * *', prompt: '作業を続ける' } }]);
const result = error => row('user', [{ type: 'tool_result', tool_use_id: 'cron', content: error ? 'denied' : 'Created job abc', is_error: error }]);
const code = 'SELF-DEFERRAL-NEEDS-CRON-CHECK';

test('自分の作業の先送りには同ターン CronCreate 成功と同一 session の永続 check の両方が必要', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'self-deferral-'));
  const previous = process.env.ORGIAST_HOME;
  process.env.ORGIAST_HOME = home;
  t.after(() => { if (previous === undefined) delete process.env.ORGIAST_HOME; else process.env.ORGIAST_HOME = previous; });
  fs.mkdirSync(path.join(home, '.claude'));
  const file = path.join(home, '.claude', 'auto-progress-ledger.jsonl');
  const input = { session_id: 'self' };
  const text = report('次のメッセージで仕上げます。');
  const success = `${call}\n${result(false)}`;
  assert.equal(judgeNextAction(text, success, input).code, code);
  for (const record of [
    { sessionId: 'other', status: 'open', check: 'node check.mjs' },
    { sessionId: 'self', status: 'done', check: 'node check.mjs' },
    { sessionId: 'self', status: 'open' },
  ]) {
    fs.writeFileSync(file, JSON.stringify(record) + '\n');
    assert.equal(judgeNextAction(text, success, input).code, code);
  }
  fs.writeFileSync(file, JSON.stringify({ sessionId: 'self', status: 'open', check: 'node check.mjs' }) + '\n');
  for (const raw of ['', call, `${call}\n${result(true)}`, `${success}\n${row('user', '続けて')}`]) {
    assert.equal(judgeNextAction(text, raw, input).code, code);
  }
  assert.equal(judgeNextAction(text, success, input).decision, 'pass');
  assert.equal(judgeNextAction('次ターンで修正します？', '', input).code, code);
  assert.equal(judgeNextAction('了解です', '', input, { turnText: text }).code, code);
});

test('引用・コード・過去の説明・否定・user の次のメッセージは対象外', () => {
  for (const body of ['> 次のメッセージで仕上げます', '```text\n次のメッセージで仕上げます\n```', '前回は次のメッセージで仕上げますと書きました。', '次のメッセージで仕上げるというパターンを検出します。', '次のメッセージで仕上げることはしません。', '次のメッセージで希望を教えてください。', '修正を完了しました。']) {
    assert.equal(judgeNextAction(report(body)).decision, 'pass', body);
  }
});
