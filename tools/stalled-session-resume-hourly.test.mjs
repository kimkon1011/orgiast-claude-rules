import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { detectHourly, hourlyStopSignal, sessionIsRunning, runningHourlyProcesses, acquireSessionLock, classifyHourly, HOURLY_CLASSIFIERS, HOURLY_EXCLUDED_PROVIDERS, heartbeatLine, publishHourlyHeartbeat, readHourlyTail } from './lib/stalled-session-hourly.mjs';
import { executeHourlyFork, run, options } from './stalled-session-resume.mjs';

function homeFor(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hourly-fork-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}
const assistant = (text, extra = {}) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }], ...extra } });
const raw = (...events) => events.map(e => JSON.stringify(e)).join('\n') + '\n';
const policy = () => ({ hourlyResume: true, hourlyCap: 4, perSessionDailyCap: 6, planUsageStopPct: 85 });
const usage = async () => ({ available: true, fiveHour: { utilization: 10 }, sevenDay: { utilization: 20 } });
const guard = async () => ({ blocked: false, reason: 'below-threshold', weeklyPercent: 20, fiveHourPercent: 10 });

test('停止判定: 閉じ印・DONE・session-close実行を除き、tool/API/synthetic/未応答を拾う', () => {
  for (const text of ['このセッションを閉じてよい', 'このセッション: 閉じて可', 'DONE']) assert.equal(hourlyStopSignal(raw(assistant(text))), null);
  assert.equal(hourlyStopSignal(raw(assistant('作業の続きがあります'))).kind, 'no-close-marker');
  assert.equal(hourlyStopSignal(raw(assistant('', { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'node test' } }] }))).kind, 'tool-use');
  assert.equal(hourlyStopSignal(raw(assistant('API Error: 429'))).kind, 'api-error');
  assert.equal(hourlyStopSignal(raw(assistant('limit', { model: '<synthetic>' }))).kind, 'synthetic-limit');
  assert.equal(hourlyStopSignal(raw(assistant('', { content: [{ type: 'tool_use', name: 'Skill', input: { skill: 'session-close' } }] }))), null);
  assert.equal(hourlyStopSignal(raw({ type: 'user', message: { content: '<command-name>/session-close</command-name>' } })), null);
  assert.equal(hourlyStopSignal(raw(assistant('DONE'), { type: 'user', message: { content: '追加の修正をして' } })).kind, 'unanswered-user');
  assert.equal(hourlyStopSignal(raw(assistant('このセッション: まだ閉じない（作業中）【11/25/10:00まで】')), new Date(2026, 10, 25, 12).getTime()).kind, 'footer-expired');
});

test('検出: 30分〜7日・subagents除外・実行中除外・レポート/terminalの合流と未特定数', async t => {
  const home = homeFor(t), now = Date.now();
  const project = path.join(home, '.claude', 'projects', 'fixture'); fs.mkdirSync(project, { recursive: true });
  const write = (id, age, sub = '') => {
    const dir = path.join(project, sub); fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${id}.jsonl`);
    fs.writeFileSync(file, raw({ type: 'user', sessionId: id, cwd: home, message: { role: 'user', content: '修正してください' } }, assistant('まだ作業が残っています')));
    fs.utimesSync(file, new Date(now - age), new Date(now - age)); return file;
  };
  write('stalled', 31 * 60000); write('fresh', 29 * 60000); write('old', 8 * 86400000); write('running', 60 * 60000); write('sub', 60 * 60000, 'subagents');
  const dir = path.join(home, 'gb-reports', 'nested', 'task'); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'REPORT.md'), 'sessionId: stalled');
  const unknown = path.join(home, 'gb-reports', 'unknown', 'work'); fs.mkdirSync(unknown, { recursive: true });
  const terms = path.join(home, '.claude', 'terminals'); fs.mkdirSync(terms, { recursive: true }); fs.writeFileSync(path.join(terms, 'a.log'), 'sessionId: stalled\nunfinished'); fs.writeFileSync(path.join(terms, 'b.log'), 'no association');
  const records = await detectHourly({ home, now, processes: [{ Name: 'claude.exe', CommandLine: 'claude --resume running' }] });
  assert.deepEqual(records.map(r => r.sessionId), ['stalled']); assert.equal(records.unlinked, 2);
  assert.equal(sessionIsRunning('x', [{ Name: 'node.exe', CommandLine: 'claude --resume x' }]), true);
  assert.equal(sessionIsRunning('x', [{ Name: 'editor.exe', CommandLine: 'x' }]), false);
});

test('末尾ハッシュ: 長い行でも完全な最終行を読む、変更時だけ変わる', t => {
  const home = homeFor(t), file = path.join(home, 'large.jsonl');
  fs.writeFileSync(file, raw(assistant('x'.repeat(200000)), assistant('次の作業')));
  const first = readHourlyTail(file); assert.equal(first.raw.split('\n').length, 2);
  fs.appendFileSync(file, raw(assistant('変化'))); assert.notEqual(readHourlyTail(file).lastLineHash, first.lastLineHash);
});

test('PowerShellの単一プロセスJSONも配列に正規化する', () => {
  assert.equal(runningHourlyProcesses({ platform: 'win32', exec: () => '{"Name":"node.exe","CommandLine":"--resume abc"}' }).length, 1);
  assert.deepEqual(runningHourlyProcesses({ platform: 'win32', exec: () => 'null' }), []);
});

test('セッションロック: 二重拒否、死PIDと2時間超の奪取、古い解放が新ロックを消さない', t => {
  const home = homeFor(t), now = Date.now(), opts = { home, now, pid: 1234, alive: () => true };
  const release = acquireSessionLock('session', opts); assert.equal(typeof release, 'function');
  assert.equal(acquireSessionLock('session', opts), null);
  const dead = acquireSessionLock('session', { ...opts, alive: () => false }); assert.equal(typeof dead, 'function');
  release(); assert.equal(acquireSessionLock('session', opts), null); dead();
  const old = acquireSessionLock('session', opts);
  const stolen = acquireSessionLock('session', { ...opts, now: now + 7200001 }); assert.equal(typeof stolen, 'function'); old(); stolen();
  assert.throws(() => acquireSessionLock('../escape', opts), /invalid/);
});

function memoryCache() {
  const saved = new Map();
  return { gate: (key, input) => ({ changed: saved.get(key)?.fingerprint !== input.fingerprint }), loadCursor: key => saved.get(key), commit: (key, value) => saved.set(key, value), recordRun() {} };
}
test('事前判定: 指定順でのみ試行、秘密を伏せ、cursor/Claudeを拒否、同一ハッシュは再照会しない', async t => {
  const home = homeFor(t), cache = memoryCache(), attempts = [];
  const record = { sessionId: 'classify', firstPrompt: '修正', lastLineHash: 'a', hourlyTail: 'OPENROUTER_API_KEY=sk-or-v1-' + 'a'.repeat(64) };
  const call = async opts => {
    attempts.push(opts.start.provider);
    assert.deepEqual(opts.chain, []); assert.equal(opts.allowGatewayFallback, false);
    const routed = opts.start.provider === 'mistral' ? { ...opts.start, provider: 'openrouter' } : opts.start;
    const request = opts.payloadFor(routed); assert.ok(request); assert.ok(!request.init.body.includes('a'.repeat(64)));
    assert.throws(() => opts.payloadFor({ provider: 'cursor', model: 'auto' }), /forbidden/);
    assert.throws(() => opts.payloadFor({ provider: 'openrouter', model: 'anthropic/claude-test' }), /forbidden/);
    if (opts.start.provider !== 'mistral') throw new Error('unavailable');
    return { response: new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ action: 'resume', reason: '未実装', nextStep: 'テストを実行' }) } }] })) };
  };
  const first = await classifyHourly(record, { home, cache, call, loadKey: () => 'fixture' });
  assert.equal(first.action, 'resume'); assert.equal(first.cached, false);
  assert.deepEqual(attempts, ['openrouter', 'openrouter', 'gemini', 'groq', 'mistral']);
  const second = await classifyHourly(record, { home, cache, call }); assert.equal(second.cached, true); assert.equal(attempts.length, 5);
  assert.ok(HOURLY_EXCLUDED_PROVIDERS.includes('cursor-agent')); assert.ok(HOURLY_CLASSIFIERS.every(c => !/claude|cursor/.test(c.model)));
  const third = await classifyHourly({ ...record, lastLineHash: 'b' }, { home, cache, call, loadKey: () => 'fixture' }); assert.equal(third.cached, false); assert.equal(attempts.length, 10);
});

test('fork: 元と先のロックが起動前に存在し、引数とnextStepが一致、fork transcriptを検証', async t => {
  const home = homeFor(t), file = path.join(home, 'source.jsonl'), forkId = '11111111-1111-4111-8111-111111111111';
  fs.writeFileSync(file, 'source'); fs.utimesSync(file, new Date(0), new Date(0)); let calls = 0;
  const io = { home, evaluateGuard: guard, fetchClaudePlanUsage: usage, hourlyResumePolicy: policy, runningProcesses: () => [], randomUUID: () => forkId,
    executable: 'fixture-claude', readReport: async () => ({ state: 'progressed', evidence: 'テスト成功' }),
    execFile: async (exe, args, opts) => {
      calls++; assert.equal(exe, 'fixture-claude'); assert.deepEqual(args.slice(0, 5), ['--resume', 'source', '--fork-session', '--session-id', forkId]);
      assert.match(args.at(-1), /次の検証/); assert.ok(args.includes('-p')); assert.ok(args.includes('--model')); assert.equal(opts.env.ANTHROPIC_API_KEY, undefined);
      for (const id of ['source', forkId]) assert.ok(fs.existsSync(path.join(home, '.claude', 'stalled-resume-locks', `${id}.lock`)));
      fs.writeFileSync(path.join(home, `${forkId}.jsonl`), raw(assistant('進めました'))); return { stdout: '{}' };
    },
  };
  const result = await executeHourlyFork({ sessionId: 'source', cwd: home, file }, { timeoutMs: 1000, nextStep: '次の検証' }, io);
  assert.equal(calls, 1); assert.equal(result.outcome, 'progressed'); assert.equal(result.forkSessionId, forkId); assert.equal(result.resumedInSession, true);
  assert.deepEqual(fs.readdirSync(path.join(home, '.claude', 'stalled-resume-locks')), []);
});

test('429のモデルは次候補から10分待機し、他の安価モデルを使う', async t => {
  const home = homeFor(t), cache = memoryCache(), starts = [];
  const call = async opts => {
    starts.push(opts.start.model);
    if (opts.start.model.endsWith(':free')) {
      await opts.onAttempt({ candidate: opts.start, status: 'http_429' }); throw new Error('HTTP429');
    }
    return { response: new Response(JSON.stringify({ choices: [{ message: { content: '{"action":"done","reason":"完了","nextStep":""}' } }] })) };
  };
  for (const sessionId of ['one', 'two']) await classifyHourly({ sessionId, lastLineHash: sessionId, hourlyTail: 'log' }, { home, cache, call });
  assert.deepEqual(starts, ['google/gemma-4-31b-it:free', 'openai/gpt-oss-120b', 'openai/gpt-oss-120b']);
});

test('seat-guard/85%/使用量不明/実行中の各停止でClaudeを起動しない', async t => {
  const home = homeFor(t), file = path.join(home, 'source.jsonl'); fs.writeFileSync(file, 'source'); fs.utimesSync(file, new Date(0), new Date(0));
  const base = { home, evaluateGuard: guard, fetchClaudePlanUsage: usage, hourlyResumePolicy: policy, runningProcesses: () => [], execFile: () => assert.fail('must not spawn') };
  for (const overrides of [
    { evaluateGuard: async () => ({ blocked: true, reason: 'weekly-threshold' }) },
    { fetchClaudePlanUsage: async () => ({ available: true, fiveHour: { utilization: 85 }, sevenDay: { utilization: 10 } }) },
    { fetchClaudePlanUsage: async () => ({ available: false }), evaluateGuard: async () => ({ blocked: false }) },
    { runningProcesses: () => [{ Name: 'node', CommandLine: '--resume source' }] },
  ]) assert.equal((await executeHourlyFork({ sessionId: 'source', file, cwd: home }, { timeoutMs: 1000 }, { ...base, ...overrides })).executor, 'none');
});

test('hourly分岐: resumeだけ実行、waiting-humanをsessionIdでask、done/skipは記録、dry-runは未実行', async t => {
  const home = homeFor(t), actions = ['resume', 'waiting-human', 'done', 'skip'], now = Date.now();
  const records = actions.map((action, i) => ({ sessionId: `session-${i}`, file: `file-${i}`, cwd: home, displayTitle: `Task ${i}`, lastAssistantText: '未完了', ageDays: 1, action, lastLineHash: `hash-${i}` }));
  let calls = 0; const asks = [], heartbeats = [];
  const io = { home, now: () => now, detect: async () => records, stat: async () => ({ mtimeMs: now - 86400000 }), hourlyResumePolicy: policy,
    evaluateGuard: guard, fetchClaudePlanUsage: usage, fetchBeacons: async () => ({ beacons: [] }), fleetRows: [],
    classifyHourly: async r => ({ action: r.action, reason: '判定根拠', nextStep: '次に進む', fingerprint: r.lastLineHash }),
    execute: async () => { calls++; return { outcome: 'progressed', executor: 'claude', launched: true, resumedInSession: true, forkSessionId: 'fork-id' }; },
    addItem: async (h, item) => { asks.push(item); return { id: 'ask-1' }; }, publishHeartbeat: async value => { heartbeats.push(value); return {}; }, notify: async () => {},
  };
  const dry = await run(options(['--hourly', '--dry-run'], {}), io); assert.equal(calls, 0); assert.equal(asks.length, 0); assert.equal(dry.rows.length, 4);
  const result = await run(options(['--hourly'], {}), io); assert.equal(calls, 1); assert.equal(asks.length, 1); assert.equal(asks[0].dedupeKey, 'session-1');
  assert.equal(result.results[0].forkSessionId, 'fork-id');
  const beat = JSON.parse(heartbeatLine({ ...heartbeats.at(-1), label: '000', account: 'kim@orgiast.jp' }));
  assert.equal(beat.candidates, 4); assert.equal(beat.resume, 1); assert.equal(beat['waiting-human'], 1); assert.equal(beat.done, 1); assert.equal(beat.skip, 1);
  assert.equal(beat.candidates, beat.resume + beat['waiting-human'] + beat.done + beat.skip);
  await run(options(['--hourly'], {}), io); assert.equal(calls, 1, 'unchanged source is not forked again');
});

test('seat-guard停止でも安い判定とハートビートは続く', async t => {
  const home = homeFor(t); let judged = 0, beats = 0;
  const result = await run(options(['--hourly'], {}), { home, detect: async () => [{ sessionId: 'blocked', file: 'fake', cwd: home, lastAssistantText: '未完了' }],
    stat: async () => ({ mtimeMs: Date.now() - 86400000 }), hourlyResumePolicy: policy, fetchClaudePlanUsage: usage,
    evaluateGuard: async () => ({ blocked: true, reason: 'manual-pause' }),
    classifyHourly: async () => { judged++; return { action: 'resume', nextStep: '続行', reason: '未完了' }; },
    execute: () => assert.fail('no Claude'), publishHeartbeat: async () => { beats++; return {}; }, fleetRows: [], notify: async () => {},
  });
  assert.equal(judged, 1); assert.equal(beats, 1); assert.match(result.rows[0].skip, /seat-guard/);
});

test('kim-inbox競合時は短時間で既存spoolへaskを永続化して処理を続ける', async t => {
  const home = homeFor(t); let queued;
  const result = await run(options(['--hourly'], {}), { home, detect: async () => [{ sessionId: 'ask-busy', file: 'fake', cwd: home, lastAssistantText: '未完了' }],
    stat: async () => ({ mtimeMs: Date.now() - 86400000 }), hourlyResumePolicy: policy, fetchClaudePlanUsage: usage, evaluateGuard: guard,
    classifyHourly: async () => ({ action: 'waiting-human', nextStep: '送信承認', reason: '確認待ち' }),
    addItem: async (home, item, opts) => { assert.equal(opts.lockWaitMs, 1000); assert.equal(opts.drain, false); throw new Error('kim-inbox: 台帳が使用中です'); },
    spoolItem: (home, item) => { queued = item; return { delivered: 'spooled' }; },
    execute: () => assert.fail('no Claude'), publishHeartbeat: async () => ({}), fleetRows: [], notify: async () => {},
  });
  assert.equal(queued.forceKind, true); assert.equal(queued.dedupeKey, 'ask-busy'); assert.equal(result.rows[0].askDelivery, 'spooled');
});

test('起動前にfork家系を永続化し、transcriptなしでは引継ぎ済みにしない。中断後は実在するforkを回復する', async t => {
  const home = homeFor(t), forkFile = path.join(home, 'child.jsonl'); let calls = 0;
  const ledgerFile = path.join(home, '.claude', 'stalled-session-resume.json');
  const read = () => JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
  const io = { home, detect: async () => [{ sessionId: 'source', file: 'fake', cwd: home, lastAssistantText: '未完了', lastLineHash: 'hash' }],
    stat: async () => ({ mtimeMs: Date.now() - 86400000 }), hourlyResumePolicy: policy, fetchClaudePlanUsage: usage, evaluateGuard: guard,
    classifyHourly: async () => ({ action: 'resume', nextStep: '続行', reason: '未完了', fingerprint: 'hash' }),
    execute: async (record, options, childIO) => {
      calls++; await childIO.beforeForkLaunch({ forkSessionId: 'child', forkFile });
      const ledger = read(); assert.equal(ledger.forks.child, 'source'); assert.equal(ledger.hourlyFamilies.source.noProgress, calls);
      return { outcome: 'not-in-session', executor: 'claude', launched: true, resumedInSession: false, forkSessionId: 'child' };
    }, publishHeartbeat: async () => ({}), fleetRows: [], notify: async () => {},
  };
  await run(options(['--hourly'], {}), io);
  assert.equal(Object.values(read().overdue)[0].forkSessionId, undefined);
  await run(options(['--hourly'], {}), io); assert.equal(calls, 2, 'failed spawn must not retire source');
  fs.writeFileSync(forkFile, raw(assistant('中断前に生成されたfork')));
  const recovered = await run(options(['--hourly'], {}), io);
  assert.equal(calls, 2); assert.equal(recovered.rows[0].skip, 'fork先へ引継ぎ済み');
  assert.equal(read().forks.child, 'source');
});

test('forkの連鎖でも進捗なし3回で停止し日次上限の家系を維持する', async t => {
  const home = homeFor(t); let id = 'root', calls = 0, now = Date.now();
  const io = { home, now: () => now, detect: async () => [{ sessionId: id, file: 'fake', cwd: home, lastAssistantText: '未完了', lastLineHash: id }],
    stat: async () => ({ mtimeMs: now - 86400000 }), hourlyResumePolicy: policy, fetchClaudePlanUsage: usage, evaluateGuard: guard,
    classifyHourly: async r => ({ action: 'resume', nextStep: '続行', reason: '未完了', fingerprint: r.lastLineHash }),
    execute: async () => { calls++; return { outcome: 'no-progress', executor: 'claude', launched: true, resumedInSession: true, forkSessionId: `fork-${calls}` }; },
    publishHeartbeat: async () => ({}), fleetRows: [], notify: async () => {}, addItem: async () => ({ id: 'ask' }),
  };
  for (let n = 0; n < 4; n++) { await run(options(['--hourly'], {}), io); id = `fork-${calls}`; now += 3600001; }
  assert.equal(calls, 3);
  const ledger = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'stalled-session-resume.json'), 'utf8'));
  assert.equal(ledger.hourlyFamilies.root.noProgress, 3); assert.equal(ledger.forks['fork-3'], 'fork-2');
});

test('seat-guardだけの停止でも既存の他PC移管を通る', async t => {
  const home = homeFor(t); let handoffs = 0;
  const result = await run(options(['--hourly'], {}), { home, detect: async () => [{ sessionId: 'handoff', file: 'fake', cwd: home, lastAssistantText: '未完了' }],
    stat: async () => ({ mtimeMs: Date.now() - 86400000 }), hourlyResumePolicy: policy, fetchClaudePlanUsage: usage,
    evaluateGuard: async () => ({ blocked: true, reason: 'manual-pause' }),
    classifyHourly: async () => ({ action: 'resume', nextStep: '続行', reason: '未完了' }),
    handoffSession: () => { handoffs++; return { handedOff: true, target: '004' }; },
    execute: () => assert.fail('no local Claude'), publishHeartbeat: async () => ({}), fleetRows: [], notify: async () => {},
  });
  assert.equal(handoffs, 1); assert.equal(result.rows[0].skip, '移管済み');
});

test('ハートビート: orphan専用ブランチへpush、main非変更、000へ他PCコピー、500行保持', t => {
  const root = homeFor(t), repo = path.join(root, 'remote.git'), seed = path.join(root, 'seed');
  const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(root, ['init', '--bare', repo]); git(root, ['clone', repo, seed]); git(seed, ['checkout', '-b', 'main']);
  fs.writeFileSync(path.join(seed, 'main.txt'), 'untouched'); git(seed, ['add', '.']); git(seed, ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'initial']); git(seed, ['push', 'origin', 'main']);
  const mainSha = git(seed, ['rev-parse', 'HEAD']);
  git(repo, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  const other = path.join(root, 'other'), own = path.join(root, 'own'); fs.mkdirSync(other); fs.mkdirSync(own);
  const one = publishHourlyHeartbeat({ home: other, repo: seed, hostname: '004PC', account: 'test@example.com' }); assert.equal(one.pushed, true, one.line);
  const two = publishHourlyHeartbeat({ home: own, repo: seed, hostname: '000KimPC', account: 'kim@orgiast.jp' }); assert.equal(two.pushed, true, two.line);
  assert.ok(fs.existsSync(path.join(own, 'gb-reports', 'stalled-sessions-hourly', 'heartbeat', '004.log')));
  assert.equal(git(seed, ['ls-remote', 'origin', 'refs/heads/main']).split(/\s/)[0], mainSha);
  const clone = path.join(own, '.claude', 'fleet-heartbeat-repo'); assert.equal(git(clone, ['ls-tree', '--name-only', 'HEAD']), 'stalled-sessions');
  fs.appendFileSync(two.localFile, Array.from({ length: 550 }, (_, i) => JSON.stringify({ at: i })).join('\n') + '\n');
  const three = publishHourlyHeartbeat({ home: own, repo: seed, hostname: '000KimPC', account: 'kim@orgiast.jp' }); assert.equal(three.pushed, true);
  assert.equal(fs.readFileSync(path.join(clone, 'stalled-sessions', '000.log'), 'utf8').trim().split('\n').length, 500);
  let pushes = 0;
  const retried = publishHourlyHeartbeat({ home: own, repo: seed, hostname: '000KimPC', account: 'kim@orgiast.jp', exec: (cmd, args, opts) => {
    if (args[0] === 'push' && ++pushes < 3) throw Object.assign(new Error('rejected'), { stderr: 'non-fast-forward' });
    return execFileSync(cmd, args, opts);
  } });
  assert.equal(retried.pushed, true, retried.line); assert.equal(pushes, 3);
});

test('push失敗もローカル1行を残し致命傷にしない', t => {
  const home = homeFor(t);
  const result = publishHourlyHeartbeat({ home, repo: home, label: '019', account: 'test@example.com', exec: () => { throw new Error('offline'); } });
  assert.equal(result.pushed, false); const rows = fs.readFileSync(result.localFile, 'utf8').trim().split('\n'); assert.equal(rows.length, 1); assert.match(JSON.parse(rows[0]).error, /offline/);
});
