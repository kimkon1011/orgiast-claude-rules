import test from 'node:test';
import assert from 'node:assert/strict';
import { pushKim, main, DEFAULT_TRIGGER_ID } from './kim-push.mjs';
const deps = {
  fs: { readFileSync: () => { throw Object.assign(new Error(), { code: 'ENOENT' }); } },
  resolveExecutable: async () => ({ executable: '/test/claude' }),
};
test('終了コード0かつsession_idがある場合だけ成功する', async () => {
  for (const [code, stdout, ok] of [[0, '{"session_id":"abc"}', true], [1, '{"session_id":"abc"}', false], [0, '{}', false]]) {
    assert.equal((await pushKim('本文', { ...deps, runConnectorPrompt: async options => {
      assert.equal(options.timeoutMs, 240_000);
      assert.deepEqual(options.args.slice(0, 3), ['-p', '--model', 'haiku']);
      assert.match(options.prompt, /RemoteTrigger/);
      assert.match(options.prompt, /"body":\{"text":"本文"\}/);
      assert.equal(options.env.ANTHROPIC_API_KEY, undefined);
      return { code, stdout };
    } })).ok, ok);
  }
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
