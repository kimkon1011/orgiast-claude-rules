import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseLlmResult } from './session-triage.mjs';

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

// 実CLIと変更していないworkerを動かし、外部LLMだけを固定応答に差し替える。
async function triageFixture(t) {
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
