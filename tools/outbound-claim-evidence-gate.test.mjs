import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { judge } from './outbound-claim-evidence-gate.mjs';

const user = { type: 'user', message: { role: 'user', content: '送信してください' } };
const assistant = text => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
const notification = { type: 'user', message: { role: 'user', content: '<task-notification>完了</task-notification>' } };
const fixture = (t, script, transcript = [user]) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outbound-claim-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'send.mjs'), script);
  fs.writeFileSync(path.join(dir, 'transcript.jsonl'), transcript.map(x => JSON.stringify(x)).join('\n'));
  return { tool_name: 'Bash', tool_input: { command: 'node send.mjs' }, cwd: dir, transcript_path: path.join(dir, 'transcript.jsonl') };
};
const line = body => `fetch('https://api.line.me/v2/bot/message/push', {body: JSON.stringify({messages:[{text:\`${body}\`}]})})`;

test('事故の LINE push は証拠なし deny、対応する証拠タグで pass', async t => {
  const input = fixture(t, line('TimeRex より打ち合わせの日程を入力いたしました'));
  const blocked = await judge(input);
  assert.equal(blocked.decision, 'block');
  assert.match(blocked.reason, /TimeRex より打ち合わせの日程を入力いたしました/u);
  fs.writeFileSync(input.transcript_path, [user, assistant('[CLAIM-EVIDENCE: TimeRex 入力 => gmail:1a17abc]')].map(JSON.stringify).join('\n'));
  assert.equal((await judge(input)).decision, 'pass');
});

test('未来と依頼だけの LINE push は pass', async t => {
  for (const body of ['日程を入力いたします', 'ご入力ください']) assert.equal((await judge(fixture(t, line(body)))).decision, 'pass');
});

test('broadcast は既存ガードに任せる', async t => {
  assert.equal((await judge(fixture(t, `fetch('https://api.line.me/v2/bot/message/broadcast',{body:'予約しました'})`))).decision, 'pass');
});

test('gmail-draft --send --body-file の完了主張を deny', async t => {
  const input = fixture(t, 'console.log("unused")');
  fs.writeFileSync(path.join(input.cwd, 'body.txt'), 'お見積書を送付いたしました');
  input.tool_input.command = 'node tools/gmail-draft.mjs --send d1 --body-file body.txt';
  assert.equal((await judge(input)).decision, 'block');
});

test('Discord DM の本文にある完了主張を deny', async t => {
  const input = fixture(t, 'console.log("unused")');
  input.tool_input.command = 'node tools/discord-dm.mjs 池永様 --body "資料を共有しました"';
  assert.equal((await judge(input)).decision, 'block');
});

test('10文字以上の例外タグは task-notification を挟んでも pass', async t => {
  const input = fixture(t, line('TimeRex より打ち合わせの日程を入力いたしました'), [user, assistant('[OUTBOUND-CLAIM-OK: 返信文の引用で主張ではない]'), notification]);
  assert.equal((await judge(input)).decision, 'pass');
});

test('誤送信内容を撤回する謝罪文は完了主張として扱わない', async t => {
  const body = '先ほど「TimeRexより日程を入力いたしました」とお送りしましたが、こちらの手続きが完了しておらず、誤ったご連絡となってしまいました。';
  assert.equal((await judge(fixture(t, line(body)))).decision, 'pass');
});

test('例外時は stderr 相当へ1行警告して fail-open', async t => {
  const warnings = [];
  const input = fixture(t, line('予約しました'));
  input.tool_input.command = 'node missing.mjs';
  assert.equal((await judge(input, { warning: text => warnings.push(text) })).decision, 'pass');
  assert.equal(warnings.length, 1);
});
