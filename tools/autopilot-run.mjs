#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadFablePolicy, fableAllowedForSupervisor } from './fable-policy.mjs';
import { resolveClaudeExecutableFromDisk, sanitizeClaudeSupervisorEnv } from './claude-exe.mjs';
import { autopilotPaths, runAutopilot, acquireLock } from './autopilot-tick.mjs';
import { isEntry } from './is-entry.mjs';
import { redactSecrets } from './webhook-health.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function buildPrompt(repo = REPO, { preFile, deadline } = {}) {
  const skill = fs.readFileSync(path.join(repo, 'skills', 'autopilot', 'SKILL.md'), 'utf8').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
  const preContext = preFile ? `手順1の pre は runner が実行済み。結果は ${preFile} にある。この JSON を読んで verdict 以降の手順に進む。pre を再実行しない（重く、二重実行になる）。\n` : '';
  const deadlineContext = deadline ? `この周は ${deadline}（UTC）に強制終了される。codex-do の --timeout は『期限までの残り秒数 − 480』以下にする（post と検証の時間を残す）。残りが 10 分を切ったら新しい委譲を始めず、ここまでの成果で post して終える。\n` : '';
  return `${skill}\n\n<実行コンテキスト>\nrepo: ${repo}\n/autopilot tick を1周だけ実行する。ヘッドレスモード。ScheduleWakeup と /loop は使用しない。Codex はフォアグラウンドで完了まで待ち、post と必要な handoff を書いて終了する。次の起床はタスクスケジューラが担う。pre が error なら実装せず終了する。\n${preContext}${deadlineContext}fleet-mail の受信メールに [判断依頼] を含む依頼へは返信も判断も行わない。kim の判断待ちとして放置すること（ヘッドレスでは未読注入からも除外される）。自分が送った判断依頼への回答（[回答・返信不要] 付き）は読んで作業に使ってよいが、返信はしない。\n</実行コンテキスト>\n`;
}
export async function sampleCpuBusy({ sampleMs = 5000, cpusImpl = os.cpus, sleep } = {}) {
  const sleepFn = sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const sumTimes = (cpus) => {
    let total = 0, idle = 0;
    for (const cpu of cpus || []) {
      const t = cpu?.times || {};
      for (const val of Object.values(t)) {
        total += Number(val) || 0;
      }
      idle += Number(t.idle) || 0;
    }
    return { total, idle };
  };
  const first = sumTimes(cpusImpl());
  await sleepFn(sampleMs);
  const second = sumTimes(cpusImpl());
  const dTotal = second.total - first.total;
  const dIdle = second.idle - first.idle;
  if (dTotal <= 0) return 0;
  const busy = (dTotal - dIdle) / dTotal;
  return Math.max(0, Math.min(1, busy));
}
// 監督モデルは既定で planIncluded に従う（true なら Fable）。PC ごとに変えたいときは
// objective.md の JSON に "model": "claude-opus-5-5" のように書く（2026-10-29 nishi:
// 「オートパイロットをオーパスに変えて」。共有リポジトリの既定を変えると他 PC まで変わるため）。
// claude- 以外や、planIncluded=false での Fable 指定は無視して既定に戻す。
export function supervisorModel(objectiveFile, policy) {
  const fallback = fableAllowedForSupervisor(policy) ? 'claude-fable-5-1' : 'claude-opus-5';
  let pinned = '';
  try { pinned = JSON.parse(fs.readFileSync(objectiveFile, 'utf8').match(/```json\s*\n([\s\S]*?)\n```/)[1]).model; } catch {}
  if (typeof pinned !== 'string' || !/^claude-[a-z0-9-]+$/.test(pinned)) return fallback;
  if (/fable/.test(pinned) && !fableAllowedForSupervisor(policy)) return fallback;
  return pinned;
}
export function buildWatchPrompt(watch, repo = REPO) {
  return `autopilot の「見張り」を1件だけ確かめる。実装・修正・外部への送信はしない（読む・数える・ログを見るだけ）。

見張り ID: ${watch.id}
目的: ${watch.objective}
まだ確かめられていないこと: ${watch.unverified}
これまでの証拠: ${watch.evidence || 'なし'}

1. 上の「まだ確かめられていないこと」が実際に起きたかを、ファイル・ログ・API などの実データで確かめる。推測で決めない。
2. 起きていれば ok、起きていなければ ng として、次の1コマンドを実行して終える:
   node "${repo}/tools/autopilot-tick.mjs" watch --id ${watch.id} --result ok|ng --note "<確かめたこと。システムを知らない高校生でもわかる短い日本語。コマンドやIDは書かない>"
ヘッドレスモード。ScheduleWakeup と /loop は使用しない。`;
}
// OAuth ログインが切れると、スケジューラ起動の autopilot は毎周
// "OAuth session expired and could not be refreshed" で exit 1 し、runner_error のまま paused で固まる
// (2026-10-17 実測: accessToken/refreshToken が長さ0、run.log が 04:32Z 以降 skipped だけ)。
// 同じ PC のデスクトップ側セッションは ~/.claude/openrouter.env の鍵で動いているので、
// 資格情報が空のときだけその鍵を子へ渡し、監督モデルもそのレーンのモデルへ切り替える。
// 鍵が無ければ従来どおり（何も変えずに OAuth 経路へ渡す）＝挙動を悪化させない。
export function resolveSupervisorAuth({ home = process.env.ORGIAST_HOME || os.homedir(), env = process.env, readFile = fs.readFileSync } = {}) {
  if (String(env.ANTHROPIC_AUTH_TOKEN || '').trim()) return { lane: 'env', model: null, env };
  let oauthToken = '';
  try { oauthToken = JSON.parse(readFile(path.join(home, '.claude', '.credentials.json'), 'utf8'))?.claudeAiOauth?.accessToken || ''; } catch {}
  if (String(oauthToken).trim()) return { lane: 'oauth', model: null, env };
  let key = '';
  try {
    for (const line of String(readFile(path.join(home, '.claude', 'openrouter.env'), 'utf8')).split(/\r?\n/)) {
      const match = line.match(/^\s*OPENROUTER_API_KEY\s*=\s*(.+?)\s*$/);
      if (match) { key = match[1].replace(/^["']|["']$/g, ''); break; }
    }
  } catch {}
  if (!key) return { lane: 'none', model: null, env };
  return { lane: 'deepseek', model: 'deepseek/deepseek-v4-flash', env: { ...env, ANTHROPIC_BASE_URL: 'https://openrouter.ai/api', ANTHROPIC_AUTH_TOKEN: key, ANTHROPIC_API_KEY: '', CLAUDE_CODE_MAX_CONTEXT_TOKENS: '1000000' } };
}
export function invokeClaude({ executable, args, prompt, cwd, timeoutMs, env = process.env, onProgress = () => {} }) {
  return new Promise((resolve) => {
    let stdout = '', stderr = '', timedOut = false, launchError = null, pending = '', lastStage = 'starting';
    const streaming = args.includes('stream-json');
    // 監督セッションなので全社 hook は効かせたまま、デスクトップ由来の env 漏れだけ外す。
    const child = spawn(executable, args, { cwd, env: { ...sanitizeClaudeSupervisorEnv(env), CLAUDE_HEADLESS: '1', ORGIAST_HEADLESS_JOB: 'autopilot' }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
    const killTree = () => {
      timedOut = true;
      if (!child.pid) return;
      try {
        if (process.platform === 'win32') execFileSync('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 10_000 });
        else process.kill(-child.pid, 'SIGKILL');
      } catch { child.kill('SIGKILL'); }
    };
    const timer = setTimeout(killTree, timeoutMs);
    child.stdout.on('data', (chunk) => {
      if (!streaming) { stdout = (stdout + chunk).slice(-16_000); return; }
      pending += chunk.toString();
      let newline;
      while ((newline = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
        try {
          const event = JSON.parse(line);
          // Do not persist tool inputs, credentials or thinking blocks.
          const tool = event.message?.content?.find?.(part => part.type === 'tool_use');
          const stage = tool ? `tool:${tool.name}` : event.type;
          if (stage && stage !== lastStage) { lastStage = stage; onProgress({ stage }); }
          if (event.type === 'result') stdout = redactSecrets(String(event.result || '')).slice(-16_000);
        } catch { /* Ignore non-protocol output; stderr remains available. */ }
      }
      if (pending.length > 1_000_000) pending = '';
    });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4_000); });
    child.on('error', (error) => { launchError = error.code || error.message; });
    child.stdin.on('error', () => {});
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ exitCode: code ?? 1, signal, stdout, stderr: redactSecrets(stderr), timedOut, launchError, ...(streaming ? { lastStage } : {}) }); });
    child.stdin.end(prompt);
  });
}
export async function runOnce(options = {}) {
  const paths = autopilotPaths(options);
  fs.mkdirSync(paths.dir, { recursive: true });
  const auth = resolveSupervisorAuth({ home: paths.home });
  const release = acquireLock(path.join(paths.dir, 'run.lock'));
  if (!release) return { skipped: 'already_running' };
  const record = (entry) => fs.appendFileSync(path.join(paths.dir, 'run.log'), `${JSON.stringify({ ts: (options.now || new Date()).toISOString(), ...entry })}\n`, 'utf8');
  const safeDigest = async () => {
    try {
      const digest = await runAutopilot('digest', {}, options);
      // 「送信エラーが無い」ではなく「実際に届いたか」を残す。sendNotice は
      // 送信失敗を握り潰すので、以前の run.log では未達を検出できなかった。
      if (digest && !digest.skipped && digest.slot) record({ digest: digest.slot, delivered: digest.delivered });
    } catch (e) { record({ digestError: e.code || e.message }); }
  };
  try {
    const pre = await runAutopilot('pre', {}, options);
    if (pre.verdict !== 'run' || pre.error) {
      if (pre.verdict && pre.reason !== 'not_started') await runAutopilot('handoff', {}, options);
      const watch = !pre.error && pre.watchesDue?.[0];
      if (watch) {
        // 完了・停止中でも見張りは確かめる。そうしないと「完了」のまま誰も結果を見ない。
        const policy = options.policy || loadFablePolicy();
        const model = auth.model || supervisorModel(paths.objective, policy);
        const repo = options.repo || REPO;
        const executable = options.executable || (await resolveClaudeExecutableFromDisk()).executable;
        const checked = await (options.invokeImpl || invokeClaude)({ executable, args: ['-p', '--model', model, '--output-format', 'stream-json', '--verbose'], prompt: buildWatchPrompt(watch, repo), cwd: repo,
          timeoutMs: options.timeoutMs ?? 15 * 60_000, onProgress: progress => record({ watch: watch.id, progress }), env: { ...auth.env, AUTOPILOT_HOME: paths.dir, ORGIAST_HOME: paths.home } });
        const result = { skipped: pre.reason || pre.verdict, watchChecked: watch.id, model, authLane: auth.lane, exitCode: checked.exitCode, timedOut: checked.timedOut, stdout: String(checked.stdout || '').slice(-2000) };
        record(result);
        await safeDigest();
        return result;
      }
      const result = { skipped: pre.reason || pre.error || pre.verdict };
      record(result);
      if (pre.verdict && pre.reason !== 'not_started') {
        await safeDigest();
      }
      return result;
    }
    const preFile = path.join(paths.dir, 'pre-latest.json');
    fs.writeFileSync(preFile, JSON.stringify(pre, null, 2), 'utf8');
    const env = options.env || process.env;
    if (env.AUTOPILOT_SKIP_BUSY_CHECK !== '1') {
      const rawBusy = await (options.cpuBusyImpl || sampleCpuBusy)({
        ...(options.sampleMs !== undefined ? { sampleMs: options.sampleMs } : {}),
        ...(options.cpusImpl ? { cpusImpl: options.cpusImpl } : {}),
        ...(options.sleep ? { sleep: options.sleep } : {}),
      });
      const cpuBusy = Number(Number(rawBusy).toFixed(2));
      if (rawBusy >= (options.busyThreshold ?? 0.95)) {
        record({ skipped: 'host_busy', cpuBusy });
        await safeDigest();
        return { skipped: 'host_busy', cpuBusy };
      }
    }
    const before = await runAutopilot('status', {}, options);
    const policy = options.policy || loadFablePolicy();
    const model = auth.model || supervisorModel(paths.objective, policy);
    const repo = options.repo || REPO;
    const executable = options.executable || (await resolveClaudeExecutableFromDisk()).executable;
    const timeoutMs = options.timeoutMs ?? 40 * 60_000;
    const rawNow = typeof options.now === 'function' ? options.now() : options.now;
    const startMs = rawNow ? new Date(rawNow).getTime() : Date.now();
    const deadline = new Date(startMs + timeoutMs).toISOString();
    const result = await (options.invokeImpl || invokeClaude)({ executable, args: ['-p', '--model', model, '--output-format', 'stream-json', '--verbose'], prompt: buildPrompt(repo, { preFile, deadline }) + (pre.jevDecision?.action === 'RETRY' ? '\n前回の Jev 判断: RETRY。直前の作業を検証し、必要な修正をやり直す。\n' : ''), cwd: repo, timeoutMs, onProgress: progress => record({ progress }),
      env: { ...auth.env, AUTOPILOT_HOME: paths.dir, ORGIAST_HOME: paths.home } });
    record({ model, authLane: auth.lane, ...result, stdout: String(result.stdout || '').slice(-4000) });
    const after = await runAutopilot('status', {}, options);
    const postRecorded = after.state?.totalIterations > before.state?.totalIterations;
    // Failed/empty Claude turns still consume an iteration and trip the watchdog.
    if (after.state?.status === 'running' && !postRecorded) {
      await runAutopilot('post', { summary: `ヘッドレス周回で post 未記録 (exit=${result.exitCode}${result.timedOut ? `, timeout, lastStage=${result.lastStage || 'unknown'}` : ''})`, progress: pre.recentLog.at(-1)?.progress ?? 0, noop: true, 'next-delay': 1800 }, options);
    }
    if (result.launchError || result.timedOut || result.exitCode !== 0) {
      const failed = await runAutopilot('status', {}, options);
      if (failed.state?.status === 'running') {
        let detail = `終了コード ${result.exitCode}`;
        if (result.timedOut) detail = 'タイムアウト';
        else if (result.launchError) detail = '起動失敗';
        await runAutopilot('pause', { reason: 'runner_error', detail }, options);
      }
    } else if (postRecorded) {
      await runAutopilot('clear-runner-error', {}, options);
    }
    const final = await runAutopilot('status', {}, options);
    if (final.state?.status !== 'running') await runAutopilot('handoff', {}, options);
    await safeDigest();
    return { ...result, model, status: final.state?.status };
  } catch (error) {
    record({ error: error.code || error.message });
    await runAutopilot('pause', { reason: 'runner_error', detail: '起動失敗' }, options);
    await runAutopilot('handoff', {}, options);
    await safeDigest();
    return { error: error.code || error.message };
  } finally { release(); }
}
if (isEntry(import.meta.url)) {
  const result = await runOnce();
  console.log(JSON.stringify(result));
  process.exitCode = result.error || result.exitCode ? 1 : 0;
}
