import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runOnce, invokeClaude, buildPrompt, resolveSupervisorAuth, sampleCpuBusy, supervisorModel } from './autopilot-run.mjs';
import { runAutopilot, acquireLock } from './autopilot-tick.mjs';

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-run-test-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return { home, askJevImpl: async () => ({ ok: false, reason: 'test_offline' }), platform: 'linux', dir: path.join(home, 'state'), token: '', userId: '', now: new Date('2026-09-21T01:00:00Z'), fetchImpl: async () => { throw new Error('unexpected network'); }, cpuBusyImpl: async () => 0 };
}

test('runner does not invoke Claude when unstarted, paused, stopped, or done', async (t) => {
  const opts = fixture(t);
  opts.invokeImpl = async () => { assert.fail('must not invoke Claude'); };
  assert.equal((await runOnce(opts)).skipped, 'not_started');
  await runAutopilot('start', { objective: 'test' }, opts);
  await runAutopilot('pause', {}, opts);
  assert.equal((await runOnce(opts)).skipped, 'manual_pause');
  await runAutopilot('stop', {}, opts);
  assert.equal((await runOnce(opts)).skipped, 'manual_stop');
  await runAutopilot('resume', {}, opts);
  await runAutopilot('post', { summary: 'complete', progress: 100, evidence: '結果を確認' }, opts);
  assert.equal((await runOnce(opts)).skipped, 'done');
});

test('run.log records whether the digest was actually delivered, even on a paused tick', async (t) => {
  const opts = fixture(t);
  await runAutopilot('start', { objective: 'test' }, opts);
  await runAutopilot('pause', {}, opts);
  const result = await runOnce({ ...opts, now: new Date('2026-09-21T03:00:00Z') });
  assert.equal(result.skipped, 'manual_pause');
  const log = fs.readFileSync(path.join(opts.dir, 'run.log'), 'utf8');
  assert.match(log, /"digest":"2026-09-21-12"/);
  assert.match(log, /"delivered":"none"/);
});

test('models follow planIncluded; prompt comes from skill and headless uses one foreground iteration', async (t) => {
  for (const [policy, model] of [[{ planIncluded: true }, 'claude-fable-5-1'], [{ planIncluded: false }, 'claude-opus-5'], [{}, 'claude-opus-5']]) {
    const opts = fixture(t);
    await runAutopilot('start', { objective: 'test' }, opts);
    const result = await runOnce({ ...opts, policy, executable: 'fake-claude', invokeImpl: async (invocation) => {
      assert.deepEqual(invocation.args, ['-p', '--model', model, '--output-format', 'stream-json', '--verbose']);
      assert.match(invocation.prompt, /codex-do\.mjs/);
      assert.match(invocation.prompt, /ScheduleWakeup と \/loop は使用しない/);
      assert.equal(invocation.timeoutMs, 40 * 60_000);
      await runAutopilot('post', { summary: 'work verified', progress: 10, codex: true }, opts);
      return { exitCode: 0, stdout: 'tail test' };
    } });
    assert.equal(result.model, model);
    assert.equal((await runAutopilot('status', {}, opts)).state.totalIterations, 1);
    const log = fs.readFileSync(path.join(opts.dir, 'run.log'), 'utf8');
    assert.match(log, /tail test/);
    assert.match(log, /"exitCode":0/);
  }
});

test('objective.md "model" pins the supervisor model per PC; fable pin is ignored when plan excludes it', async (t) => {
  for (const [pin, policy, model] of [
    ['claude-opus-5-5', { planIncluded: true }, 'claude-opus-5-5'],
    ['claude-fable-5-1', { planIncluded: false }, 'claude-opus-5'],
    ['gpt-5; rm -rf /', { planIncluded: true }, 'claude-fable-5-1'],
  ]) {
    const opts = fixture(t);
    await runAutopilot('start', { objective: 'test' }, opts);
    const file = path.join(opts.dir, 'objective.md');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/("objective":\s*"test")/, `$1, "model": ${JSON.stringify(pin)}`));
    let seen = '';
    const result = await runOnce({ ...opts, policy, executable: 'fake-claude', invokeImpl: async (invocation) => {
      seen = invocation.args[2];
      await runAutopilot('post', { summary: 'work verified', progress: 10, codex: true }, opts);
      return { exitCode: 0, stdout: '' };
    } });
    assert.equal(seen, model);
    assert.equal(result.model, model);
  }
});

test('a new /autopilot start keeps the per-PC model pin', async (t) => {
  const opts = fixture(t);
  await runAutopilot('start', { objective: 'first' }, opts);
  const file = path.join(opts.dir, 'objective.md');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/("objective":\s*"first")/, '$1, "model": "claude-opus-5-5"'));
  await runAutopilot('stop', {}, opts);
  await runAutopilot('start', { objective: 'second' }, opts);
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /"objective": "second"/);
  assert.equal(supervisorModel(file, { planIncluded: true }), 'claude-opus-5-5');
});

test('repeated missing posts are counted and trip the noop watchdog', async (t) => {
  const opts = fixture(t);
  await runAutopilot('start', { objective: 'test', 'max-noop': 2 }, opts);
  const invokeImpl = async () => ({ exitCode: 0, timedOut: false, stdout: '' });
  assert.equal((await runOnce({ ...opts, invokeImpl })).status, 'running');
  assert.equal((await runOnce({ ...opts, invokeImpl })).status, 'paused');
  const state = (await runAutopilot('status', {}, opts)).state;
  assert.equal(state.totalIterations, 2);
  assert.equal(state.pausedReason, 'noop_streak');
  assert.ok(fs.existsSync(path.join(opts.home, '.claude', 'next-session.md')));
});

test('runner lock prevents overlapping headless invocations', async (t) => {
  const opts = fixture(t);
  fs.mkdirSync(opts.dir, { recursive: true });
  const release = acquireLock(path.join(opts.dir, 'run.lock'));
  try { assert.equal((await runOnce(opts)).skipped, 'already_running'); }
  finally { release(); }
});

test('prompt reads changed skill at runtime rather than a duplicated instruction block', (t) => {
  const opts = fixture(t);
  fs.mkdirSync(path.join(opts.home, 'skills', 'autopilot'), { recursive: true });
  fs.writeFileSync(path.join(opts.home, 'skills', 'autopilot', 'SKILL.md'), '---\nname: autopilot\n---\nUNIQUE SKILL BODY');
  assert.match(buildPrompt(opts.home), /UNIQUE SKILL BODY/);
});

test('real child process gets prompt via stdin; exit code and output are captured', async (t) => {
  const opts = fixture(t);
  const result = await invokeClaude({ executable: process.execPath, args: ['-e', "process.stdin.on('data', b => process.stdout.write(b)); process.stdin.on('end', () => process.exit(7));"], prompt: '日本語 " $ test', cwd: opts.home, timeoutMs: 5000 });
  assert.equal(result.exitCode, 7);
  assert.equal(result.stdout, '日本語 " $ test');
  assert.equal(result.timedOut, false);
});

test('real child timeout is bounded and missing executable returns failure', async (t) => {
  const opts = fixture(t);
  const timed = await invokeClaude({ executable: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], prompt: '', cwd: opts.home, timeoutMs: 100 });
  assert.equal(timed.timedOut, true);
  assert.notEqual(timed.exitCode, 0);
  const missing = await invokeClaude({ executable: path.join(opts.home, 'not-a-real-executable'), args: [], prompt: '', cwd: opts.home, timeoutMs: 1000 });
  assert.equal(missing.launchError, 'ENOENT');
});

test('runner failures pause and send one short runner_error DM', async (t) => {
  for (const invokeImpl of [async () => { throw new Error('broken'); }, async () => ({ exitCode: 1, timedOut: true }), async () => ({ exitCode: 1, launchError: 'ENOENT' })]) {
    const sent = [];
    const opts = { ...fixture(t), notifyImpl: async text => { sent.push(text); return { delivered: 'dm' }; }, invokeImpl };
    await runAutopilot('start', { objective: 'test' }, opts);
    let now = opts.now;
    for (let i = 0; i < 3; i++) {
      if (i > 0) now = new Date(now.getTime() + (i === 1 ? 31 : 61) * 60_000);
      await runOnce({ ...opts, now });
    }
    assert.equal((await runAutopilot('status', {}, opts)).state.pausedReason, 'runner_error');
    assert.equal(sent.length, 1);
    assert.match(sent[0], /エラーで止まりました/);
    assert.doesNotMatch(sent[0], /runner_error/);
    assert.ok(sent[0].split('\n').length <= 3);
  }
});

test('existing runner entry replenishes before launching Claude without explicit start', async (t) => {
  const opts = fixture(t), sent = [];
  fs.mkdirSync(path.join(opts.home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(opts.home, '.claude', 'next-actions.md'), '## 推奨アクション\n1. テスト修正');
  const result = await runOnce({ ...opts, askImpl: async () => 'Yes', notifyImpl: async text => { sent.push(text); }, invokeImpl: async () => {
    assert.equal((await runAutopilot('status', {}, opts)).objective.objective, 'テスト修正');
    await runAutopilot('post', { summary: 'work', progress: 10 }, opts);
    return { exitCode: 0 };
  } });
  assert.equal(result.status, 'running');
  assert.equal(sent.length, 1);
});

test('buildPrompt は fleet-mail の [判断依頼] へ返信も判断もしないよう指示する', () => {
  assert.match(buildPrompt(), /\[判断依頼\][^\n]*返信も判断も行わない/);
});

test('done state with a due watch invokes Claude once to check only that watch', async (t) => {
  const opts = fixture(t);
  await runAutopilot('start', { objective: '返信を送る' }, opts);
  await runAutopilot('post', { summary: 'sent', progress: 100, unverified: '相手に届いたか' }, opts);
  const prompts = [];
  const result = await runOnce({ ...opts, executable: 'fake-claude', invokeImpl: async (invocation) => {
    prompts.push(invocation.prompt);
    await runAutopilot('watch', { id: 'w1', result: 'ok', note: '相手から返事が来た' }, opts);
    return { exitCode: 0, stdout: 'checked' };
  } });
  assert.equal(result.watchChecked, 'w1');
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /見張り ID: w1/);
  assert.match(prompts[0], /watch --id w1/);
  assert.match(prompts[0], /相手に届いたか/);
  assert.equal((await runAutopilot('status', {}, opts)).state.watches.length, 0);
  // Listed once a day: a second run the same day does not invoke Claude again.
  const again = await runOnce({ ...opts, invokeImpl: async () => { assert.fail('must not invoke twice a day'); } });
  assert.equal(again.skipped, 'done');
});

test('失敗 1 回目・2 回目: 通知 0 件、paused(runner_error)、retryAt が 30 分 / 60 分後', async (t) => {
  const sent = [];
  const opts = { ...fixture(t), notifyImpl: async text => { sent.push(text); return { delivered: 'dm' }; }, invokeImpl: async () => ({ exitCode: 1 }) };
  await runAutopilot('start', { objective: 'test retry backoff' }, opts);

  // 失敗 1 回目
  await runOnce(opts);
  const s1 = (await runAutopilot('status', {}, opts)).state;
  assert.equal(sent.length, 0);
  assert.equal(s1.status, 'paused');
  assert.equal(s1.pausedReason, 'runner_error');
  assert.equal(s1.consecutiveRunnerErrors, 1);
  const expectedRetry1 = new Date(opts.now.getTime() + 30 * 60_000).toISOString();
  assert.equal(s1.runnerErrorRetryAt, expectedRetry1);

  // 失敗 2 回目（31分後）
  const now2 = new Date(opts.now.getTime() + 31 * 60_000);
  await runOnce({ ...opts, now: now2 });
  const s2 = (await runAutopilot('status', {}, opts)).state;
  assert.equal(sent.length, 0);
  assert.equal(s2.status, 'paused');
  assert.equal(s2.pausedReason, 'runner_error');
  assert.equal(s2.consecutiveRunnerErrors, 2);
  const expectedRetry2 = new Date(now2.getTime() + 60 * 60_000).toISOString();
  assert.equal(s2.runnerErrorRetryAt, expectedRetry2);
});

test('retryAt 前の pre は skip、retryAt 後の pre は run に戻る', async (t) => {
  const opts = { ...fixture(t), invokeImpl: async () => ({ exitCode: 1 }) };
  await runAutopilot('start', { objective: 'test retry timing' }, opts);
  await runOnce(opts);

  // retryAt 前 (15分後)
  const preBefore = await runAutopilot('pre', {}, { ...opts, now: new Date(opts.now.getTime() + 15 * 60_000) });
  assert.equal(preBefore.verdict, 'pause');
  assert.equal(preBefore.reason, 'runner_error');
  const runBefore = await runOnce({ ...opts, now: new Date(opts.now.getTime() + 15 * 60_000) });
  assert.equal(runBefore.skipped, 'runner_error');

  // retryAt 後 (30分後)
  const preAfter = await runAutopilot('pre', {}, { ...opts, now: new Date(opts.now.getTime() + 30 * 60_000) });
  assert.equal(preAfter.verdict, 'run');
  const sAfter = (await runAutopilot('status', {}, opts)).state;
  assert.equal(sAfter.status, 'running');
  assert.equal(sAfter.pausedReason, null);
});

test('失敗 3 回目: 通知がちょうど 1 件、自動再開しない', async (t) => {
  const sent = [];
  const opts = { ...fixture(t), notifyImpl: async text => { sent.push(text); return { delivered: 'dm' }; }, invokeImpl: async () => ({ exitCode: 1 }) };
  await runAutopilot('start', { objective: 'test 3 failures stop' }, opts);

  // 1回目
  await runOnce(opts);
  assert.equal(sent.length, 0);

  // 2回目 (31分後)
  await runOnce({ ...opts, now: new Date(opts.now.getTime() + 31 * 60_000) });
  assert.equal(sent.length, 0);

  // 3回目 (31 + 61分後)
  await runOnce({ ...opts, now: new Date(opts.now.getTime() + 92 * 60_000) });
  assert.equal(sent.length, 1);
  const s3 = (await runAutopilot('status', {}, opts)).state;
  assert.equal(s3.consecutiveRunnerErrors, 3);
  assert.equal(s3.runnerErrorRetryAt, null);
  assert.equal(s3.status, 'paused');
  assert.equal(s3.pausedReason, 'runner_error');
  assert.match(sent[0], /3回続けて失敗したため止めました/);
  assert.doesNotMatch(sent[0], /runner_error/);
  assert.doesNotMatch(sent[0], /exitCode/);

  // 10時間経過後も自動再開しない
  const preLater = await runAutopilot('pre', {}, { ...opts, now: new Date(opts.now.getTime() + 600 * 60_000) });
  assert.equal(preLater.verdict, 'pause');
  assert.equal(preLater.reason, 'runner_error');
  assert.equal(sent.length, 1);
});

test('成功で counter が 0 に戻る', async (t) => {
  const opts = { ...fixture(t), invokeImpl: async () => ({ exitCode: 1 }) };
  await runAutopilot('start', { objective: 'test success reset' }, opts);

  // 1回失敗
  await runOnce(opts);
  const s1 = (await runAutopilot('status', {}, opts)).state;
  assert.equal(s1.consecutiveRunnerErrors, 1);
  assert.ok(s1.runnerErrorRetryAt);

  // 2回目は成功
  const now2 = new Date(opts.now.getTime() + 31 * 60_000);
  await runOnce({ ...opts, now: now2, invokeImpl: async () => {
    await runAutopilot('post', { summary: '作業完了', progress: 50 }, { ...opts, now: now2 });
    return { exitCode: 0 };
  } });
  const s2 = (await runAutopilot('status', {}, opts)).state;
  assert.equal(s2.consecutiveRunnerErrors, 0);
  assert.equal(s2.runnerErrorRetryAt, null);
  assert.equal(s2.status, 'running');
});

test('質問待ちは全体を止めず、24時間後も他の作業を進められる', async (t) => {
  const opts = fixture(t);
  await runAutopilot('start', { objective: 'test needs_kim pause' }, opts);
  await runAutopilot('pause', { question: 'この変更を進めますか？' }, opts);
  const s1 = (await runAutopilot('status', {}, opts)).state;
  assert.equal(s1.status, 'running');
  assert.equal(s1.pausedReason, null);

  // 質問は保留し、無関係の巡回は継続する。
  const preLater = await runAutopilot('pre', {}, { ...opts, now: new Date(opts.now.getTime() + 24 * 3600_000) });
  assert.equal(preLater.verdict, 'run');
  assert.equal(preLater.pendingQuestion, 'この変更を進めますか？');
});

test('人が resume した時も counter と retryAt をリセットする', async (t) => {
  const opts = { ...fixture(t), invokeImpl: async () => ({ exitCode: 1 }) };
  await runAutopilot('start', { objective: 'test manual resume' }, opts);
  await runOnce(opts);
  const s1 = (await runAutopilot('status', {}, opts)).state;
  assert.equal(s1.consecutiveRunnerErrors, 1);
  assert.ok(s1.runnerErrorRetryAt);

  // 人が resume
  await runAutopilot('resume', {}, opts);
  const s2 = (await runAutopilot('status', {}, opts)).state;
  assert.equal(s2.consecutiveRunnerErrors, 0);
  assert.equal(s2.runnerErrorRetryAt, null);
  assert.equal(s2.status, 'running');
});

test('進捗報告: 12:00 枠・21:00 枠でそれぞれ 1 回だけ送る。同じ枠の 2 回目の起床では送らない。内部語を含まない', async (t) => {
  const sent = [];
  const opts = { ...fixture(t), notifyImpl: async text => { sent.push(text); return { delivered: 'dm' }; } };
  await runAutopilot('start', { objective: '定期進捗テスト', 'max-noop': 100, 'max-hours-per-day': 24, 'max-iter-per-day': 100 }, opts);
  await runAutopilot('post', { summary: '最初の実装完了', progress: 30 }, opts);

  // 起床 1: 10:00 JST (枠外)
  await runOnce({ ...opts, now: new Date('2026-10-14T10:00:00+09:00'), invokeImpl: async () => ({ exitCode: 0 }) });
  assert.equal(sent.length, 0);

  // 起床 2: 12:00 JST (12:00 枠の最初の起床)
  await runOnce({ ...opts, now: new Date('2026-10-14T12:00:00+09:00'), invokeImpl: async () => ({ exitCode: 0 }) });
  assert.equal(sent.length, 1);
  assert.match(sent[0], /定時進捗報告/);
  assert.match(sent[0], /最初の実装完了/);
  assert.doesNotMatch(sent[0], /runner_error/);
  assert.doesNotMatch(sent[0], /exitCode/);
  assert.doesNotMatch(sent[0], /noop/);
  assert.ok(sent[0].split('\n').length <= 15);

  // 起床 3: 12:30 JST (12:00 枠の2回目の起床 -> 二重送信しない)
  await runOnce({ ...opts, now: new Date('2026-10-14T12:30:00+09:00'), invokeImpl: async () => ({ exitCode: 0 }) });
  assert.equal(sent.length, 1);

  // 起床 4: 15:00 JST (同じく12:00 枠内 -> 送らない)
  await runOnce({ ...opts, now: new Date('2026-10-14T15:00:00+09:00'), invokeImpl: async () => ({ exitCode: 0 }) });
  assert.equal(sent.length, 1);

  // 起床 5: 21:00 JST (21:00 枠の最初の起床)
  await runOnce({ ...opts, now: new Date('2026-10-14T21:00:00+09:00'), invokeImpl: async () => ({ exitCode: 0 }) });
  assert.equal(sent.length, 2);
  assert.match(sent[1], /定時進捗報告/);
  assert.doesNotMatch(sent[1], /runner_error/);
  assert.doesNotMatch(sent[1], /exitCode/);
  assert.doesNotMatch(sent[1], /noop/);
  assert.ok(sent[1].split('\n').length <= 15);

  // 起床 6: 21:30 JST (21:00 枠の2回目の起床 -> 二重送信しない)
  await runOnce({ ...opts, now: new Date('2026-10-14T21:30:00+09:00'), invokeImpl: async () => ({ exitCode: 0 }) });
  assert.equal(sent.length, 2);
});

test('resolveSupervisorAuth: OAuth が死んでいる時だけ openrouter.env の鍵へ切り替える', () => {
  const files = (map) => (file) => {
    const name = path.basename(String(file));
    if (!(name in map)) throw new Error('ENOENT');
    return map[name];
  };
  const creds = (token) => JSON.stringify({ claudeAiOauth: { accessToken: token } });

  const envLane = resolveSupervisorAuth({ home: 'H', env: { ANTHROPIC_AUTH_TOKEN: 'x' }, readFile: files({}) });
  assert.equal(envLane.lane, 'env');
  assert.equal(envLane.model, null);

  const oauthEnv = { PATH: 'q' };
  const oauthLane = resolveSupervisorAuth({ home: 'H', env: oauthEnv, readFile: files({ '.credentials.json': creds('tok') }) });
  assert.equal(oauthLane.lane, 'oauth');
  assert.equal(oauthLane.model, null);
  assert.equal(oauthLane.env, oauthEnv);

  const dead = files({ '.credentials.json': creds(''), 'openrouter.env': 'OPENROUTER_API_KEY="sk-test"\n' });
  const fallback = resolveSupervisorAuth({ home: 'H', env: { PATH: 'p' }, readFile: dead });
  assert.equal(fallback.lane, 'deepseek');
  assert.equal(fallback.model, 'deepseek/deepseek-v4-flash');
  assert.equal(fallback.env.ANTHROPIC_AUTH_TOKEN, 'sk-test');
  assert.equal(fallback.env.ANTHROPIC_BASE_URL, 'https://openrouter.ai/api');
  assert.equal(fallback.env.PATH, 'p');

  const noKey = resolveSupervisorAuth({ home: 'H', env: {}, readFile: files({ '.credentials.json': creds('') }) });
  assert.equal(noKey.lane, 'none');
  assert.equal(noKey.model, null);
  assert.equal(resolveSupervisorAuth({ home: 'H', env: {}, readFile: files({}) }).lane, 'none');
});

test('streaming records tool stage before timeout without persisting tool arguments', async t => {
  const opts = fixture(t);
  const events = [];
  const program = `console.log(JSON.stringify({type:'assistant',message:{content:[{type:'tool_use',name:'Bash',input:{command:'SECRET'}}]}})); setInterval(()=>{},1000)`;
  const result = await invokeClaude({ executable: process.execPath, args: ['-e', program, '--', 'stream-json'], prompt: '', cwd: opts.home, timeoutMs: 500, onProgress: e => events.push(e) });
  assert.equal(result.timedOut, true);
  assert.equal(result.lastStage, 'tool:Bash');
  assert.deepEqual(events, [{ stage: 'tool:Bash' }]);
  assert.doesNotMatch(JSON.stringify(result), /SECRET/);
});

test('Jev RETRY は次の監督プロンプトへ渡し、runner 失敗は既存処理で停止', async t => {
  const opts = fixture(t);
  opts.askJevImpl = async () => ({ ok: true, answers: { action: { type: 'choice', choice: 'RETRY' } } });
  await runAutopilot('start', { objective: 'test' }, opts);
  await runAutopilot('post', { summary: 'work', progress: 10 }, opts);
  const result = await runOnce({ ...opts, executable: 'fake-claude', policy: {}, invokeImpl: async invocation => {
    assert.match(invocation.prompt, /前回の Jev 判断: RETRY/);
    return { exitCode: 1, stderr: '', stdout: '', timedOut: false };
  } });
  assert.equal(result.status, 'paused');
  assert.equal((await runAutopilot('status', {}, opts)).state.pausedReason, 'runner_error');
});

test('cpuBusyImpl が 0.99 を返すとき invokeImpl が呼ばれず、run.log に host_busy が残り、state の status・totalIterations・consecutiveRunnerErrors が変わらない', async (t) => {
  const opts = fixture(t);
  await runAutopilot('start', { objective: 'test host busy' }, opts);
  const before = (await runAutopilot('status', {}, opts)).state;
  let invoked = false;
  const result = await runOnce({
    ...opts,
    cpuBusyImpl: async () => 0.99,
    invokeImpl: async () => { invoked = true; return { exitCode: 0 }; },
  });
  assert.equal(invoked, false);
  assert.equal(result.skipped, 'host_busy');
  assert.equal(result.cpuBusy, 0.99);

  const log = fs.readFileSync(path.join(opts.dir, 'run.log'), 'utf8');
  assert.match(log, /"skipped":"host_busy"/);
  assert.match(log, /"cpuBusy":0\.99/);

  const after = (await runAutopilot('status', {}, opts)).state;
  assert.equal(after.status, before.status);
  assert.equal(after.totalIterations, before.totalIterations);
  assert.equal(after.consecutiveRunnerErrors, before.consecutiveRunnerErrors);
});

test('cpuBusyImpl が 0.30 を返すとき従来どおり invokeImpl が1回呼ばれ、渡された prompt に pre-latest.json のパスと「pre を再実行しない」が入り、そのファイルが実在して verdict が "run"', async (t) => {
  const opts = fixture(t);
  await runAutopilot('start', { objective: 'test busy normal' }, opts);
  let invocations = 0;
  let capturedPrompt = '';
  const result = await runOnce({
    ...opts,
    cpuBusyImpl: async () => 0.30,
    invokeImpl: async (inv) => {
      invocations++;
      capturedPrompt = inv.prompt;
      await runAutopilot('post', { summary: 'done tick', progress: 20 }, opts);
      return { exitCode: 0, stdout: 'ok' };
    },
  });
  assert.equal(invocations, 1);
  assert.match(capturedPrompt, /pre-latest\.json/);
  assert.match(capturedPrompt, /pre を再実行しない/);

  const preFile = path.join(opts.dir, 'pre-latest.json');
  assert.ok(fs.existsSync(preFile));
  const preJson = JSON.parse(fs.readFileSync(preFile, 'utf8'));
  assert.equal(preJson.verdict, 'run');
});

test('buildPrompt() を引数なしで呼んだ出力が変更前と同じ（pre-latest の文言を含まない）', () => {
  const prompt = buildPrompt();
  assert.doesNotMatch(prompt, /pre-latest/);
  assert.doesNotMatch(prompt, /pre を再実行しない/);
  assert.match(prompt, /<実行コンテキスト>/);
  assert.match(prompt, /pre が error なら実装せず終了する。\nfleet-mail の受信メールに/);
});

test('sampleCpuBusy に偽の cpusImpl（2回目で idle だけ増えるもの／user だけ増えるもの）を渡すと 0 付近 / 1 付近を返す', async () => {
  let idleCalls = 0;
  const idleCpus = () => {
    idleCalls++;
    return idleCalls === 1
      ? [{ times: { user: 100, idle: 100 } }]
      : [{ times: { user: 100, idle: 300 } }];
  };
  const idleRate = await sampleCpuBusy({ cpusImpl: idleCpus, sleep: async () => {} });
  assert.ok(idleRate >= 0 && idleRate <= 0.05, `expected near 0, got ${idleRate}`);

  let userCalls = 0;
  const userCpus = () => {
    userCalls++;
    return userCalls === 1
      ? [{ times: { user: 100, idle: 100 } }]
      : [{ times: { user: 300, idle: 100 } }];
  };
  const userRate = await sampleCpuBusy({ cpusImpl: userCpus, sleep: async () => {} });
  assert.ok(userRate >= 0.95 && userRate <= 1, `expected near 1, got ${userRate}`);
});

test('AUTOPILOT_SKIP_BUSY_CHECK=1 で高負荷チェックを無効化できる', async (t) => {
  const opts = fixture(t);
  await runAutopilot('start', { objective: 'test skip busy env' }, opts);
  let invoked = false;
  const result = await runOnce({
    ...opts,
    env: { ...process.env, AUTOPILOT_SKIP_BUSY_CHECK: '1' },
    cpuBusyImpl: async () => 0.99,
    invokeImpl: async () => {
      invoked = true;
      await runAutopilot('post', { summary: 'done', progress: 50 }, opts);
      return { exitCode: 0 };
    },
  });
  assert.equal(invoked, true);
  assert.notEqual(result.skipped, 'host_busy');
});

test('invokeImpl が受け取る timeoutMs が、options.timeoutMs 未指定時に 40*60_000 になる', async (t) => {
  const opts = fixture(t);
  await runAutopilot('start', { objective: 'test default timeout' }, opts);
  let capturedTimeoutMs;
  await runOnce({
    ...opts,
    invokeImpl: async (invocation) => {
      capturedTimeoutMs = invocation.timeoutMs;
      await runAutopilot('post', { summary: 'done', progress: 10 }, opts);
      return { exitCode: 0 };
    },
  });
  assert.equal(capturedTimeoutMs, 40 * 60_000);
});

test('invokeImpl が受け取る prompt に deadline の ISO 文字列と「残り秒数 − 480」が入る（options.now を固定して期待値を計算）', async (t) => {
  const opts = fixture(t);
  const now = new Date('2026-10-27T08:00:00.000Z');
  const expectedDeadline = new Date(now.getTime() + 40 * 60_000).toISOString();
  await runAutopilot('start', { objective: 'test prompt deadline' }, opts);
  let capturedPrompt;
  await runOnce({
    ...opts,
    now,
    invokeImpl: async (invocation) => {
      capturedPrompt = invocation.prompt;
      await runAutopilot('post', { summary: 'done', progress: 10 }, opts);
      return { exitCode: 0 };
    },
  });
  assert.match(capturedPrompt, new RegExp(expectedDeadline));
  assert.match(capturedPrompt, /残り秒数 − 480/);
});

test('buildPrompt(repo) と buildPrompt(repo, { preFile }) の出力に deadline の文言が入らない', () => {
  const repo = path.resolve('.');
  const promptRepoOnly = buildPrompt(repo);
  assert.doesNotMatch(promptRepoOnly, /強制終了される/);
  assert.doesNotMatch(promptRepoOnly, /残り秒数 − 480/);

  const promptWithPreFile = buildPrompt(repo, { preFile: 'pre-latest.json' });
  assert.doesNotMatch(promptWithPreFile, /強制終了される/);
  assert.doesNotMatch(promptWithPreFile, /残り秒数 − 480/);
});
