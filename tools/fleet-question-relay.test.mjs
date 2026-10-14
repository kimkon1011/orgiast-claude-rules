import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { main, detectQuestion, readTranscriptTail, readQuestion, updateQuestion, TRANSCRIPT_TAIL_BYTES, QUESTION_LIMIT, SUMMARY_LIMIT, HOOK_DEADLINE_MS } from './fleet-question-relay.mjs';
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
test('real Stop CLI exits zero within the hook deadline for a missing transcript', t => {
  const f = fixture(t), start = performance.now();
  // fileURLToPath で Windows と URL エンコードを扱い、repo 外の cwd から起動する。
  const cli = fileURLToPath(new URL('./fleet-question-relay.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [cli], { cwd: f.home, input: JSON.stringify(f.input), encoding: 'utf8', timeout: HOOK_DEADLINE_MS, env: { ...process.env, ORGIAST_HOME: f.home } });
  assert.equal(result.status, 0); assert.equal(result.stdout, ''); assert.equal(result.stderr, ''); assert.ok(performance.now() - start < HOOK_DEADLINE_MS);
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

import { hasNewUserMessage } from './fleet-question-relay.mjs';
for (const event of ['PreToolUse', 'Notification', 'Stop']) test(`G8 ${event} records questions once with event-specific input`, async t => {
  const f = fixture(t); const question = '続行しますか？';
  f.input.hook_event_name = event;
  f.input.tool_name = 'AskUserQuestion';
  f.input.tool_input = { questions: [{ question, options: [{ label: 'A', description: '進める' }] }] };
  f.input.message = question;
  fs.writeFileSync(f.transcript, JSON.stringify(assistant(question)) + '\n');
  await f.run({ now: () => 1000 });
  const before = readQuestion(f.home, f.input.session_id);
  assert.equal(before.question, question);
  if (event === 'PreToolUse') assert.deepEqual(before.options[0].options, f.input.tool_input.questions[0].options);
  updateQuestion(f.home, f.input.session_id, q => ({ ...q, relayedAt: 'sent' }));
  await f.run({ now: () => 2000 });
  const after = readQuestion(f.home, f.input.session_id);
  assert.equal(after.askedAt, before.askedAt); assert.equal(after.relayedAt, 'sent');
});
test('G8 PreToolUse and Stop deduplicate the same AskUserQuestion', async t => {
  const f = fixture(t), questions = [{ question: '続行？', options: [{ label: 'A' }] }];
  f.input.hook_event_name = 'PreToolUse'; f.input.tool_name = 'AskUserQuestion'; f.input.tool_input = { questions };
  fs.writeFileSync(f.transcript, ''); await f.run();
  updateQuestion(f.home, f.input.session_id, q => ({ ...q, relayedAt: 'sent' }));
  const before = readQuestion(f.home, f.input.session_id);
  fs.writeFileSync(f.transcript, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'AskUserQuestion', input: { questions } }] } }) + '\n');
  f.input.hook_event_name = 'Stop'; await f.run();
  assert.deepEqual(readQuestion(f.home, f.input.session_id), before);
});
test('G11 offsets end at complete JSONL lines and malformed fragments do not suppress relay', async t => {
  const f = fixture(t), complete = JSON.stringify(assistant('続行？')) + '\n';
  const partial = JSON.stringify({ type: 'user', message: { content: '進めて' } });
  fs.writeFileSync(f.transcript, complete + partial.slice(0, 12));
  await f.run(); const q = readQuestion(f.home, f.input.session_id);
  assert.equal(q.transcriptOffset, Buffer.byteLength(complete));
  assert.equal(await hasNewUserMessage(q), false);
  fs.appendFileSync(f.transcript, partial.slice(12) + '\n');
  assert.equal(await hasNewUserMessage(q), true);
  fs.writeFileSync(f.transcript, complete + 'invalid json\n' + JSON.stringify(assistant('続行？')) + '\n');
  assert.equal(await hasNewUserMessage(q), false);
  fs.appendFileSync(f.transcript, 'invalid again\n' + partial + '\n');
  assert.equal(await hasNewUserMessage(q), true);
});

test('G11 long incomplete line still saves the last complete byte offset', async t => {
  const f = fixture(t), complete = JSON.stringify(assistant('続行？')) + '\n';
  fs.writeFileSync(f.transcript, complete + '{"unfinished":"' + 'x'.repeat(TRANSCRIPT_TAIL_BYTES * 2));
  await f.run();
  const q = readQuestion(f.home, f.input.session_id);
  assert.equal(q.transcriptOffset, Buffer.byteLength(complete));
  assert.equal(await hasNewUserMessage(q), false);
});

test('G8 Notification AskUserQuestion and Stop share one relay identity for the same question', async t => {
  const f = fixture(t), question = '続行？';
  fs.writeFileSync(f.transcript, '');
  f.input.hook_event_name = 'Notification'; f.input.message = question;
  await f.run({ now: () => 1000 });
  updateQuestion(f.home, f.input.session_id, q => ({ ...q, relayedAt: 'sent' }));
  const first = readQuestion(f.home, f.input.session_id);
  f.input.hook_event_name = 'PreToolUse'; f.input.tool_name = 'AskUserQuestion';
  f.input.tool_input = { questions: [{ question, options: [{ label: 'A', description: '進める' }] }] };
  await f.run({ now: () => 2000 });
  const enriched = readQuestion(f.home, f.input.session_id);
  assert.deepEqual(enriched.options[0].options, f.input.tool_input.questions[0].options);
  assert.equal(enriched.questionHash, first.questionHash); assert.equal(enriched.relayedAt, first.relayedAt); assert.equal(enriched.askedAt, first.askedAt);
  await f.run({ now: () => 2500 });
  assert.deepEqual(readQuestion(f.home, f.input.session_id), enriched);
  fs.writeFileSync(f.transcript, JSON.stringify(assistant(question)) + '\n');
  f.input.hook_event_name = 'Stop'; await f.run({ now: () => 3000 });
  assert.deepEqual(readQuestion(f.home, f.input.session_id), enriched);
});
