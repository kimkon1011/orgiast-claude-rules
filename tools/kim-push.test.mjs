import test from 'node:test';
import assert from 'node:assert/strict';
import { pushKim, main, DEFAULT_TRIGGER_ID } from './kim-push.mjs';
const deps = {
  fs: { readFileSync: () => { throw Object.assign(new Error(), { code: 'ENOENT' }); } },
  resolveExecutable: async () => ({ executable: '/test/claude' }),
};
test('終了コードやタイムアウトにかかわらずsession_idがある場合だけ成功する', async () => {
  for (const [code, timedOut, stdout, ok] of [[0, false, '{"session_id":"abc"}', true], [1, false, '{"session_id":"abc"}', true], [124, true, '{"session_id":"abc"}', true], [124, true, '{}', false], [0, false, '{}', false]]) {
    const result = await pushKim('本文', { ...deps, runConnectorPrompt: async options => {
      assert.equal(options.timeoutMs, 150_000);
      assert.deepEqual(options.args.slice(0, 3), ['-p', '--model', 'haiku']);
      assert.match(options.prompt, /RemoteTrigger/);
      assert.match(options.prompt, /"body":\{"text":"本文"\}/);
      assert.equal(options.env.ANTHROPIC_API_KEY, undefined);
      return { code, timedOut, stdout };
    } });
    assert.equal(result.ok, ok);
    if (!ok) {
      assert.ok(result.reason.includes(`終了コード ${code}`));
      assert.ok(result.reason.includes(`timedOut ${timedOut}`));
    }
  }
});
test('失敗理由はstderrを伏せ字にして末尾200字だけ含め、指定タイムアウトを維持する', async () => {
  const secret = 'sk-' + 'a'.repeat(210);
  const result = await pushKim('本文', { ...deps, timeoutMs: 1234, runConnectorPrompt: async options => {
    assert.equal(options.timeoutMs, 1234);
    return { code: 124, timedOut: true, stdout: '{}', stderr: '先頭' + 'あ'.repeat(220) + secret + '末尾' };
  } });
  assert.equal(result.ok, false);
  assert.ok(result.reason.endsWith(`stderr ${'あ'.repeat(188)}[REDACTED]末尾）`));
  assert.doesNotMatch(result.reason, /先頭|sk-|a{10}/);
});
test('dry-runは起動せずpayloadとargvを返し、設定と文字数制限を反映する', async () => {
  const result = await pushKim('あ'.repeat(20_001), { ...deps, dryRun: true,
    fs: { readFileSync: () => '{"triggerId":"custom"}' },
    runConnectorPrompt: () => assert.fail('起動禁止'),
  });
  assert.equal(result.payload.trigger_id, 'custom');
  assert.equal(result.payload.body.text.length, 20_000);
  assert.ok(result.payload.body.text.endsWith('…(以下省略)'));
  assert.deepEqual(result.argv.slice(0, 4), ['/test/claude', '-p', '--model', 'haiku']);
  assert.equal((await pushKim('本文', { ...deps, dryRun: true })).payload.trigger_id, DEFAULT_TRIGGER_ID);
});
test('例外は失敗に変換し、子出力や秘密値を理由に含めない', async () => {
  const result = await pushKim('本文', { ...deps, runConnectorPrompt: () => { throw new Error('secret'); } });
  assert.equal(result.ok, false);
  assert.doesNotMatch(result.reason, /secret/);
});
test('CLIの引数エラーとdry-run', async () => {
  assert.equal(await main([]), 2);
  assert.equal(await main(['--text-file']), 2);
  assert.equal(await main(['--unknown']), 2);
  let output;
  assert.equal(await main(['--text-file', 'test', '--dry-run'], { ...deps,
    fs: { readFileSync: file => file === 'test' ? '本文' : '{}' }, log: text => { output = JSON.parse(text); },
  }), 0);
  assert.equal(output.payload.body.text, '本文');
});
