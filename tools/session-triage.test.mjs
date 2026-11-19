import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { parseLlmResult, isEmptySession, selectRecords } from './session-triage.mjs';

const execFileAsync = promisify(execFile);
const expected = { verdict: '未完了', confidence: 85, next: '残作業を確認する' };
const json = JSON.stringify(expected);

for (const [name, input] of [
  ['素のJSON', json],
  ['jsonフェンス', `\`\`\`json\n${json}\n\`\`\``],
  ['前後に散文', `判定結果です。\n${json}\n以上です。`],
]) {
  test(`parseLlmResult: ${name}を解析する`, () => {
    assert.deepEqual(parseLlmResult(input), expected);
  });
}

for (const [name, input] of [
  ['空文字', ''],
  ['空白', ' \n\t '],
  ['JSONでない文字列', '判定できません'],
  ['不正なJSON', '{"verdict":'],
  ['想定外のverdict', '{"verdict":"保留","confidence":80}'],
  ['数値でないconfidence', '{"verdict":"未完了","confidence":"high"}'],
  ['nullのconfidence', '{"verdict":"未完了","confidence":null}'],
  ['booleanのconfidence', '{"verdict":"未完了","confidence":true}'],
  ['配列のconfidence', '{"verdict":"未完了","confidence":[]}'],
  ['confidence無し', '{"verdict":"未完了"}'],
  ['負のconfidence', '{"verdict":"未完了","confidence":-1}'],
  ['100を超えるconfidence', '{"verdict":"未完了","confidence":101}'],
  ['無限大になるconfidence', '{"verdict":"未完了","confidence":1e999}'],
  ['nullのJSON', 'null'],
]) {
  test(`parseLlmResult: ${name}はnullを返す`, () => {
    assert.equal(parseLlmResult(input), null);
  });
}

test('parseLlmResult: 数値文字列のconfidenceは受け入れる', () => {
  // モデルは confidence を文字列で返すことがある。ここを弾くと判定失敗が増えるだけなので受ける。
  assert.deepEqual(
    parseLlmResult('{"verdict":"未完了","confidence":"80","next":"残作業を確認"}'),
    { verdict: '未完了', confidence: 80, next: '残作業を確認' },
  );
});

test('parseLlmResult: 正当な不明は解析成功として返す', () => {
  const unknown = { verdict: '不明', confidence: 0, next: '' };
  assert.deepEqual(parseLlmResult(JSON.stringify(unknown)), unknown);
  assert.deepEqual(parseLlmResult('{"verdict":"不明","confidence":0}'), unknown);
});

test('parseLlmResult: 完了のnextは空にしconfidenceを丸める', () => {
  assert.deepEqual(
    parseLlmResult('{"verdict":"完了","confidence":99.6,"next":"不要な追加提案"}'),
    { verdict: '完了', confidence: 100, next: '' },
  );
});

test('isEmptySession: lastAssistantTextが空かつfirstPromptが(プロンプトなし)のとき真', () => {
  const record = { lastAssistantText: '', firstPrompt: '(プロンプトなし)' };
  assert.equal(isEmptySession(record), true);
});

test('isEmptySession: lastAssistantTextが存在するとき偽', () => {
  const record = { lastAssistantText: '何か書いた', firstPrompt: '(プロンプトなし)' };
  assert.equal(isEmptySession(record), false);
});

test('isEmptySession: firstPromptが(プロンプトなし)以外のとき偽', () => {
  const record = { lastAssistantText: '', firstPrompt: '資料を作成する' };
  assert.equal(isEmptySession(record), false);
});

test('selectRecords: llmMode=false で先頭 top 件だけ返す', () => {
  const records = Array.from({ length: 5 }, (_, i) => ({ id: i }));
  const result = selectRecords(records, 2, false);
  assert.equal(result.length, 2);
  assert.deepEqual(result, records.slice(0, 2));
});

test('selectRecords: llmMode=true で対話ありtop件＋対話なし全件を返す', () => {
  const empties = Array.from({ length: 5 }, (_, i) => ({
    id: i,
    lastAssistantText: '',
    firstPrompt: '(プロンプトなし)',
  }));
  const conversations = Array.from({ length: 5 }, (_, i) => ({
    id: 10 + i,
    lastAssistantText: '応答',
    firstPrompt: '質問',
  }));
  const filtered = [...conversations, ...empties];
  const result = selectRecords(filtered, 2, true);
  // 対話あり2件 + 空5件 = 7件。順序は保たれる（最初に対話あり、その後に空）。
  assert.equal(result.length, 7);
  assert.equal(result[0].id, 10);
  assert.equal(result[1].id, 11);
  assert.equal(result[2].id, 0);
  assert.equal(result[3].id, 1);
  assert.equal(result[4].id, 2);
  assert.equal(result[5].id, 3);
  assert.equal(result[6].id, 4);
});

test('selectRecords: llmMode=true で対話なしのみでも全件返す', () => {
  const empties = Array.from({ length: 3 }, (_, i) => ({
    id: i,
    lastAssistantText: '',
    firstPrompt: '(プロンプトなし)',
  }));
  const result = selectRecords(empties, 2, true);
  // 対話あり0件(先頭0) + 空3件 = 3件
  assert.equal(result.length, 3);
});

test('relocatedCwd が cwd として採用される（bridge-session 対応）', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-triage-relocated-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'projects', 'fixture');
  await fs.mkdir(project, { recursive: true });
  const transcript = [
    { type: 'bridge-session', sessionId: '00000000-0000-0000-0000-000000000001' },
    { type: 'last-prompt', lastPrompt: '福利厚生カフェレシートの修正' },
    { type: 'custom-title', customTitle: '【11/13/09:54まで】社員立替経費アプリ' },
    { type: 'relocated', relocatedCwd: 'C:\\Users\\test\\Desktop', sessionId: '00000000-0000-0000-0000-000000000001' },
    { type: 'user', timestamp: '2026-11-01T00:00:00Z', message: { role: 'user', content: '立替経費の修正' } },
    { type: 'assistant', timestamp: '2026-11-01T00:01:00Z', message: { role: 'assistant', content: '修正完了' } },
  ];
  await fs.writeFile(path.join(project, 'f84f4059-586b-4161-a9ab-c026ad9adb7e.jsonl'), `${transcript.map(JSON.stringify).join('\n')}\n`);
  const { stdout } = await execFileAsync(process.execPath, [fileURLToPath(new URL('./session-triage.mjs', import.meta.url)), '--all', '--include-current', '--include-closed', '--include-completed', '--json'], {
    env: { ...process.env, CLAUDE_PROJECTS_DIR: path.join(root, 'projects') },
  });
  const session = JSON.parse(stdout).sessions[0];
  assert.equal(session.cwd, 'C:\\Users\\test\\Desktop');
});

test('合成APIエラー行はassistant返答に数えず末尾user未応答になる', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-triage-api-error-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'projects', 'fixture');
  await fs.mkdir(project, { recursive: true });
  const transcript = [
    { type: 'user', timestamp: '2026-10-22T00:00:00Z', cwd: root, message: { role: 'user', content: '依頼です' } },
    { type: 'assistant', timestamp: '2026-10-22T00:01:00Z', isApiErrorMessage: true, error: 'rate_limit', message: { role: 'assistant', model: '<synthetic>', content: 'limit' } },
  ];
  await fs.writeFile(path.join(project, 'f84f4059-586b-4161-a9ab-c026ad9adb7f.jsonl'), `${transcript.map(JSON.stringify).join('\n')}\n`);
  const { stdout } = await execFileAsync(process.execPath, [fileURLToPath(new URL('./session-triage.mjs', import.meta.url)), '--all', '--include-current', '--include-closed', '--include-completed', '--json'], {
    env: { ...process.env, CLAUDE_PROJECTS_DIR: path.join(root, 'projects') },
  });
  const session = JSON.parse(stdout).sessions[0];
  assert.equal(session.lastRole, 'user'); assert.equal(session.signals.lastUserUnanswered, true);
});

// 実CLIと変更していないworkerを動かし、外部LLMだけを固定応答に差し替える。
async function triageFixture(t, transcript = [
  { type: 'user', message: { role: 'user', content: '資料を作成する' } },
  { type: 'assistant', message: { role: 'assistant', content: '残TODOを確認する' } },
]) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-triage-contract-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const script = path.join(root, 'session-triage.mjs');
  const source = await fs.readFile(new URL('./session-triage.mjs', import.meta.url), 'utf8');
  const redactUrl = new URL('./redact-secrets.mjs', import.meta.url).href;
  const isEntryUrl = new URL('./is-entry.mjs', import.meta.url).href;
  await fs.writeFile(
    script,
    source
      .replace("'./redact-secrets.mjs'", JSON.stringify(redactUrl))
      .replace("'./is-entry.mjs'", JSON.stringify(isEntryUrl)),
    'utf8',
  );
  const project = path.join(root, 'projects', 'fixture');
  await fs.mkdir(project, { recursive: true });
  const id = 'f84f4059-586b-4161-a9ab-c026ad9adb7e';
  const fixtureTranscript = transcript.map((event) => event.type === 'user' ? { cwd: root, ...event } : event);
  await fs.writeFile(
    path.join(project, `${id}.jsonl`),
    `${fixtureTranscript.map((event) => JSON.stringify(event)).join('\n')}\n`,
    'utf8',
  );
  const callsPath = path.join(root, 'calls.jsonl');
  await fs.writeFile(path.join(root, 'llm-ask.mjs'), `
import { appendFile } from 'node:fs/promises';
const args = process.argv.slice(2);
const provider = args[args.indexOf('--provider') + 1];
await appendFile(process.env.TRIAGE_TEST_CALLS, JSON.stringify(provider) + '\\n', 'utf8');
if (provider === 'broken') console.log('応答形式が壊れています');
else if (provider === 'unknown') console.log('{"verdict":"不明","confidence":0,"next":""}');
else console.log('{"verdict":"未完了","confidence":85,"next":"残作業を確認する"}');
`, 'utf8');
  return async (providers) => {
    await fs.writeFile(callsPath, '', 'utf8');
    const { stdout } = await execFileAsync(process.execPath, [
      script, '--all', '--include-current', '--include-closed',
      '--include-completed', '--llm', '--json', '--top', '10',
    ], {
      timeout: 30_000,
      env: {
        ...process.env,
        CLAUDE_PROJECTS_DIR: path.join(root, 'projects'),
        SESSION_TRIAGE_LLM_PROVIDERS: providers,
        SESSION_TRIAGE_DEBUG: '',
        TRIAGE_TEST_CALLS: callsPath,
      },
    });
    const calls = (await fs.readFile(callsPath, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
    return { ...JSON.parse(stdout), calls };
  };
}

test('解析失敗は次のproviderへ進み、成功した判定だけを成功計上する', async (t) => {
  const run = await triageFixture(t);
  const result = await run('broken,good');
  assert.deepEqual(result.calls, ['broken', 'good']);
  assert.equal(result.summary.llm.success, 1);
  assert.equal(result.summary.llm.failure, 0);
  assert.deepEqual(result.summary.llm.failureReasons, []);
  assert.deepEqual(result.sessions[0].llm, expected);
  assert.ok(result.summary.llm.providerNotes.includes('broken: LLM応答を解析できません'));
});

test('全providerの解析失敗はerror付きの失敗として計上する', async (t) => {
  const run = await triageFixture(t);
  const result = await run('broken');
  assert.deepEqual(result.calls, ['broken']);
  assert.equal(result.summary.llm.success, 0);
  assert.equal(result.summary.llm.failure, 1);
  assert.equal(result.sessions[0].llm.verdict, '失敗');
  assert.equal(result.sessions[0].llm.error, 'broken: LLM応答を解析できません');
  assert.deepEqual(result.summary.llm.failureReasons, [
    { reason: 'broken: LLM応答を解析できません', count: 1 },
  ]);
});

test('正当な不明はproviderフォールバックせず解析成功として計上する', async (t) => {
  const run = await triageFixture(t);
  const result = await run('unknown,good');
  assert.deepEqual(result.calls, ['unknown']);
  assert.equal(result.summary.llm.success, 1);
  assert.equal(result.summary.llm.failure, 0);
  assert.deepEqual(result.sessions[0].llm, { verdict: '不明', confidence: 0, next: '' });
});

test('SDK起動でassistant返答が空ならLLMを呼ばず完了80にする', async (t) => {
  const run = await triageFixture(t, [
    { type: 'attachment', entrypoint: 'sdk-cli' },
    { type: 'user', message: { role: 'user', content: '資料を作成する' } },
  ]);
  const result = await run('good');
  assert.deepEqual(result.calls, []);
  assert.equal(result.summary.llm.success, 1);
  assert.deepEqual(result.sessions[0].llm, { verdict: '完了', confidence: 80, next: '' });
});

test('VSCode対話のpromptSourceがsdkでもassistant返答が空なら未完了70にする', async (t) => {
  const run = await triageFixture(t, [
    { type: 'attachment', entrypoint: 'claude-vscode' },
    {
      type: 'user',
      promptSource: 'sdk',
      message: { role: 'user', content: '資料を作成する' },
    },
  ]);
  const result = await run('good');
  assert.deepEqual(result.calls, []);
  assert.equal(result.summary.llm.success, 1);
  assert.deepEqual(result.sessions[0].llm, {
    verdict: '未完了',
    confidence: 70,
    next: 'セッションを再開して依頼に着手する',
  });
});

test('対話起動でassistant返答が空ならLLMを呼ばず未完了70にする', async (t) => {
  const run = await triageFixture(t, [
    { type: 'user', message: { role: 'user', content: '資料を作成する' } },
  ]);
  const result = await run('good');
  assert.deepEqual(result.calls, []);
  assert.equal(result.summary.llm.success, 1);
  assert.deepEqual(result.sessions[0].llm, {
    verdict: '未完了',
    confidence: 70,
    next: 'セッションを再開して依頼に着手する',
  });
});

test('対話の無いセッションはLLM呼び出しを省略して完了扱いにする', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-triage-empty-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const script = path.join(root, 'session-triage.mjs');
  const source = await fs.readFile(new URL('./session-triage.mjs', import.meta.url), 'utf8');
  const redactUrl = new URL('./redact-secrets.mjs', import.meta.url).href;
  const isEntryUrl = new URL('./is-entry.mjs', import.meta.url).href;
  await fs.writeFile(
    script,
    source
      .replace("'./redact-secrets.mjs'", JSON.stringify(redactUrl))
      .replace("'./is-entry.mjs'", JSON.stringify(isEntryUrl)),
    'utf8',
  );
  const project = path.join(root, 'projects', 'fixture');
  await fs.mkdir(project, { recursive: true });
  const id = '00000000-0000-0000-0000-000000000001';
  // 対話の無いセッション: user/assistant イベントが無くシステムイベントのみ
  const transcript = [
    { type: 'custom-title', customTitle: 'プローブセッション' },
    { type: 'cost-state', totalCostUSD: 0 },
  ];
  await fs.writeFile(
    path.join(project, `${id}.jsonl`),
    `${transcript.map((event) => JSON.stringify(event)).join('\n')}\n`,
    'utf8',
  );
  const callsPath = path.join(root, 'calls.jsonl');
  await fs.writeFile(path.join(root, 'llm-ask.mjs'), `
import { appendFile } from 'node:fs/promises';
const args = process.argv.slice(2);
const provider = args[args.indexOf('--provider') + 1];
await appendFile(process.env.TRIAGE_TEST_CALLS, JSON.stringify(provider) + '\\n', 'utf8');
console.log('{"verdict":"未完了","confidence":85,"next":"呼ばれたら失敗"}');
`, 'utf8');
  await fs.writeFile(callsPath, '', 'utf8');
  const { stdout } = await execFileAsync(process.execPath, [
    script, '--all', '--include-current', '--include-closed',
    '--include-completed', '--llm', '--json', '--top', '10',
  ], {
    timeout: 30_000,
    env: {
      ...process.env,
      CLAUDE_PROJECTS_DIR: path.join(root, 'projects'),
      SESSION_TRIAGE_LLM_PROVIDERS: 'groq',
      SESSION_TRIAGE_DEBUG: '',
      TRIAGE_TEST_CALLS: callsPath,
    },
  });
  const calls = (await fs.readFile(callsPath, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  const parsed = JSON.parse(stdout);
  assert.deepEqual(calls, [], '対話の無いセッションではLLMが呼ばれないこと');
  assert.equal(parsed.summary.llm.success, 1, 'llm success として計上されること');
  assert.equal(parsed.summary.llm.failure, 0);
  assert.deepEqual(parsed.sessions[0].llm, { verdict: '完了', confidence: 90, next: '' });
  assert.ok(parsed.sessions[0].reasons.some((r) => r.startsWith('LLM:完了')), 'reasons に LLM:完了 が含まれること');
});

test('対話の有るセッションは従来通りLLM呼び出しする', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-triage-with-content-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const script = path.join(root, 'session-triage.mjs');
  const source = await fs.readFile(new URL('./session-triage.mjs', import.meta.url), 'utf8');
  const redactUrl = new URL('./redact-secrets.mjs', import.meta.url).href;
  const isEntryUrl = new URL('./is-entry.mjs', import.meta.url).href;
  await fs.writeFile(
    script,
    source
      .replace("'./redact-secrets.mjs'", JSON.stringify(redactUrl))
      .replace("'./is-entry.mjs'", JSON.stringify(isEntryUrl)),
    'utf8',
  );
  const project = path.join(root, 'projects', 'fixture');
  await fs.mkdir(project, { recursive: true });
  const id = 'f84f4059-586b-4161-a9ab-c026ad9adb7e';
  // 通常の対話があるセッション
  const transcript = [
    { type: 'user', cwd: root, message: { role: 'user', content: '資料を作成する' } },
    { type: 'assistant', message: { role: 'assistant', content: '残TODOを確認する' } },
  ];
  await fs.writeFile(
    path.join(project, `${id}.jsonl`),
    `${transcript.map((event) => JSON.stringify(event)).join('\n')}\n`,
    'utf8',
  );
  const callsPath = path.join(root, 'calls.jsonl');
  await fs.writeFile(path.join(root, 'llm-ask.mjs'), `
import { appendFile } from 'node:fs/promises';
const args = process.argv.slice(2);
const provider = args[args.indexOf('--provider') + 1];
await appendFile(process.env.TRIAGE_TEST_CALLS, JSON.stringify(provider) + '\\n', 'utf8');
console.log('{"verdict":"未完了","confidence":85,"next":"残作業を確認する"}');
`, 'utf8');
  await fs.writeFile(callsPath, '', 'utf8');
  const { stdout } = await execFileAsync(process.execPath, [
    script, '--all', '--include-current', '--include-closed',
    '--include-completed', '--llm', '--json', '--top', '10',
  ], {
    timeout: 30_000,
    env: {
      ...process.env,
      CLAUDE_PROJECTS_DIR: path.join(root, 'projects'),
      SESSION_TRIAGE_LLM_PROVIDERS: 'groq',
      SESSION_TRIAGE_DEBUG: '',
      TRIAGE_TEST_CALLS: callsPath,
    },
  });
  const calls = (await fs.readFile(callsPath, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  const parsed = JSON.parse(stdout);
  assert.ok(calls.length > 0, '対話の有るセッションではLLMが呼ばれること');
  assert.equal(parsed.summary.llm.success, 1);
  assert.equal(parsed.summary.llm.failure, 0);
});
