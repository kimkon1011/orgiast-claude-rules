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
  assert.equal(check(incident(), '直しました [NO-TEST-OK: コメントのみの変更であり実行時の動作差分が存在しないため]'), null);
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
test('Aの本番実行後に別ファイルBをmerge・実行してもAの証拠は有効', () => {
  const rows = [human('修正して'), ...edit('tools/A.mjs'),
    ...bash('node /production/tools/A.mjs'),
    ...bash('gh pr merge 42', '{"files":[{"path":"tools/B.mjs"}]}')];
  assert.match(check(rows, '完了'), /未実行: tools\/B.mjs\n/);
  assert.equal(check([...rows, ...bash('node /production/tools/B.mjs')], '完了'), null);
});
test('Aの実行後にAを再変更すると古い実行証拠では通らない', () => {
  const rows = [human('修正して'), ...edit('tools/A.mjs'),
    ...bash('node /production/tools/A.mjs'), ...edit('tools/A.mjs')];
  assert.match(check(rows, '完了'), /未実行: tools\/A.mjs\n/);
  assert.equal(check([...rows, ...bash('node /production/tools/A.mjs')], '完了'), null);
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

test('PR diff paths strip a/b prefixes and ignore bare identifiers and test fragments', () => {
  const rows = [...bash('gh pr diff 1025', '--- a/tools/check.mjs\n+++ b/tools/check.mjs\nrow.ts test.mjs .mjs a/row.ts b/test.mjs\n tools/check.test.mjs | 3 ++'), ...edit('tools/check.mjs'), ...bash('node /production/tools/check.mjs')];
  assert.equal(check(rows, '修正しました'), null);
});
test('repository path matches deployments but distinguishes different directories', () => {
  for (const file of ['C:/clone/tools/check.mjs', 'C:\\clone\\tools\\check.mjs', '/clone/src/check.mjs']) {
    const deployed = file.includes('src/') ? '/production/src/check.mjs' : '/production/tools/check.mjs';
    assert.equal(check([...edit(file), ...bash(`node ${deployed}`)], '完了'), null);
    assert.ok(check([...edit(file), ...bash('node /production/other/check.mjs')], '完了'));
  }
});
for (const method of ['spawn', 'spawnSync', 'execFile', 'execFileSync']) {
  test(`scratchpad ${method} counts real child execution but rejects doubles and non-interpreters`, () => {
    const rows = [...edit('tools/check.mjs'), ...bash('node scratchpad/replay.mjs')];
    const source = `import { ${method} } from 'node:child_process'; const target = '/production/tools/check.mjs'; ${method}(process.execPath, [target], { encoding: 'utf8' });`;
    assert.equal(check(rows, '完了', { readFile: () => source }), null);
    assert.ok(check(rows, '完了', { readFile: () => source + '\nconst fetchImpl = fake;' }));
    assert.ok(check(rows, '完了', { readFile: () => source.replace('process.execPath', "'echo'") }));
    assert.ok(check(rows, '完了', { readFile: () => source.replace('[target]', "['--test', target]") }));
  });
}
test('deleted worktree edits verified through nightly-repo codex and scratchpad replay (CLI)', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-replay-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const worktree = path.join(dir, 'ocr-verify-gate');
  const scratch = path.join(dir, 'scratchpad/replay.mjs');
  fs.mkdirSync(worktree);
  fs.mkdirSync(path.dirname(scratch));
  fs.writeFileSync(scratch, `import { spawnSync } from 'node:child_process';\nspawnSync(process.execPath, ['~/.claude/nightly-repo/tools/verify-before-done-detector.mjs'], { input: '{}' });`);
  const rows = [human('修正して'), ...edit(`${worktree}/tools/verify-before-done-detector.mjs`), ...edit(`${worktree}/tools/codex-do.mjs`), ...bash('gh pr diff 1025', 'tools/verify-before-done-detector.mjs | 4 ++\ntools/codex-do.mjs | 2 ++\ntest.mjs row.ts .mjs'), ...bash(`rm -rf ${worktree}`), ...bash('node C:/Users/uers/.claude/nightly-repo/tools/codex-do.mjs --prompt task', 'MAKELOOP=no'), ...bash(`node ${scratch}`, '{"decision":"pass"}')];
  fs.rmSync(worktree, { recursive: true });
  assert.equal(check(rows, '修正しました'), null);
  const transcript = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(transcript, [...rows, { type: 'assistant', message: { content: [{ type: 'text', text: '修正しました' }] } }].map(JSON.stringify).join('\n'));
  const run = spawnSync(process.execPath, [path.resolve('tools/verify-before-done-detector.mjs')], { input: JSON.stringify({ transcript_path: transcript, cwd: dir, session_id: 'deployment-regression' }), encoding: 'utf8', env: { ...process.env, ORGIAST_HOME: dir } });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stderr, '');
  assert.equal(run.stdout, '', 'successful Stop gate produces no block output');
  console.log(`deployment replay: exit=${run.status}, stdout=${JSON.stringify(run.stdout)}, stderr=${JSON.stringify(run.stderr)}`);
});

for (const separator of [';', '&&', '||', '\n']) {
  test(`連結 ${JSON.stringify(separator)} の3ファイルをすべて実行証拠に数える`, () => {
    const rows = ['a', 'b', 'c'].flatMap(n => edit(`tools/${n}.mjs`));
    assert.equal(check([...rows, ...bash(['a', 'b', 'c'].map(n => `node /production/tools/${n}.mjs --check`).join(separator))], '完了'), null);
  });
}
test('連結コマンドの失敗・隠された失敗シグナルは証拠にしない', () => {
  for (const output of ['Error: broken', 'ok\nFAIL a', 'Exit code: 1', '{"exit_code":-1}', 'node: command not found']) {
    assert.ok(check([...edit('tools/a.mjs'), ...bash('node tools/a.mjs; echo ok', output)], '完了'), output);
  }
  assert.ok(check([...edit('tools/a.mjs'), ...bash('node tools/a.mjs; node tools/b.mjs', 'failed', true)], '完了'));
  assert.ok(check([...edit('tools/a.mjs'), ...call('Bash', {command: 'node tools/a.mjs; echo ok'}, [{type:'text', text:'Error: broken'}])], '完了'));
});
test('dry-run/testの除外をサブコマンド単位で適用する', () => {
  const rows = [...edit('tools/a.mjs'), ...edit('tools/b.mjs'), ...edit('tools/c.mjs'),
    ...bash('node tools/a.mjs --dry-run; node tools/b.mjs --test; node tools/c.mjs --status')];
  assert.match(check(rows, '完了'), /未実行: tools\/a.mjs, tools\/b.mjs\n/);
});
test('引用符内の区切り・echo・evalのコードを実行証拠にしない', () => {
  for (const cmd of ['echo "ok; node tools/a.mjs"', "echo 'ok && node tools/a.mjs'", 'node -e "0; node tools/a.mjs"']) {
    assert.ok(check([...edit('tools/a.mjs'), ...bash(cmd)], '完了'));
  }
  assert.equal(check([...edit('tools/a.mjs'), ...bash('node "tools/a.mjs" --label "a;b && c"')], '完了'), null);
});
test('NO-TEST-OKは20文字以上の具体理由を要求し、ファイル指定を限定する', () => {
  const rows = [...edit('tools/a.mjs'), ...edit('tools/b.mjs')];
  assert.equal(check(rows, '完了 [NO-TEST-OK: コメントのみの変更であり実行時の動作差分が存在しないため]'), null);
  assert.match(check(rows, '完了 [NO-TEST-OK: tools/a.mjs はコメントのみの変更であり動作差分がないため]'), /未実行: tools\/b.mjs\n/);
  assert.equal(check([...rows, ...bash('node tools/b.mjs')], '完了 [NO-TEST-OK: a.mjs はコメントのみの変更であり動作差分がないため]'), null);
  for (const reason of ['不要', '不要'.repeat(20), 'tools/a.mjs は後で確認するので本番での実行を先送りする']) {
    assert.ok(check(rows, `完了 [NO-TEST-OK: ${reason}]`));
  }
});
test('通知・Stop差し戻しを越えて最終変更後の実行証拠を保持する', () => {
  const rows = [human('修正して'), ...edit('tools/a.mjs'), ...bash('node /production/tools/a.mjs'),
    human('<task-notification>完了通知</task-notification>'), human('Stop hook feedback: 再確認'),
    {type:'user', isMeta:true, message:{content:'自動通知'}}];
  assert.equal(check(rows, '完了'), null);
  assert.ok(check([...rows, ...edit('tools/a.mjs')], '完了'));
});
test('別クローン表記の同じファイルを再変更しても古い実行では通さない', () => {
  const rows = [...edit('/clone/tools/a.mjs'), ...bash('node /production/tools/a.mjs'), ...edit('/other/tools/a.mjs')];
  assert.ok(check(rows, '完了'));
  assert.equal(check([...rows, ...bash('node /production/tools/a.mjs')], '完了'), null);
});
test('別サブコマンドのpipeは単独nodeの証拠を消さず、非ゼロexit出力は除外する', () => {
  assert.equal(check([...edit('tools/a.mjs'), ...bash('node tools/a.mjs; echo ok | tail -1')], '完了'), null);
  assert.ok(check([...edit('tools/a.mjs'), ...bash('node tools/a.mjs; echo "exit=$?"', 'exit=1')], '完了'));
});
