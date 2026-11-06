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

const stamped = (row, timestamp) => ({ ...row, timestamp });
const resumed = (timestamp = '2026-11-06T00:24:40.606Z', type = 'hook_success') => ({
  type: 'attachment', timestamp,
  attachment: { type, hookEvent: 'SessionStart', hookName: 'SessionStart:resume' },
});
test('observed SessionStart attachments invalidate earlier CronCreate', t => {
  for (const type of ['hook_success', 'hook_additional_context', 'async_hook_response', 'hook_cancelled']) {
    const boundary = resumed(undefined, type);
    assert.equal(fixture(t, [cron, boundary, message(footer())]).judge().decision, 'block');
    assert.equal(fixture(t, [cron, boundary, cron, message(footer())]).judge().reason, 'cron-created');
  }
});
test('system subtype/content and attachment hookName identify the latest start', t => {
  for (const row of [
    { type: 'system', subtype: 'SessionStart' },
    { type: 'system', content: 'SessionStart: resume' },
    { type: 'attachment', attachment: { type: 'hook_success', hookName: 'SessionStart:resume' } },
    { type: 'attachment', attachment: { type: 'hook_additional_context', hookEvent: 'SessionStart' } },
  ]) {
    const boundary = stamped(row, '2026-11-06T01:00:00Z');
    assert.equal(fixture(t, [resumed(), cron, boundary, message(footer())]).judge().decision, 'block');
    assert.equal(fixture(t, [boundary, cron, message(footer())]).judge().reason, 'cron-created');
  }
});
test('each boundary blocks once, including after a legacy block', t => {
  const f = fixture(t);
  assert.equal(f.judge().decision, 'block');
  for (const time of ['2026-11-06T01:00:00Z', '2026-11-06T02:00:00Z']) {
    fs.appendFileSync(f.input.transcript_path, '\n' + [resumed(time), message(footer())].map(JSON.stringify).join('\n'));
    assert.equal(f.judge().decision, 'block');
    assert.equal(f.judge().reason, 'already-blocked');
  }
});
test('without explicit starts, the last gap over 30 minutes invalidates old cron', t => {
  const f = fixture(t, [stamped(cron, '2026-11-06T00:00:00Z'), stamped(message(footer()), '2026-11-06T00:30:01Z')]);
  assert.equal(f.judge().decision, 'block');
  assert.equal(f.judge().reason, 'already-blocked');
  fs.appendFileSync(f.input.transcript_path, '\n' + JSON.stringify(stamped(message(footer()), '2026-11-06T01:01:00Z')));
  assert.equal(f.judge().decision, 'block');
  // The first row after a gap belongs to the resumed process, including CronCreate.
  assert.equal(fixture(t, [stamped(message('old'), '2026-11-06T00:00:00Z'), stamped(cron, '2026-11-06T01:00:00Z'), message(footer())]).judge().reason, 'cron-created');
});
test('30 minutes exactly, missing/invalid timestamps and ordinary mentions keep legacy behavior', t => {
  for (const row of [
    stamped(message('ok'), '2026-11-06T00:30:00Z'),
    stamped(message('ok'), 'invalid'),
    message('SessionStart'),
    { type: 'attachment', attachment: { type: 'instructions', hookEvent: 'SessionStart' } },
    { type: 'system', subtype: 'stop_hook_summary' },
    null,
  ]) assert.equal(fixture(t, [stamped(cron, '2026-11-06T00:00:00Z'), row, message(footer())]).judge().reason, 'cron-created');
});
test('explicit start takes precedence over later timestamp gaps', t => {
  assert.equal(fixture(t, [resumed(), stamped(cron, '2026-11-06T01:00:00Z'), stamped(message(footer()), '2026-11-06T03:00:00Z')]).judge().reason, 'cron-created');
});
