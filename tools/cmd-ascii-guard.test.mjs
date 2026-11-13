import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { evaluate, REASON } from './cmd-ascii-guard.mjs';

const script = fileURLToPath(new URL('./cmd-ascii-guard.mjs', import.meta.url));
const run = payload => spawnSync(process.execPath, [script], { input: typeof payload === 'string' ? payload : JSON.stringify(payload), encoding: 'utf8' });
const write = (file_path, content) => ({ tool_name: 'Write', tool_input: { file_path, content } });

test('日本語入りの .cmd/.bat の書き込みを実プロセス経路で deny する（2026-11-04 kim-PC 実害）', () => {
  for (const file of ['C:\\Users\\u\\Desktop\\設定.cmd', 'C:\\x\\run.BAT']) {
    const result = run(write(file, '@echo off\r\necho 1Password の設定を行います\r\n'));
    assert.equal(result.status, 0);
    const output = JSON.parse(result.stdout);
    assert.equal(output.hookSpecificOutput.permissionDecision, 'deny', file);
    assert.equal(output.hookSpecificOutput.permissionDecisionReason, REASON);
  }
});

test('ASCII だけの .cmd・日本語入りの .ps1/.mjs は通す', () => {
  assert.equal(evaluate(write('C:\\Users\\u\\Desktop\\1Password初期設定.cmd', '@echo off\r\nnode "%USERPROFILE%\\x.mjs"\r\npause\r\n')), null);
  assert.equal(evaluate(write('C:\\x\\setup.ps1', 'Write-Host "設定します"')), null);
  assert.equal(evaluate(write('C:\\x\\setup.mjs', "console.log('設定します')")), null);
});

test('Edit と MultiEdit の挿入文字列も検査する', () => {
  assert.equal(evaluate({ tool_name: 'Edit', tool_input: { file_path: 'a.cmd', old_string: 'x', new_string: 'echo 完了' } }), REASON);
  assert.equal(evaluate({ tool_name: 'MultiEdit', tool_input: { file_path: 'a.bat', edits: [{ new_string: 'ok' }, { new_string: 'echo 失敗' }] } }), REASON);
  assert.equal(evaluate({ tool_name: 'Edit', tool_input: { file_path: 'a.cmd', old_string: 'echo 完了', new_string: 'echo done' } }), null);
});

test('理由5文字以上の例外マーカーだけ通し、壊れた入力は fail-open', () => {
  assert.equal(evaluate(write('a.cmd', 'rem [CMD-NONASCII-OK: 既存の社外配布物の互換]\r\necho 日本語')), null);
  assert.equal(evaluate(write('a.cmd', 'rem [CMD-NONASCII-OK: 短い]\r\necho 日本語')), REASON);
  const broken = run('{not json');
  assert.equal(broken.status, 0);
  assert.equal(broken.stdout, '');
  assert.equal(run({ tool_name: 'Bash', tool_input: { command: 'echo 日本語 > a.cmd' } }).stdout, '');
});
