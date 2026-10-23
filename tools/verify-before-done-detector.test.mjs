import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { evaluateVerification as check } from './verify-before-done-detector.mjs';
const human = text => ({ type: 'user', message: { content: text } });
let id = 0;
function call(name, input, content = 'OK', is_error = false) {
  const key = String(++id);
  return [{ type: 'assistant', message: { content: [{ type: 'tool_use', id: key, name, input }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: key, content, is_error }] } }];
}
const bash = (command, output, failed) => call('Bash', { command }, output, failed);
const edit = file => call('Edit', { file_path: file });
const incident = () => [human('修正して'), ...bash('node tools/codex-do.mjs "tools/notify-kim.mjs を実装"'), ...bash('node tools/pr-merge.mjs 1017', '{"files":[{"path":"tools/notify-kim.mjs"}]}'), ...bash('node scratchpad/test-send.mjs')];
const live = () => [...bash('node tools/notify-kim.mjs'), ...call('mcp__discord__get_message', { message_id: '123' }, '届いた本文')];
test('事故: 委譲→merge→mock scratchpad→直しましたをblock', () => {
  assert.match(check(incident(), '直しました [TESTED]', { readFile: () => 'import {send} from "../tools/notify-kim.mjs"; send({fetchImpl: fake});' }), /notify-kim.mjs/);
});
test('本番実行と成功したAPI読み戻しでpass', () => assert.equal(check([...incident(), ...live()], '直しました'), null));
test('理由付き例外のみpass、空・先送り・自己申告はblock', () => {
  assert.equal(check(incident(), '直しました [NO-TEST-OK: コメントのみの変更で動作差分なし]'), null);
  for (const tag of ['[NO-TEST-OK: ]','[NO-TEST-OK: 時間がない]','[NO-TEST-OK: 後で確認]','[TESTED]']) assert.ok(check(incident(), '直しました ' + tag));
});
test('node --test、echo、別配置、失敗した実行は証拠にならない', () => {
  for (const cmd of ['node --test tools/notify-kim.mjs','echo node tools/notify-kim.mjs','node scratchpad/notify-kim.mjs','node --eval "import(\'./tools/notify-kim.mjs\')"']) assert.ok(check([...incident(), ...bash(cmd)], '直しました [TESTED-LIVE: 123の本文確認]'));
  assert.ok(check([...incident(), ...bash('node tools/notify-kim.mjs', 'error', true)], '直しました [TESTED-LIVE: 123]'));
});
test('実行のみでは外部反映はblock、具体的liveマーカー併用はpass', () => {
  const rows = [...incident(), ...bash('node tools/notify-kim.mjs')];
  assert.match(check(rows, '直しました'), /読み戻し: なし/);
  assert.equal(check(rows, '直しました [TESTED-LIVE: message 123 本文一致]'), null);
  assert.ok(check([...rows, ...call('mcp__discord__get_message', {}, 'failed', true)], '直しました'));
});
test('当ターン境界: 過去の実行を使わず、過去の変更も持ち越さない', () => {
  assert.ok(check([...live(), ...incident()], '直しました'));
  assert.equal(check([...incident(), human('説明だけして')], '完了'), null);
  assert.ok(check([...incident(), human('Stop hook feedback: 再確認')], '直しました'));
});
test('tools・.claude・docsのコードとjsonを検出、除外は限定', () => {
  for (const file of ['tools/a.mjs','.claude/settings.json','docs/demo.js','C:\\repo\\tools\\a.mjs']) assert.ok(check(edit(file), '完了'));
  for (const file of ['memory/a.js','scratchpad/a.js','tools/a.test.mjs','tests/a.js','docs/a.md']) assert.equal(check(edit(file), '完了'), null);
});
test('review・失敗merge・探索Agentは変更扱いしない', () => {
  assert.equal(check(bash('node tools/codex-do.mjs --review'), '完了'), null);
  assert.equal(check(bash('gh pr merge 42', 'failed', true), '完了'), null);
  assert.equal(check(call('Agent', { subagent_type: 'Explore', prompt: 'find fix' }), '完了'), null);
  assert.ok(check(call('Agent', { prompt: 'implement tools/a.mjs' }), '完了'));
});
test('複数ファイルを個別照合、変更前実行では通らない', () => {
  const rows = [...edit('tools/a.mjs'), ...edit('tools/b.mjs'), ...bash('node tools/a.mjs')];
  assert.match(check(rows, '完了'), /未実行: tools\/b.mjs/);
  assert.equal(check([...rows, ...bash('node tools/b.mjs')], '完了'), null);
  assert.ok(check([...bash('node tools/a.mjs'), ...edit('tools/a.mjs')], '完了'));
});
test('scratchpad本文を読み、偽物なしの実importのみ数える', () => {
  const rows = [...edit('tools/notify-kim.mjs'), ...bash('node scratchpad/live.mjs')];
  assert.equal(check(rows, '完了 [TESTED-LIVE: 123 本文一致]', { readFile: () => 'import {send} from "../tools/notify-kim.mjs"; await send();' }), null);
  assert.ok(check(rows, '完了', { readFile: () => { throw Error('missing'); } }));
});
test('Stop CLIを実起動し、transcriptからblock/passのJSONを読み戻す', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-live-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'transcript.jsonl');
  for (const [rows, blocked] of [[incident(), true], [[...incident(), ...live()], false]]) {
    fs.writeFileSync(file, [...rows, { type: 'assistant', message: { content: [{ type: 'text', text: '直しました' }] } }].map(JSON.stringify).join('\n'));
    const run = spawnSync(process.execPath, [path.resolve('tools/verify-before-done-detector.mjs')], { input: JSON.stringify({ transcript_path: file, session_id: String(++id) }), encoding: 'utf8', env: { ...process.env, ORGIAST_HOME: dir } });
    assert.equal(run.status, 0, run.stderr);
    if (blocked) assert.equal(JSON.parse(run.stdout).decision, 'block'); else assert.equal(run.stdout, '');
  }
});
