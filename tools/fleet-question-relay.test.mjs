import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { main, detectQuestion, readTranscriptTail, readQuestion, updateQuestion, TRANSCRIPT_TAIL_BYTES, QUESTION_LIMIT, SUMMARY_LIMIT } from './fleet-question-relay.mjs';
const assistant = text => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-question-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, '.claude'); fs.mkdirSync(dir);
  const config = path.join(dir, 'fleet-sheet.env'); fs.writeFileSync(config, 'FLEET_HUB=kim-PC\n');
  const transcript = path.join(home, 'session.jsonl');
  const input = { session_id: 'session-1', cwd: home, transcript_path: transcript };
  const run = extra => main({ home, readStdin: async () => JSON.stringify(input), ...extra });
  return { home, config, transcript, input, run };
}
for (const text of ['続行しますか?', 'どちらでしょう？', 'どうしますか。', 'どちらにしますか。', '選んでください。', '確認してください。', '教えてください。']) {
  test(`final natural-language question: ${text}`, () => assert.ok(detectQuestion(assistant(text))));
}
for (const text of ['完了しました。', '質問ですか？\n検証完了。', '1. ファイルを確認してください', '- 選んでください', '```js\nquestion?\n```', '```js\nquestion?', '`どうしますか?`', '> どちらにしますか？']) {
  test(`non-question or code/steps excluded: ${text}`, () => assert.equal(detectQuestion(assistant(text)), null));
}
test('AskUserQuestion preserves redacted labels/descriptions, and caps question and summary', () => {
  const record = assistant('作業要約'.repeat(SUMMARY_LIMIT));
  record.message.content.push({ type: 'tool_use', name: 'AskUserQuestion', input: { questions: [{ question: '質問'.repeat(QUESTION_LIMIT), options: [{ label: 'A', description: 'token=private' }] }] } });
  const found = detectQuestion(record);
  assert.equal(found.question.length, QUESTION_LIMIT); assert.equal(found.summary.length, SUMMARY_LIMIT);
  assert.equal(found.options[0].options[0].label, 'A'); assert.doesNotMatch(JSON.stringify(found), /private/);
});
test('reads only the final 64KB and discards a partial first JSON line', t => {
  const f = fixture(t);
  fs.writeFileSync(f.transcript, JSON.stringify(assistant('x'.repeat(TRANSCRIPT_TAIL_BYTES * 3))) + '\n' + JSON.stringify(assistant('最後の質問？')) + '\n');
  const reads = [];
  const io = { ...fs, readFileSync: () => { throw new Error('whole file forbidden'); }, readSync: (...args) => { reads.push({ length: args[3], position: args[4] }); return fs.readSync(...args); } };
  const result = readTranscriptTail(f.transcript, io);
  assert.equal(reads.length, 1); assert.equal(reads[0].length, TRANSCRIPT_TAIL_BYTES); assert.equal(reads[0].position, result.size - TRANSCRIPT_TAIL_BYTES);
  assert.equal(result.records.length, 1); assert.ok(detectQuestion(result.records[0]));
});
test('same question does not reset askedAt or relay state; next question preserves hub execution ownership', async t => {
  const f = fixture(t); fs.writeFileSync(f.transcript, JSON.stringify(assistant('Aにしますか？')) + '\n');
  await f.run({ now: () => 1000 });
  updateQuestion(f.home, f.input.session_id, q => ({ ...q, relayedAt: 'done', resumingAt: 'active', drivenByHub: true, resumeMailId: 'mail-test' }));
  const before = readQuestion(f.home, f.input.session_id);
  await f.run({ now: () => 2000 }); assert.deepEqual(readQuestion(f.home, f.input.session_id), before);
  fs.appendFileSync(f.transcript, JSON.stringify(assistant('Bにしますか？')) + '\n');
  await f.run({ now: () => 3000 });
  const next = readQuestion(f.home, f.input.session_id);
  assert.notEqual(next.questionHash, before.questionHash); assert.equal(next.relayedAt, null); assert.equal(next.drivenByHub, true); assert.equal(next.resumeMailId, 'mail-test');
});
test('no hub, active Stop, invalid session, missing transcript, or later human user produces no question', async t => {
  const f = fixture(t); fs.writeFileSync(f.transcript, JSON.stringify(assistant('続行？')) + '\n');
  fs.writeFileSync(f.config, ''); await f.run(); assert.equal(readQuestion(f.home, 'session-1'), null);
  fs.writeFileSync(f.config, 'FLEET_HUB=kim-PC\n');
  f.input.stop_hook_active = true; await f.run(); assert.equal(readQuestion(f.home, 'session-1'), null);
  f.input.stop_hook_active = false; f.input.session_id = '../escape'; await f.run(); assert.equal(readQuestion(f.home, 'session-1'), null);
  f.input.session_id = 'session-1'; fs.appendFileSync(f.transcript, JSON.stringify({ type: 'user', message: { content: '進めて' } }) + '\n');
  await f.run(); assert.equal(readQuestion(f.home, 'session-1'), null);
  fs.unlinkSync(f.transcript); await f.run(); assert.equal(readQuestion(f.home, 'session-1'), null);
});
test('headless new session records hub-driven state; secrets never enter question file', async t => {
  const f = fixture(t); fs.writeFileSync(f.transcript, JSON.stringify(assistant('token=private\n続行？')) + '\n');
  await f.run({ env: { FLEET_DRIVEN_BY_HUB: '1' } });
  assert.equal(readQuestion(f.home, 'session-1').drivenByHub, true);
  assert.doesNotMatch(JSON.stringify(readQuestion(f.home, 'session-1')), /private/);
});
test('real Stop CLI exits zero within two seconds for a missing transcript', t => {
  const f = fixture(t), start = performance.now();
  const result = spawnSync(process.execPath, ['tools/fleet-question-relay.mjs'], { input: JSON.stringify(f.input), encoding: 'utf8', timeout: 2000, env: { ...process.env, ORGIAST_HOME: f.home } });
  assert.equal(result.status, 0); assert.equal(result.stdout, ''); assert.equal(result.stderr, ''); assert.ok(performance.now() - start < 2000);
});

import { questionPath, QUESTION_LOCK_MS } from './fleet-question-relay.mjs';
test('question state lock skips a live owner and reclaims a stale crashed writer', t => {
  const f = fixture(t), lock = questionPath(f.home, 't') + '.lock'; fs.mkdirSync(path.dirname(lock)); fs.writeFileSync(lock, 'crashed');
  assert.equal(updateQuestion(f.home, 't', () => ({ sessionId: 't' })), null);
  const old = new Date(Date.now() - QUESTION_LOCK_MS - 1000); fs.utimesSync(lock, old, old);
  assert.equal(updateQuestion(f.home, 't', () => ({ sessionId: 't' })).sessionId, 't'); assert.equal(fs.existsSync(lock), false);
});
test('long final text retains its actual question and leading work summary', () => {
  const text = '検証済み。'.repeat(QUESTION_LIMIT) + '\n次はどうしますか？';
  const result = detectQuestion(assistant(text)); assert.ok(result.question.endsWith('次はどうしますか？')); assert.equal(result.question.length, QUESTION_LIMIT); assert.ok(result.summary.startsWith('検証済み。'));
  assert.equal(detectQuestion(assistant('return condition ?')), null);
});
