import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { registerStopViolation, summarizeStopRechecks } from './stop-recheck.mjs';

test('同一応答は複数hookでも1 block、書き直し2回後はpass_after_cap', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-recheck-')); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const input = { session_id: 's', stop_hook_active: true };
  assert.equal(registerStopViolation({ input, assistantText: 'one', blockedBy: ['a'], reasonCodes: ['A'], home }).blockNumber, 1);
  assert.equal(registerStopViolation({ input, assistantText: 'one', blockedBy: ['b'], reasonCodes: ['B'], home }).blockNumber, 1);
  assert.equal(registerStopViolation({ input, assistantText: 'two', blockedBy: ['a'], reasonCodes: ['A'], home }).verdict, 'block');
  const capped = registerStopViolation({ input, assistantText: 'three', blockedBy: ['a'], reasonCodes: ['A'], home });
  assert.equal(capped.verdict, 'pass_after_cap');
  assert.match(capped.additionalContext, /次の応答で必ず訂正/);
});

test('日次集計は旧skippedとpass_after_capを数える', () => {
  const rows = [
    { ts: '2026-10-18T00:00:00Z', verdict: 'skipped', reasonCodes: ['stop_hook_active'] },
    { ts: '2026-10-18T00:00:01Z', verdict: 'pass_after_cap' },
  ];
  assert.deepEqual(summarizeStopRechecks(rows, { since: Date.parse('2026-10-18') }), { skippedStopHookActive: 1, passAfterCap: 1 });
});

for (const withPromptId of [true, false]) {
  test(`差し戻しとtool_resultは同一ターン、新しい人の発言でリセット (promptId=${withPromptId})`, t => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-recheck-turn-')); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    const file = path.join(home, 'transcript.jsonl');
    const input = { session_id: 'turn', transcript_path: file };
    const append = (row, promptId = 'first') => fs.appendFileSync(file, JSON.stringify({ ...row, ...(withPromptId ? { promptId } : {}) }) + '\n');
    append({ type: 'user', uuid: 'human-1', message: { role: 'user', content: '直して' } });
    for (let attempt = 1; attempt <= 3; attempt++) {
      const result = registerStopViolation({ input, assistantText: `response-${attempt}`, blockedBy: ['a'], home });
      assert.equal(result.blockNumber, attempt);
      assert.equal(result.retryCap, attempt === 3);
      assert.equal(result.verdict, attempt === 3 ? 'pass_after_cap' : 'block');
      append({ type: 'user', uuid: `feedback-${attempt}`, isMeta: true, message: { role: 'user', content: 'Stop hook feedback:\n修正してください' } });
      append({ type: 'user', uuid: `tool-${attempt}`, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool', content: 'ok' }] } });
    }
    append({ type: 'user', uuid: 'human-2', message: { role: 'user', content: '次も直して' } }, 'second');
    const next = registerStopViolation({ input, assistantText: 'new response', blockedBy: ['a'], home });
    assert.equal(next.blockNumber, 1);
    assert.equal(next.retryCap, false);
  });
}

test('旧形式ではisMeta単独・feedback文字列・tool_result配列をそれぞれ飛ばす', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-recheck-legacy-')); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const file = path.join(home, 'transcript.jsonl');
  const input = { session_id: 'legacy', transcript_path: file };
  fs.writeFileSync(file, JSON.stringify({ type: 'user', message: { content: '直して' } }) + '\n');
  const first = registerStopViolation({ input, assistantText: 'first', home });
  for (const row of [
    { type: 'user', isMeta: true, message: { content: 'meta' } },
    { type: 'user', content: 'Stop hook feedback:\n修正' },
    { type: 'user', message: { content: [{ type: 'tool_result', content: 'one' }, { type: 'tool_result', content: 'two' }] } },
  ]) {
    fs.appendFileSync(file, JSON.stringify(row) + '\n');
    assert.equal(registerStopViolation({ input, assistantText: JSON.stringify(row), home }).turnKey, first.turnKey);
  }
});

test('promptIdはuser以外の末尾行からも優先し、不正JSONとID無しの行は飛ばす', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-recheck-id-')); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const file = path.join(home, 'transcript.jsonl');
  const input = { session_id: 'id', transcript_path: file };
  fs.writeFileSync(file, JSON.stringify({ type: 'assistant', promptId: 'latest' }) + '\n');
  const first = registerStopViolation({ input, assistantText: 'first', home });
  fs.appendFileSync(file, '{invalid\n' + JSON.stringify({ type: 'user', message: { content: 'ID無し' } }) + '\n');
  const second = registerStopViolation({ input, assistantText: 'second', home });
  assert.match(first.turnKey, /^promptId:/);
  assert.equal(second.turnKey, first.turnKey);
  assert.equal(second.blockNumber, 2);
});

test('旧形式で人の発言が末尾400行より前でもターン鍵を保持する', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-recheck-long-')); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const file = path.join(home, 'transcript.jsonl');
  const input = { session_id: 'long', transcript_path: file };
  fs.writeFileSync(file, JSON.stringify({ type: 'user', message: { content: '直して' } }) + '\n');
  const first = registerStopViolation({ input, assistantText: 'first', home });
  fs.appendFileSync(file, (JSON.stringify({ type: 'user', isMeta: true, message: { content: 'Stop hook feedback: 修正' } }) + '\n').repeat(401));
  const second = registerStopViolation({ input, assistantText: 'second', home });
  assert.equal(second.turnKey, first.turnKey);
  assert.equal(second.blockNumber, 2);
});
