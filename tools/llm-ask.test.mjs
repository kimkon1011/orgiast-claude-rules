import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { findCommand, runCodexCliFallback } from './llm-ask.mjs';

test('findCommand は Windows の PATH から cmd を解決する', () => {
  const found = findCommand('codex', {
    env: { PATH: 'C:\\bin;D:\\tools', PATHEXT: '.EXE;.CMD' },
    platform: 'win32',
    exists: (file) => file === 'D:\\tools\\codex.CMD',
  });
  assert.equal(found, 'D:\\tools\\codex.CMD');
});

test('API候補全滅時の Codex CLI レーンは read-only の最終回答を返す', () => {
  let call;
  const result = runCodexCliFallback({
    prompt: '短く答えて',
    system: '日本語で回答',
    env: { PATH: 'C:\\bin', PATHEXT: '.CMD' },
    executable: 'C:\\bin\\codex.CMD',
    spawn(command, args, options) {
      call = { command, args, options };
      const output = args[args.indexOf('--output-last-message') + 1];
      fs.writeFileSync(output, '成功しました。\n');
      return { status: 0, stderr: '' };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.text, '成功しました。');
  assert.equal(call.command, 'C:\\bin\\codex.CMD');
  assert.ok(call.args.includes('read-only'));
  assert.ok(call.args.includes('--ephemeral'));
  assert.match(call.options.input, /日本語で回答/);
  assert.match(call.options.input, /短く答えて/);
  assert.equal(fs.existsSync(path.dirname(call.args[call.args.indexOf('--output-last-message') + 1])), false);
});

test('Codex CLI が無い場合は実行せず失敗理由を返す', () => {
  const result = runCodexCliFallback({ prompt: 'x', env: { PATH: '', PATHEXT: '.CMD' } });
  assert.deepEqual(result, { ok: false, reason: 'codex-cli-not-found' });
});
