import test from 'node:test';
import assert from 'node:assert/strict';
import { runCli, extractResponse } from './grok-research.mjs';

function harness(fetchFn, overrides = {}) {
  const output = { stdout: '', stderr: '', files: new Map(), logs: [] };
  return { output, deps: {
    fetchFn, loadKeyFn: () => 'test-secret-key', getClaudeDirFn: () => '/mock',
    stdout: { write: s => { output.stdout += s; } }, stderr: { write: s => { output.stderr += s; } },
    fsFn: { readFileSync: () => 'ファイルの質問', writeFileSync: (p, s) => output.files.set(p, s), appendFileSync: (p, s) => output.logs.push(JSON.parse(s)) },
    ...overrides
  } };
}
const ok = json => ({ ok: true, json: async () => json });
const fail = (status, message) => ({ ok: false, status, text: async () => message });

test('鍵なしは終了コード2、通信しない', async () => {
  const { output, deps } = harness(() => assert.fail('通信禁止'), { loadKeyFn: () => '' });
  assert.equal(await runCli(['--question', '調査'], deps), 2);
  assert.match(output.stderr, /未設定/);
});

test('本文と各種引用 URL を抽出し重複を除く', () => {
  const result = extractResponse({ citations: ['https://x.com/a/status/1'], annotations: [{ url: 'https://example.org/review' }], output: [
    { type: 'message', content: [{ type: 'output_text', text: '体験談', annotations: [{ type: 'url_citation', url: 'https://x.com/a/status/1' }] }, { type: 'citation', url: 'https://youtube.com/watch?v=1' }] }
  ] });
  assert.equal(result.text, '体験談');
  assert.equal(result.citations.length, 3);
  assert.equal(extractResponse({ output_text: '直接本文' }).text, '直接本文');
});

test('正常応答、質問ファイル、出力保存、使用量ログ、API形式', async () => {
  const { output, deps } = harness(async (url, init) => {
    assert.equal(url, 'https://api.x.ai/v1/responses');
    const body = JSON.parse(init.body);
    assert.equal(body.model, 'custom-model');
    assert.equal(body.input[0].role, 'system');
    assert.equal(body.input[1].content, 'ファイルの質問');
    assert.deepEqual(body.tools, [{ type: 'x_search' }, { type: 'web_search' }]);
    return ok({ output_text: '効果あり', citations: ['https://example.org/review'], usage: { input_tokens: 12, output_tokens: 8 } });
  });
  assert.equal(await runCli(['--question-file', 'q.txt', '--out', 'result.md', '--model', 'custom-model'], deps), 0);
  assert.equal(output.files.get('result.md'), output.stdout);
  assert.match(output.stdout, /https:\/\/example.org\/review/);
  assert.equal(output.logs[0].provider, 'grok');
  assert.equal(output.logs[0].in, 12);
  assert.equal(JSON.stringify(output).includes('test-secret-key'), false);
});

test('web_search の拒否のみ x_search へフォールバック', async () => {
  let calls = 0;
  const { output, deps } = harness(async (url, init) => {
    if (++calls === 1) return fail(422, 'web_search is not supported');
    assert.deepEqual(JSON.parse(init.body).tools, [{ type: 'x_search' }]);
    return ok({ output_text: '検索結果' });
  });
  assert.equal(await runCli(['--question', '調査'], deps), 0);
  assert.equal(calls, 2);
  assert.match(output.stderr, /x_search のみで再試行/);
});

test('402・モデルエラー・サーバーエラーは再試行せず、鍵を隠して本文を報告', async () => {
  for (const [status, message] of [[402, 'Insufficient credits test-secret-key'], [422, 'unknown model'], [500, 'web_search unavailable']]) {
    let calls = 0;
    const { output, deps } = harness(async () => { calls++; return fail(status, message); });
    assert.equal(await runCli(['--question', '調査'], deps), 1);
    assert.equal(calls, 1);
    assert.match(output.stderr, new RegExp(String(status)));
    assert.equal(output.stderr.includes('test-secret-key'), false);
    assert.ok(output.stderr.includes(message.replace('test-secret-key', '[REDACTED]')));
  }
});

test('本文・引用・ファイル・例外に鍵を出さず、ログ失敗でも成功', async () => {
  const { output, deps } = harness(async () => ok({ output_text: 'test-secret-key', citations: ['https://example.org/test-secret-key'] }));
  deps.fsFn.appendFileSync = () => { throw new Error('log failure'); };
  assert.equal(await runCli(['--question', '調査', '--out', 'r.md'], deps), 0);
  assert.equal(output.stdout.includes('test-secret-key'), false);
  assert.equal(output.files.get('r.md').includes('test-secret-key'), false);
  deps.fetchFn = async () => { throw new Error('network test-secret-key'); };
  assert.equal(await runCli(['--question', '調査'], deps), 1);
  assert.equal(output.stderr.includes('test-secret-key'), false);
});

test('空本文や不正引数を成功にしない', async () => {
  const { deps } = harness(async () => ok({ output: [] }));
  assert.equal(await runCli(['--question', '調査'], deps), 1);
  assert.equal(await runCli(['--question'], deps), 1);
});
