import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isUnchangedPeriodicReport } from './lib/unchanged-periodic-report.mjs';
import { readTranscriptContext } from './lib/assistant-text.mjs';
import { run } from './stop-gate-runner.mjs';

const periodic = '【定期の進捗確認（自動・user への質問ではない）】現在の状態を確認する';
const user = content => ({ type: 'user', message: { role: 'user', content } });
const assistant = content => ({ type: 'assistant', message: { role: 'assistant', content } });
const jsonl = entries => entries.map(JSON.stringify).join('\n');

for (const prompt of [periodic, '【定期確認・自動】', ' \n【定期確認】', '[cron] progress check', '[Scheduled task] progress check', '<cron-trigger>progress</cron-trigger>']) {
  test(`明示的な定期プロンプト＋未変化の短文: ${prompt.trim()}`, () => {
    assert.equal(isUnchangedPeriodicReport({ lastUserPrompt: prompt, assistantText: '変化なし。' }), true);
  });
}
for (const text of ['変更はありません。', '進展なし。引き続き返信待ちです。', '状況は変わっていません。', 'No change.']) {
  test(`未変化の表現を認識: ${text}`, () => {
    assert.equal(isUnchangedPeriodicReport({ lastUserPrompt: periodic, assistantText: text }), true);
  });
}
for (const text of [
  '', '完了しました。', '更新しました。', '変化なしとは言えません。', '変化なし。'.repeat(61),
  '変化なし。https://example.com', '変化なし。www.example.com', '変化なし。example.com/path',
  '変化なし。[本文](/tmp/message.md)', '変化なし。次に kim がすること: なし',
  '変化なし。承認してください。', '変化なし。確認をお願いします。',
  '変化なし。ログインしてもらえますか。', '変化なし。送信していただけますか。',
  '変化なし。新しい依頼です。', '変化なし。確認事項: 金額の承認',
  '変化なし。kim は送信する。', '変化なし。承認が必要です。',
  '変化なし。送信してほしい。', '変化なし。送信して。', '変化なし。承認を。',
  '変化なし。\n① アプリを開く\n② ボタンを押す', '変化なし。ボタンを押す',
  '変化なし。Please approve.', '変化なし。Can you send this?', '変化なし。要対応',
  '変化なし。```sh\nnode task.mjs\n```',
]) {
  test(`空文・変更・長文・URL・新しい手渡しは免除しない: ${text.slice(0, 50)}`, () => {
    assert.equal(isUnchangedPeriodicReport({ lastUserPrompt: periodic, assistantText: text }), false);
  });
}
for (const prompt of [undefined, '', '確認して', 'cron の設定を直して', '引用: 【定期確認・自動】']) {
  test(`通常ターン・出所不明は免除しない: ${prompt}`, () => {
    assert.equal(isUnchangedPeriodicReport({ lastUserPrompt: prompt, assistantText: '変化なし。' }), false);
  });
}
test('300文字は境界内、301文字は免除しない', () => {
  const text = '変化なし。' + '待'.repeat(295);
  assert.equal(isUnchangedPeriodicReport({ lastUserPrompt: periodic, assistantText: text }), true);
  assert.equal(isUnchangedPeriodicReport({ lastUserPrompt: periodic, assistantText: text + '待' }), false);
});

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'periodic-stop-'));
  const previousHome = process.env.ORGIAST_HOME;
  process.env.ORGIAST_HOME = home;
  t.after(() => {
    if (previousHome === undefined) delete process.env.ORGIAST_HOME;
    else process.env.ORGIAST_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  });
  const options = { mode: 'block', ask: async () => { throw new Error('periodic reports must not invoke handoff LLM'); }, policyOptions: { home, hostname: 'kim-PC', refresh: async () => {}, notify: async () => ({ delivered: 'test' }) } };
  return { home, options };
}

test('同一セッションの長い手渡しの後でも定期短文は再掲・監査・再試行を要求しない', async t => {
  const { home, options } = fixture(t);
  const file = path.join(home, 'transcript.jsonl');
  const entries = [user('本文と手順を提示して'), assistant('確認事項・送信本文・手順・別件一覧\n'.repeat(25)), user(periodic), assistant('変化なし。')];
  fs.writeFileSync(file, jsonl(entries));
  for (const retry of [false, true]) {
    if (retry) fs.appendFileSync(file, '\n' + jsonl([{ ...user('Stop hook feedback: 最終まとめを全文再掲する'), isMeta: true }, assistant('変化なし。')]));
    const result = await run({ session_id: 'periodic', transcript_path: file, stop_hook_active: retry }, readTranscriptContext(file), options);
    assert.equal(result.record.verdict, 'pass');
    assert.equal(result.record.unchangedPeriodicReport, true);
    assert.deepEqual(result.record.blockedBy, []);
    assert.deepEqual(result.record.reasonCodes, []);
    assert.equal(result.reason, undefined);
    assert.equal(result.systemMessage, undefined);
    assert.equal(result.record.auditEvidence, 'unchanged-periodic-report');
  }
  assert.equal(fs.existsSync(path.join(home, '.claude', 'stop-gate-runner-state.json')), false);
});

test('新しい手渡しは定期・通常のどちらも同じゲートでblockする', async t => {
  const { options } = fixture(t);
  const text = '変化なし。GitHub の画面で Merge をクリックしてください。';
  const results = [];
  for (const [index, prompt] of [periodic, '作業結果を報告して'].entries()) {
    const result = await run({ session_id: `handoff-${index}`, assistant_text: text }, { humanText: prompt, raw: jsonl([user(prompt), assistant(text)]) }, options);
    assert.equal(result.decision, 'block');
    assert.equal(result.record.unchangedPeriodicReport, false);
    assert.ok(result.record.blockedBy.includes('manual-request-fullsteps-gate'));
    assert.match(result.reason, /【最終まとめ】/);
    results.push(result.record.blockedBy);
  }
  assert.deepEqual(results[0], results[1]);
});

test('過去の定期プロンプトは最新の通常ターンを免除しない', async t => {
  const { home, options } = fixture(t);
  const file = path.join(home, 'transcript.jsonl');
  fs.writeFileSync(file, jsonl([user(periodic), assistant('変化なし。'), user('報告して'), assistant('変化なし。')]));
  const result = await run({ session_id: 'ordinary', transcript_path: file }, readTranscriptContext(file), options);
  assert.equal(result.record.unchangedPeriodicReport, false);
  assert.notEqual(result.record.auditEvidence, 'unchanged-periodic-report');
});

test('定期短文でも実作業の違反はblockし、差し戻しに全文再掲指示を付けない', async t => {
  const { options } = fixture(t);
  const text = '変化なし。台帳へ記録します。';
  const result = await run({ session_id: 'operational', assistant_text: text }, { humanText: periodic, raw: jsonl([user(periodic), assistant(text)]) }, options);
  assert.equal(result.record.unchangedPeriodicReport, true);
  assert.equal(result.decision, 'block');
  assert.ok(result.record.blockedBy.includes('unregistered-promise-gate'));
  assert.ok(result.record.reasonCodes.includes('UNREGISTERED-PROMISE'));
  assert.doesNotMatch(result.reason, /【最終まとめ】|①報告|ピギーバック|次に kim がすること/);
});

test('CLIはmeta定期プロンプトを認識しtool_resultとStop feedbackを飛ばす', t => {
  const { home } = fixture(t);
  const file = path.join(home, 'transcript.jsonl');
  fs.writeFileSync(file, jsonl([
    user('通常の依頼'), assistant('https://github.com/org/repo を確認してください。\n' + '過去の長文報告。'.repeat(40)),
    { ...user('【定期確認・自動】'), isMeta: true },
    user([{ type: 'tool_result', content: 'https://example.com' }]),
    assistant('変化なし。'), user('Stop hook feedback: 全文を再掲'),
  ]));
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./stop-gate-runner.mjs', import.meta.url))], {
    input: JSON.stringify({ session_id: 'cli-periodic', transcript_path: file, last_assistant_message: '変化なし。' }),
    encoding: 'utf8', env: { ...process.env, ORGIAST_HOME: home, ORGIAST_HANDOFF_AUDIT: 'off' }, timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  const record = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'stop-gate-runner-ledger.jsonl'), 'utf8'));
  assert.equal(record.unchangedPeriodicReport, true);
  assert.equal(record.verdict, 'pass');
});

for (const content of [[{ type: 'image', source: {} }], '[Image: attachment]']) test(`画像だけの最新userターンは過去の定期プロンプトを継承しない: ${JSON.stringify(content)}`, async t => {
  const { home, options } = fixture(t);
  const file = path.join(home, 'image-turn.jsonl');
  fs.writeFileSync(file, jsonl([user(periodic), assistant('変化なし。'), user(content), assistant('変化なし。')]));
  const context = readTranscriptContext(file);
  assert.notEqual(context.lastUserPrompt, periodic);
  const result = await run({ session_id: 'image-turn' }, context, options);
  assert.equal(result.record.unchangedPeriodicReport, false);
});

test('過去の手渡しを自分で実行した履歴の再発防止ブロックは定期報告だけ免除', async t => {
  const { options } = fixture(t);
  const oldEntries = [
    user('設定変更'), assistant('[手渡し判定]\nuser が ~/.claude/settings.json を変更してください'),
    assistant([{ type: 'tool_use', id: 'edit-1', name: 'Edit', input: { file_path: '~/.claude/settings.json' } }]),
    user([{ type: 'tool_result', tool_use_id: 'edit-1', content: 'updated' }]),
  ];
  for (const [index, prompt] of [periodic, '報告して'].entries()) {
    const result = await run({ session_id: `regret-${index}`, assistant_text: '変化なし。' }, {
      humanText: prompt, raw: jsonl([...oldEntries, user(prompt), assistant('変化なし。')]),
    }, options);
    if (index === 0) assert.equal(result.record.verdict, 'pass');
    else {
      assert.equal(result.decision, 'block');
      assert.ok(result.record.blockedBy.includes('handoff-regret-gate'));
      assert.match(result.reason, /再発防止/);
    }
  }
});
