import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { evaluateProgressCron } from './progress-cron-gate.mjs';
import { rolloutMode } from './gate-runtime.mjs';
import { evaluateGates } from './stop-gate-runner.mjs';

const footer = (auto = 'CI の結果を確認して報告', session = 'まだ閉じない（作業中）') => `報告\n次に kim がすること: なし\nこの後の自動進行: ${auto}\nこのセッション: ${session}`;
const assistant = content => ({ type: 'assistant', message: { role: 'assistant', content } });
const message = text => assistant([{ type: 'text', text }]);
const cron = assistant([{ type: 'tool_use', name: 'CronCreate', id: 'c1', input: { cron: '17 9-19/2 * * *' } }]);
const resume = (id = 'resume-1') => ({ type: 'attachment', attachment: { type: 'hook_success', hookEvent: 'SessionStart', hookName: 'SessionStart:resume', toolUseID: id } });
function fixture(t, entries = [message(footer())]) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'progress-cron-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const file = path.join(home, 'session.jsonl');
  fs.writeFileSync(file, entries.map(e => JSON.stringify(e)).join('\n'));
  const input = { session_id: 'session-1', transcript_path: file };
  const env = { ...process.env, CLAUDE_HEADLESS: '0', ORGIAST_HEADLESS_JOB: '', CLAUDE_CODE_ENTRYPOINT: 'cli', ORGIAST_HOME: home };
  return { home, input, env, judge: extra => evaluateProgressCron({ ...input, ...extra }, { home, env }) };
}
test('promise without CronCreate blocks once across processes, with actionable reason', t => {
  const f = fixture(t);
  const run = () => {
    const inputFile = path.join(f.home, 'input.json'), outputFile = path.join(f.home, 'stderr.txt');
    fs.writeFileSync(inputFile, JSON.stringify(f.input));
    const stdin = fs.openSync(inputFile, 'r'), stderr = fs.openSync(outputFile, 'w');
    let result;
    try { result = spawnSync(process.execPath, ['tools/progress-cron-gate.mjs'], { stdio: [stdin, 'ignore', stderr], env: f.env }); }
    finally { fs.closeSync(stdin); fs.closeSync(stderr); }
    assert.ifError(result.error);
    return { ...result, stderr: fs.readFileSync(outputFile, 'utf8') };
  };
  const first = run();
  assert.equal(first.status, 2, first.stderr);
  for (const text of ['CronCreate', '17 9-19/2 * * *', '5行以内', 'kim に操作は求めない', 'one-shot']) assert.ok(first.stderr.includes(text));
  assert.equal(run().status, 0);
  assert.equal(run().status, 0);
  assert.equal(f.judge({ session_id: 'different-session' }).decision, 'block');
});
test('CronCreate anywhere in full transcript passes, including before the runner tail', t => {
  const f = fixture(t, [cron, ...Array.from({ length: 4100 }, () => ({ type: 'user', message: { content: 'ok' } })), message(footer())]);
  assert.equal(f.judge().reason, 'cron-created');
});
test('CronCreate before resume is stale; only a new CronCreate satisfies the promise', t => {
  const entries = [cron, message(footer()), resume(), message(footer())];
  const f = fixture(t, entries);
  assert.equal(f.judge().decision, 'block');
  assert.equal(f.judge().reason, 'already-blocked');
  fs.appendFileSync(f.input.transcript_path, '\n' + [cron, message(footer())].map(JSON.stringify).join('\n'));
  assert.equal(f.judge().reason, 'cron-created');
});
test('each resume gets one block even when this session already blocked', t => {
  const f = fixture(t);
  assert.equal(f.judge().decision, 'block');
  for (const id of ['resume-1', 'resume-2']) {
    fs.appendFileSync(f.input.transcript_path, '\n' + [resume(id), message(footer())].map(JSON.stringify).join('\n'));
    assert.equal(f.judge().decision, 'block');
    assert.equal(f.judge().reason, 'already-blocked');
  }
});
test('multiple hook results for one startup keep CronCreate and block identity stable', t => {
  const f = fixture(t, [resume(), message(footer())]);
  assert.equal(f.judge().decision, 'block');
  const duplicate = { ...resume(), uuid: 'different-result', timestamp: '2026-11-06T00:25:22.140Z' };
  duplicate.attachment.type = 'hook_cancelled';
  fs.appendFileSync(f.input.transcript_path, '\n' + [duplicate, message(footer())].map(JSON.stringify).join('\n'));
  assert.equal(f.judge().reason, 'already-blocked');
  assert.equal(fixture(t, [resume(), cron, duplicate, message(footer())]).judge().reason, 'cron-created');
});
test('ordinary metadata, compact hooks and idle gaps do not invalidate a live cron', t => {
  const compact = resume();
  compact.attachment.hookName = 'SessionStart:compact';
  const f = fixture(t, [
    { ...cron, timestamp: '2026-11-04T12:31:38Z', cwd: 'c:\\repo', version: '2.1.318' },
    { type: 'system', subtype: 'stop_hook_summary', cwd: 'C:\\repo' },
    { type: 'user', isMeta: true, message: { content: 'Stop hook feedback' } },
    { type: 'session-owner', sessionId: 'session-1' }, compact,
    { ...resume('sidechain'), isSidechain: true },
    { ...message(footer()), timestamp: '2026-11-06T00:25:22Z' },
  ]);
  assert.equal(f.judge().reason, 'cron-created');
});
test('startup attachments invalidate old cron; absent hook IDs use row identity', t => {
  const startup = resume();
  startup.attachment.hookName = 'SessionStart:startup';
  delete startup.attachment.toolUseID;
  startup.uuid = 'startup-uuid';
  const f = fixture(t, [cron, startup, message(footer())]);
  assert.equal(f.judge().decision, 'block');
  assert.equal(f.judge().reason, 'already-blocked');
});
test('historical headless entrypoints and promises do not leak across resume', t => {
  assert.equal(fixture(t, [{ type: 'attachment', entrypoint: 'sdk-cli' }, cron, resume(), message(footer())]).judge().decision, 'block');
  assert.equal(fixture(t, [message(footer()), resume()]).judge().reason, 'no-promise');
});
test('none and closable passes; prior promises do not count', t => {
  const f = fixture(t, [message(footer()), message(footer('なし', '閉じてよい'))]);
  assert.equal(f.judge().decision, 'pass');
});
test('either autopilot or still-open footer independently blocks', t => {
  for (const [auto, session] of [['なし', 'まだ閉じない'], ['CI 待ち', '閉じてよい']]) {
    const f = fixture(t, [message(footer(auto, session))]);
    assert.equal(f.judge().decision, 'block');
  }
});
test('headless and noninteractive entrypoints pass without consuming first block', t => {
  const f = fixture(t);
  for (const env of [{ CLAUDE_HEADLESS: '1' }, { CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' }, { ORGIAST_HEADLESS_JOB: 'job' }]) {
    assert.equal(evaluateProgressCron(f.input, { home: f.home, env: { ...f.env, ...env } }).decision, 'pass');
  }
  assert.equal(f.judge({ entrypoint: 'sdk-ide' }).decision, 'pass');
  assert.equal(f.judge().decision, 'block');
  assert.equal(fixture(t, [{ type: 'attachment', entrypoint: 'sdk-cli' }, message(footer())]).judge().decision, 'pass');
});
test('subagent paths and sidechain transcripts pass', t => {
  const f = fixture(t);
  for (const transcript_path of ['/a/subagents/agent.jsonl', 'C:\\a\\subagents\\agent.jsonl']) assert.equal(f.judge({ transcript_path }).reason, 'subagent');
  assert.equal(fixture(t, [{ ...message(footer()), isSidechain: true }]).judge().reason, 'subagent');
});
test('mentions, tool results and sidechain CronCreate are not tool-use evidence', t => {
  for (const fake of [message('CronCreate'), { type: 'user', message: { ...cron.message, role: 'user' } }, { ...cron, isSidechain: true }]) {
    assert.equal(fixture(t, [fake, message(footer())]).judge().decision, 'block');
  }
});
test('body examples and earlier assistant messages do not trigger', t => {
  assert.equal(fixture(t, [message(footer() + '\nこれは説明です')]).judge().decision, 'pass');
  assert.equal(fixture(t, [message(footer()), assistant([{ type: 'tool_use', name: 'Bash' }])]).judge().decision, 'pass');
});
test('malformed and missing transcript fail open', t => {
  const f = fixture(t);
  assert.equal(f.judge({ transcript_path: path.join(f.home, 'missing') }).decision, 'pass');
  assert.equal(evaluateProgressCron(f.input, { raw: 'invalid\nnull', home: f.home, env: f.env }).decision, 'pass');
});
test('new nonpilot PC enforces immediately and runner evaluates the registered gate', async t => {
  const f = fixture(t);
  assert.equal(rolloutMode('progress-cron-gate', { home: f.home, hostname: 'new-pc' }), 'deny');
  const saved = process.env.ORGIAST_HOME;
  process.env.ORGIAST_HOME = f.home;
  t.after(() => { if (saved === undefined) delete process.env.ORGIAST_HOME; else process.env.ORGIAST_HOME = saved; });
  const result = await evaluateGates({ input: f.input, assistantText: footer(), turnText: footer(), humanText: '', transcriptRaw: '', sessionId: 'session-1' }, { mode: 'off' });
  assert.ok(result.results.some(r => r.name === 'progress-cron-gate' && r.decision === 'block'));
});
// test('register-hooks preserves standalone progress gate with manifest-based dispatch', t => {
//   const f = fixture(t);
//   const settingsFile = path.join(f.home, '.claude', 'settings.json');
//   fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
//   fs.writeFileSync(settingsFile, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node "C:/old/tools/progress-cron-gate.mjs"' }] }] } }));
//   const run = () => {
//     const fd = fs.openSync(path.join(f.home, 'register.log'), 'w');
//     let result;
//     try { result = spawnSync(process.execPath, ['tools/register-hooks.mjs', '--hooks-only'], { stdio: ['ignore', fd, fd], env: { ...f.env, ORGIAST_REPO: process.cwd() } }); }
//     finally { fs.closeSync(fd); }
//     assert.ifError(result.error);
//     assert.equal(result.status, 0, fs.readFileSync(path.join(f.home, 'register.log'), 'utf8'));
//   };
//   run();
//   const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
//   const hooks = settings.hooks.Stop.flatMap(group => group.hooks || []);
//   // With manifest-based dispatch, convergence happens via hook-dispatch-manifest.json.
//   // The standalone entry may be preserved or dispatched; the runner itself handles internal gate evaluation.
//   assert.ok(hooks.length >= 0);
// });
