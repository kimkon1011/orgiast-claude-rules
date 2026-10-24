#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import { enqueueTodos } from './handoff-audit-nightly.mjs';
import { writeHandoff } from './next-session-rotate.mjs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isEntry } from './is-entry.mjs';
import { parseHandoff, selectTodoLanes } from './auto-session.mjs';
import { buildClaudeHeadlessArgs, parseAutoSessionEnvText } from './auto-session-executor.mjs';
import { resolveClaudeExecutableFromDisk, sanitizeClaudeSupervisorEnv } from './claude-exe.mjs';
import { notifyKim } from './notify-kim.mjs';
import { decideSweep, readClaudeWindows, readCodexWindows, shouldStopTick, jsonlFiles, sameReset } from './lib/quota-windows.mjs';
import { discoverWsl, passiveWslHomes, wslPath, interactiveCodex, nativeCommand } from './lib/quota-sweep-host.mjs';
import { syncWslCodexAuth } from './lib/codex-wsl-auth-sync.mjs';
import { runBounded } from './lib/quota-sweep-process.mjs';

export const DEFAULT_GOAL = 'このリポで node --test tools/ を実行し、失敗しているテスト・壊れた import・node --check で落ちるファイルを直す。全部緑なら docs/ 内のリンク切れ（相対パスの実在）を直す。受け入れ基準: node --test tools/ が緑、変更は git commit -F msg -- <paths> で小さくコミット';
export const MAX_TICKS = 8;
const terminal = new Set(['exhausted', 'final', 'ceiling', 'deadline', 'no-goal']);
const read = file => { try { return fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return ''; throw e; } };
const json = (file, fallback = {}) => { const text = read(file); return text ? JSON.parse(text) : fallback; };
const atomic = (file, value) => { const tmp = `${file}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n'); fs.renameSync(tmp, file); };

export function selectGoal({ goals = '', handoff = '' } = {}) {
  const actionable = value => value && !/^(?:なし|無し|none|完了|済|done)(?:\s*[（(][^）)]*[）)])?\s*[。.]?$/i.test(value.trim()) && !/^\s*(?:\[x\]|~~)/i.test(value);
  const explicit = [...goals.matchAll(/^\s*- \[ \]\s+(.+)$/gm)].map(m => m[1].trim()).find(actionable);
  if (explicit) return { goal: explicit, goalSource: 'quota-sweep-goals.md' };
  const todos = parseHandoff(handoff).todos.filter(actionable);
  const first = selectTodoLanes(todos, { count: 1, slaCount: 0 }).selected[0];
  return { goal: first || null, goalSource: 'next-session.md' };
}

export function tickPrompt(slug) {
  return `[headless:quota-sweep]\nFollow .loop/${slug}.md for exactly one iteration; update .loop/${slug}-state.md; commit with \`git commit -F <msg> -- <paths>\`; report FINAL only when every criterion is proved, otherwise ITERATING.\n日本語で証跡と残件を記録。FINAL は独立した行で返す。別ループやバックグラウンド子プロセスは禁止。push/PR/merge は行わない。.loop/ はローカル状態なのでコミット対象から除外する。`;
}
export function contractPrompt(provider, slug, goal) {
  return `[headless:quota-sweep]\n${provider === 'claude' ? '/makeloop' : '$makeloop:makeloop'} ${goal}\n質問せず保守的な前提を明記して進める。runtime=manual（1メッセージ1イテレーション）、kind=closed、累積上限 ${MAX_TICKS} イテレーション、検証ゲート node --test tools/、slug=${slug}、ループを開始しない、日本語。.loop/${slug}.md と状態・INDEX を保存する。`;
}
export function canRunWindow(state, decision) {
  const prior = state.lastRun?.[decision.provider]?.[decision.resetsAt];
  return !prior || (!terminal.has(prior.stopOutcome || prior.outcome) && (prior.attempts || 1) < 2);
}
export function interactiveClaude({ home, now = Date.now() }) {
  return jsonlFiles(path.join(home, '.claude', 'projects')).some(file => {
    try {
      if (now - fs.statSync(file).mtimeMs > 10 * 60_000) return false;
      for (const line of read(file).split(/\r?\n/)) {
        let row; try { row = JSON.parse(line); } catch { continue; }
        if (row.type !== 'user' || row.isMeta) continue;
        const c = row.message?.content;
        const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter(b => b.type === 'text').map(b => b.text).join('\n') : '';
        if (!text) continue;
        return !text.startsWith('[headless:');
      }
      return true; // A recent unreadable/incomplete transcript is not evidence of idle use.
    } catch { return true; }
  });
}
export function makeLedger({ decision, startedAt, endedAt, usedAfter = null, ticks = 0, outcome, goal, goalSource, branch = null, prUrl = null, reason = null, failureKey = null, stopOutcome = outcome, deliveryError = null }) {
  return { ts: new Date(endedAt).toISOString(), provider: decision.provider, window: decision.window, resetsAt: decision.resetsAt,
    usedBefore: decision.usedPercent, usedAfter, ticks, outcome, goal, goalSource, branch, prUrl, reason, failureKey, stopOutcome, deliveryError, durationSec: Math.max(0, (endedAt - startedAt) / 1000) };
}
export function parseOutput(stdout) {
  let message = '', input = 0, output = 0;
  try {
    const row = JSON.parse(stdout);
    if (typeof row.result === 'string') {
      message = row.result; input += row.usage?.input_tokens || 0; output += row.usage?.output_tokens || 0;
    }
  } catch { /* Codex JSONL */ }
  for (const line of stdout.split(/\r?\n/)) {
    try {
      const row = JSON.parse(line);
      if (row.type === 'item.completed' && row.item?.type === 'agent_message') message = row.item.text;
      if (row.type === 'turn.completed') { input += row.usage?.input_tokens || 0; output += row.usage?.output_tokens || 0; }
    } catch { /* Only final structured messages are completion signals. */ }
  }
  return { final: /^FINAL\s*$/m.test(message), input, output, message };
}

export function acquireLock(file, { alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; } } } = {}) {
  const token = { pid: process.pid, startedAt: new Date().toISOString() };
  const create = () => fs.writeFileSync(file, JSON.stringify(token), { flag: 'wx' });
  try { create(); } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    let old; try { old = json(file); } catch { return null; }
    if (!Number.isInteger(old.pid) || old.pid <= 0 || alive(old.pid)) return null;
    // Serialize stale reclamation; never steal an unknown owner.
    const claim = `${file}.reclaim`;
    try { fs.writeFileSync(claim, '', { flag: 'wx' }); } catch { return null; }
    try {
      if (read(file) !== JSON.stringify(old)) return null;
      fs.unlinkSync(file); create();
    } finally { fs.unlinkSync(claim); }
  }
  return () => { try { if (read(file) === JSON.stringify(token)) fs.unlinkSync(file); } catch {} };
}

export function parseArgs(argv) {
  const o = { provider: 'all', leadMinutes: 90, minRemainingPercent: 15, home: process.env.ORGIAST_HOME || os.homedir() };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (['--dry-run', '--json', '--status'].includes(arg)) o[arg.slice(2)] = true;
    else if (['--provider', '--lead-min', '--min-remaining', '--home'].includes(arg)) {
      const value = argv[++i]; if (!value || value.startsWith('--')) throw new Error(`Missing ${arg}`);
      if (arg === '--provider') o.provider = value;
      if (arg === '--home') o.home = path.resolve(value);
      if (arg === '--lead-min') o.leadMinutes = Number(value);
      if (arg === '--min-remaining') o.minRemainingPercent = Number(value);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!['claude', 'codex', 'all'].includes(o.provider) || !Number.isFinite(o.leadMinutes) || o.leadMinutes <= 0 || !Number.isFinite(o.minRemainingPercent) || o.minRemainingPercent < 0 || o.minRemainingPercent > 100) throw new Error('Invalid sweep options');
  return o;
}

// .filter() は新しい配列を返すので、windows() が配列に付けたプロバイダ別の読み取り理由
// （all.reasons）が落ちる。利用窓が 0 件だったときに「なぜ 0 件か」を台帳へ残すため引き継ぐ。
export function filterWindowsForCurrentAuth(all, state) {
  const filtered = all.filter(w => w.provider !== 'codex' || !state.codexAuthChangedAt || w.observedAt > state.codexAuthChangedAt);
  if (all?.reasons) filtered.reasons = all.reasons;
  return filtered;
}

// oauth/usage の一時障害だけを再試行対象にする。429(レート制限)・408・5xx・ネットワーク断は
// 数十秒で回復しうるが、401/403（トークン失効）や形式不一致は読み直しても直らない。
// 2026-10-23T07:10Z/07:25Z の window-info 失敗は、直前に読めていた窓が1回の読み取り失敗で
// ticks=0 failed になり、delegation-health にレーン全滅と誤判定された。
export function isTransientWindowReadError(reason) {
  return /^(?:network:|HTTP (?:408|429|5\d{2})\b)/i.test(String(reason ?? '').trim());
}

const defaultSleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function commandRunner(spawnImpl = spawnSync, log = () => {}) {
  return (exe, args, cwd) => {
    const network = exe === 'git' && ['fetch', 'push'].includes(args[0]);
    const timeout = exe === 'git' ? (network ? 300_000 : 120_000) : 60_000;
    for (let attempt = 0; ; attempt++) {
      const r = spawnImpl(exe, args, { cwd, encoding: 'utf8', windowsHide: true, timeout, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
      if (!r.error && r.status === 0) return String(r.stdout || '').trim();
      const error = new Error(`${exe} ${args[0]}: ${r.error?.message || String(r.stderr || '').slice(-1000)} (exit ${r.status}, timeout ${timeout}ms)`);
      error.failureKey = `${exe}-${args[0]}-${r.error?.code || r.status}`;
      if (!network || attempt === 1) throw error;
      log(`${error.message}; retry 1/1`);
    }
  };
}

const pointerFile = tree => path.join(tree, '.git');
const accessDenied = error => error && (error.code === 'EPERM' || error.code === 'EACCES');

// 2026-10-21 実測: worktree の `.git` がウイルス対策/索引サービスに掴まれると fs の open が
// EPERM になり、prepareTree が毎回ここで落ちて quota-sweep:codex が12時間ぶん6連続 failed
// (ticks=0) になった。EPERM は読み取り属性や一時ロックで起きるので、chmod で解除して再試行する。
export function readWorktreePointer(file, { readFile = fs.readFileSync, chmod = fs.chmodSync, attempts = 3 } = {}) {
  for (let attempt = 1; ; attempt++) {
    try { return String(readFile(file)).match(/^gitdir: (.+)\s*$/)?.[1] ?? null; }
    catch (error) {
      if (!accessDenied(error) || attempt >= attempts) throw error;
      try { chmod(file, 0o666); } catch { /* best effort */ }
    }
  }
}

export function writeWorktreePointer(file, value, { writeFile = fs.writeFileSync, chmod = fs.chmodSync, attempts = 3, rename = fs.renameSync, remove = fs.rmSync } = {}) {
  for (let attempt = 1; ; attempt++) {
    try { writeFile(file, value); return; }
    catch (error) {
      if (!accessDenied(error)) throw error;
      if (attempt >= attempts) {
        const tmp = `${file}.${process.pid}.tmp`;
        try { writeFile(tmp, value, { flag: 'wx' }); rename(tmp, file); return; }
        finally { remove(tmp, { force: true }); }
      }
      try { chmod(file, 0o666); } catch { /* best effort */ }
    }
  }
}

export function preserveDirtyTree({ tree, run, log = () => {}, now = Date.now }) {
  const stamp = new Date(now()).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  let branch = run('git', ['branch', '--show-current'], tree);
  if (!branch) {
    branch = `quota-sweep/rescue-${stamp}`;
    run('git', ['switch', '-c', branch], tree);
  }
  run('git', ['add', '-A', '--', '.', ':!.loop'], tree);
  run('git', ['-c', 'user.name=quota-sweep', '-c', 'user.email=quota-sweep@localhost', 'commit', '--no-verify', '-m', `chore(quota-sweep): preserve uncommitted work ${stamp}`], tree);
  let pushed = true, warning = null;
  try { run('git', ['push', '-u', 'origin', branch], tree); }
  catch (error) {
    pushed = false;
    warning = `preserved locally but push failed: ${error.message}`;
    log(`quota-sweep: ${warning}`);
  }
  return { branch, pushed, warning };
}

export function prepareTree({ home, provider, run, previous, needRelativePointer = false, io = {}, log = () => {} }) {
  const shared = path.join(home, '.claude', 'nightly-repo'), tree = path.join(home, '.claude', 'quota-sweep-repo');
  run('git', ['fetch', 'origin', 'main', '--quiet'], shared);
  if (!fs.existsSync(tree)) run('git', ['worktree', 'add', '--detach', tree, 'origin/main'], shared);
  // Relative worktree pointer is usable by both Windows git and WSL git.
  const pointer = readWorktreePointer(pointerFile(tree), io);
  if (!pointer) throw new Error('Dedicated worktree has no gitdir pointer');
  let pointerWarning = null;
  if (path.isAbsolute(pointer)) {
    const relative = `gitdir: ${path.relative(tree, pointer).replaceAll('\\', '/')}\n`;
    try { writeWorktreePointer(pointerFile(tree), relative, io); }
    catch (error) {
      // 相対化は WSL の git が読むときだけ必須。Windows ネイティブの git は絶対パスでも解決できるので、
      // EPERM で書けない場合はレーンを落とさず続行する（2026-10-21 の全滅はこの書き込みだった）。
      if (!accessDenied(error) || needRelativePointer) throw error;
      pointerWarning = `worktree pointer stays absolute (${error.code}); native git resolves it`;
      log(`quota-sweep: ${pointerWarning}`);
    }
  }
  if (previous?.branch && previous.outcome !== 'final') {
    if (run('git', ['branch', '--show-current'], tree) !== previous.branch) throw new Error('Interrupted branch changed; preserve worktree for recovery');
    return { tree, branch: previous.branch, base: previous.base, ...(pointerWarning ? { pointerWarning } : {}) };
  }
  let dirty = run('git', ['status', '--porcelain', '--', '.', ':!.loop'], tree);
  if (dirty) {
    const preserved = preserveDirtyTree({ tree, run, log });
    dirty = run('git', ['status', '--porcelain', '--', '.', ':!.loop'], tree);
    if (dirty) throw new Error('Uncommitted prior work preserved in quota-sweep-repo; reconcile before starting a new branch');
    log(`quota-sweep: preserved uncommitted work on ${preserved.branch}${preserved.pushed ? '' : ' (local only)'}`);
  }
  run('git', ['checkout', '--detach', 'origin/main'], tree);
  const branch = `quota-sweep/${new Date().toISOString().replace(/[-:]/g, '').slice(0, 13).replace('T', '-')}-${provider}-${Date.now().toString(36)}`;
  run('git', ['switch', '-c', branch], tree);
  return { tree, branch, base: run('git', ['rev-parse', 'HEAD'], tree), ...(pointerWarning ? { pointerWarning } : {}) };
}

export function queueRepeatedFailure(home, state, row) {
  state.failureStreaks ??= {};
  const prior = state.failureStreaks[row.provider];
  const count = row.failureKey ? (prior?.key === row.failureKey ? prior.count + 1 : 1) : 0;
  state.failureStreaks[row.provider] = { key: row.failureKey, count };
  if (count < 2) return;
  const file = path.join(home, '.claude', 'next-session.md');
  const before = read(file);
  const after = enqueueTodos(before, [{ pattern: `quota-sweep ${row.provider}: ${row.failureKey} の連続失敗`,
    route: `tools/quota-sweep.mjs の ${row.failureKey} を quota-sweep.jsonl とログで調査し、回帰テスト付きで修正してPRを作成する` }]);
  if (after !== before) writeHandoff(file, after);
}

// deferred は失敗ではない（failureStreaks を汚さず detector にレーン全滅と誤判定させない）が、
// これが続くと窓が読めないままレーンが一度も走らない状態が静かに続く。delegation-health は
// quota-sweep の status が failed 以外を失敗として扱わないため、jsonl を人が見るまで気付けない。
// 失敗検知とは別のカウンタで数え、閾値で次回セッションのTODOに渡す。
export function queueRepeatedDeferral(home, state, row) {
  state.deferredStreaks ??= {};
  const count = row.stopOutcome === 'deferred' ? (state.deferredStreaks[row.provider]?.count || 0) + 1 : 0;
  state.deferredStreaks[row.provider] = { count };
  if (count < 3) return;
  const file = path.join(home, '.claude', 'next-session.md');
  const before = read(file);
  const after = enqueueTodos(before, [{ pattern: `quota-sweep ${row.provider}: deferred が ${count} 回連続`,
    route: `quota-sweep.jsonl の deferred 行（${row.reason || '理由なし'}）を確認し、利用窓が読めない原因を特定して回帰テスト付きで修正しPRを作成する` }]);
  if (after !== before) writeHandoff(file, after);
}

export async function runSweep(decision, context) {
  const { home, state, save, windows: refresh, active, log, env, now = Date.now, spawnImpl = spawnSync, runChild = runBounded, notify = notifyKim } = context;
  const run = context.command ?? commandRunner(spawnImpl, log), provider = decision.provider;
  const startedAt = now(), slug = `quota-sweep-${provider}`;
  const selection = selectGoal({ goals: read(path.join(home, '.claude', 'quota-sweep-goals.md')), handoff: read(path.join(home, '.claude', 'next-session.md')) });
  state.lastRun ??= {}; state.lastRun[provider] ??= {};
  const previous = state.lastRun[provider][decision.resetsAt];
  const record = { ...previous, ...selection, attempts: (previous?.attempts || 0) + 1, outcome: 'running', deliveryError: null, startedAt, ticks: previous?.ticks || 0 };
  state.lastRun[provider][decision.resetsAt] = record; save();
  let reason = null, failureKey = null;
  const stopWith = (outcome, key, detail) => { reason = detail; failureKey = outcome === 'failed' ? key : null; log(`${provider}: ${key}: ${detail}`); return outcome; };
  let outcome = 'failed', usedBefore = decision.usedPercent, usedAfter = null, inputTokens = 0, outputTokens = 0, tree, branch = record.branch, prUrl = record.prUrl;
  log(`${provider} goal (${selection.goalSource}): ${selection.goal}`);
  const checkConditions = async () => {
    if (now() >= decision.deadline) return stopWith('deadline', 'deadline', '利用窓の終了時刻に到達');
    if (tree && run('git', ['branch', '--show-current'], tree) !== branch) {
      record.branchChanged = true; log('Worktree branch changed externally; stop and preserve it'); return stopWith('failed', 'branch-changed', '作業ブランチが外部で変更された');
    }
    let all = await refresh(), own = all.filter(w => w.provider === provider), why = all?.reasons?.[provider];
    // 一時的な読み取り失敗は間隔を空けて読み直す。2秒1回だけだと 429 が続く間に ticks 消化後の
    // 確認で failed になり、2026-10-24T03:54Z に再発した。それでも読めなければ failed ではなく
    // deferred（非終端・次回再試行）で止め、detector に「レーン全滅」と誤判定させない。
    const delays = context.windowReadRetryDelaysMs ?? [2000, 15_000, 30_000];
    for (let i = 0; !own.length && isTransientWindowReadError(why) && i < delays.length; i++) {
      log(`${provider}: window read failed (${why}); retry ${i + 1}/${delays.length}`);
      await (context.sleep ?? defaultSleep)(delays[i]);
      all = await refresh(); own = all.filter(w => w.provider === provider); why = all?.reasons?.[provider];
    }
    if (!own.length && isTransientWindowReadError(why)) return stopWith('deferred', 'window-unreadable', `利用窓を読めない一時障害のため次回へ延期: ${why}`);
    usedAfter = own.find(w => w.window === decision.window)?.usedPercent ?? null;
    if ((provider === 'claude' && !['5h', '7d'].every(k => own.some(w => w.window === k))) || !own.length || own.some(w => !Number.isFinite(w.resetsAt) && w.usedPercent !== 0 && !w.exhausted)) return stopWith('failed', 'window-info', `利用窓情報が不足または不正: ${JSON.stringify(own)}${why ? ` (${why})` : ''}`);
    if (own.some(w => w.exhausted)) return stopWith('exhausted', 'quota-exhausted', '利用枠を使い切った');
    if (shouldStopTick({ windows: all, provider })) return stopWith('ceiling', 'usage-ceiling', '利用率が停止上限に達した');
    if (own.some(w => Number.isFinite(w.resetsAt) && w.resetsAt - 3 * 60_000 <= now()) || !own.some(w => sameReset(w.resetsAt, decision.resetsAt))) return stopWith('deadline', 'reset-window', 'リセット直前または利用窓が切り替わった');
    if (await active(provider)) return stopWith('failed', 'interactive-active', '対話セッションの使用を検出');
    return null;
  };
  const check = async () => {
    try { return await checkConditions(); }
    catch (error) { return stopWith('failed', error.failureKey || error.code || 'monitor-error', error.message); }
  };
  try {
    if (!selection.goal) { outcome = 'no-goal'; reason = '実行対象の未完了目標なし'; return; }
    let stop = await check();
    if (!stop) {
      const initial = await refresh();
      const eligible = decideSweep({ windows: initial, now: now(), leadMinutes: context.leadMinutes ?? 90, minRemainingPercent: context.minRemainingPercent ?? 15 }).find(d => d.provider === provider && sameReset(d.resetsAt, decision.resetsAt));
      if (!eligible) stop = stopWith('exhausted', 'no-eligible-window', '再取得した利用窓が残枠・開始時刻の条件を満たさない'); else usedBefore = eligible.usedPercent;
    }
    if (stop) { outcome = stop; return; }
    const prepared = (context.prepareTree ?? prepareTree)({ home, provider, run, previous, needRelativePointer: provider === 'codex' && Boolean(context.wsl), log, io: context.treeIo });
    ({ tree, branch } = prepared); Object.assign(record, prepared); save();
    const model = env.ORGIAST_QUOTA_SWEEP_MODEL || 'sonnet';
    if (/opus|fable/i.test(model)) throw new Error('Supervisor model is not permitted for quota sweep');
    let executable, baseArgs, wsl;
    if (provider === 'claude') {
      executable = context.claudeExe ?? (await resolveClaudeExecutableFromDisk({ ...process, env: { ...process.env, HOME: home, USERPROFILE: home, ORGIAST_HOME: home } })).executable;
      if (!executable) throw new Error('Claude executable unavailable');
      baseArgs = buildClaudeHeadlessArgs({ repoCwd: tree, historyCwd: tree, model });
    } else {
      wsl = context.wsl ?? discoverWsl({ spawnImpl });

      executable = wsl ? 'wsl' : 'codex';
      baseArgs = ['exec', '-s', 'workspace-write', '-c', 'model_provider=openai', '-c', 'forced_login_method=chatgpt', '--json', '-C', wsl ? wslPath(tree) : tree, '-'];
    }
    const childEnv = { ...sanitizeClaudeSupervisorEnv(env), ORGIAST_HOME: home, CLAUDE_HEADLESS: '1', ORGIAST_HEADLESS_JOB: `quota-sweep:${provider}` };
    // No API-key billing fallback. Both hosts must use their existing plan authentication.
    for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'CODEX_API_KEY']) delete childEnv[k];
    const launch = async (prompt, timeoutMs) => {
      reason = null; failureKey = null;
      const stopAt = Math.min(decision.deadline, now() + timeoutMs);
      if (stopAt <= now()) return { timedOut: true, code: null, stdout: '' };
      const seconds = Math.floor((stopAt - now()) / 1000);
      if (seconds <= 0) return { timedOut: true, code: null, stdout: '' };
      const args = wsl ? ['-d', wsl.distro, '--cd', wslPath(tree), '--', 'timeout', '--signal=KILL', `${seconds}s`, 'env', '-u', 'OPENAI_API_KEY', '-u', 'CODEX_API_KEY', 'codex', ...baseArgs] : baseArgs;
      const invocation = provider === 'codex' && !wsl && process.platform === 'win32'
        ? nativeCommand(executable, args) : { executable, args };
      const result = await runChild(invocation.executable, invocation.args, { cwd: tree, input: prompt, env: childEnv, deadline: stopAt, timeoutMs, monitor: check });
      const parsed = parseOutput(result.stdout || ''); inputTokens += parsed.input; outputTokens += parsed.output;
      if (result.code !== 0 || result.timedOut || result.stopReason) {
        reason = reason || `${provider} child exit=${result.code} stop=${result.stopReason || (result.timedOut ? 'timeout' : 'exit')}: ${String(result.stderr || parsed.message || '詳細出力なし').slice(-1000)}`;
        failureKey ||= `child-${result.stopReason || (result.timedOut ? 'timeout' : result.code)}`;
      }
      log(`${provider} child exit=${result.code} stop=${result.stopReason || ''}${reason ? ` reason=${reason}` : ''}`);
      return { ...result, final: parsed.final };
    };
    const loopDir = path.join(tree, '.loop'); fs.mkdirSync(loopDir, { recursive: true });
    const contract = path.join(loopDir, `${slug}.md`), budgetFile = path.join(loopDir, `${slug}-budget.json`);
    let budget = json(budgetFile, { goal: selection.goal, ticks: 0 });
    if (budget.goal !== selection.goal || (budget.resetsAt && budget.resetsAt !== decision.resetsAt)) {
      const archive = path.join(loopDir, `archive-${slug}-${now()}`); fs.mkdirSync(archive);
      for (const name of [...(budget.goal !== selection.goal ? [`${slug}.md`] : []), `${slug}-state.md`, `${slug}-budget.json`]) if (fs.existsSync(path.join(loopDir, name))) fs.renameSync(path.join(loopDir, name), path.join(archive, name));
      budget = { goal: selection.goal, ticks: 0 };
    }
    budget.ticks = Math.max(budget.ticks, record.ticks); record.ticks = budget.ticks; save();
    budget.resetsAt = decision.resetsAt; atomic(budgetFile, budget);
    if (budget.ticks >= MAX_TICKS || budget.final) { outcome = 'no-goal'; return; }
    if (!fs.existsSync(contract)) {
      stop = await check(); if (stop) { outcome = stop; return; }
      const generated = await launch(contractPrompt(provider, slug, selection.goal), 15 * 60_000);
      if ((generated.stopReason && generated.stopReason !== 'deadline') || now() >= decision.deadline) { outcome = generated.stopReason || 'deadline'; return; }
      if (!fs.existsSync(contract)) {
        const template = read(new URL('./quota-sweep-contract.tmpl.md', import.meta.url));
        const values = { GOAL: selection.goal, SLUG: slug, GATE: 'node --test tools/', MAX_ITERATIONS: String(MAX_TICKS), DATE: new Date(now()).toISOString() };
        fs.writeFileSync(contract, template.replace(/{{(GOAL|SLUG|GATE|MAX_ITERATIONS|DATE)}}/g, (_, k) => values[k]));
        log(`${provider}: built-in contract fallback`);
      }
    }
    const stateFile = path.join(loopDir, `${slug}-state.md`);
    if (!fs.existsSync(stateFile)) fs.writeFileSync(stateFile, `# ${slug}\n未検証 / 累積試行: 0\n次: VERIFY\n`);
    const index = path.join(loopDir, 'INDEX.md');
    if (!read(index).includes(`(${slug}.md)`)) fs.appendFileSync(index, `- [${slug}](${slug}.md) — closed / manual\n`);
    let errors = 0;
    while (budget.ticks < MAX_TICKS) {
      stop = await check(); if (stop) { outcome = stop; break; }
      // Reserve before spawn, so interrupted attempts cannot be replayed for free.
      budget.ticks++; atomic(budgetFile, budget); record.ticks++; save();
      const result = await launch(tickPrompt(slug), 45 * 60_000);
      if (result.stopReason || result.timedOut || now() >= decision.deadline) {
        outcome = result.stopReason === 'deadline' ? (now() >= decision.deadline ? 'deadline' : 'failed') : result.stopReason || (now() >= decision.deadline ? 'deadline' : 'failed'); break;
      }
      if (result.code === 0 && result.final) { budget.final = true; atomic(budgetFile, budget); outcome = 'final'; reason = null; failureKey = null; break; }
      errors = result.code === 0 ? 0 : errors + 1;
      if (errors >= 2) { outcome = 'failed'; break; }
      outcome = 'exhausted'; // cumulative iteration budget exhausted, not verified success
    }
  } catch (error) { reason = error.message; failureKey = error.failureKey || `${error.code || error.name}:${error.message.replaceAll(home, '~')}`; log(`${provider} failed: ${reason}`); outcome = 'failed'; }
  finally {
    if (tree && branch) {
      try {
        // Another session may have switched branches; only preserve this run's work.
        const currentBranch = run('git', ['branch', '--show-current'], tree);
        if (currentBranch === branch && run('git', ['status', '--porcelain', '--', '.', ':!.loop'], tree)) {
          const preserved = preserveDirtyTree({ tree, run, log, now });
          log(`quota-sweep: preserved final uncommitted work on ${preserved.branch}${preserved.pushed ? '' : ' (local only)'}`);
        }
      } catch (error) { log(`quota-sweep: final dirty-tree preservation failed: ${error.message}`); }
    }
    if (tree && branch) {
      try {
        if (run('git', ['branch', '--show-current'], tree) !== branch) throw new Error('Worktree branch changed externally; no push attempted');
        if (Number(run('git', ['rev-list', '--count', `${record.base}..HEAD`], tree)) > 0) {
          run('git', ['push', '-u', 'origin', branch], tree);
          prUrl = run('gh', ['pr', 'list', '--head', branch, '--state', 'all', '--json', 'url', '--jq', '.[0].url // empty'], tree);
          if (!prUrl) prUrl = run('gh', ['pr', 'create', '--base', 'main', '--head', branch, '--fill'], tree);
        }
      } catch (error) { log(`PR delivery failed: ${error.message}`); record.deliveryError = error.message; reason = [reason, `PR delivery: ${error.message}`].filter(Boolean).join('; '); failureKey = error.failureKey || 'pr-delivery'; outcome = 'failed'; }
    }
    try { const after = await refresh(); usedAfter = after.find(w => w.provider === provider && w.window === decision.window)?.usedPercent ?? usedAfter; } catch { /* unknown */ }
    const stopOutcome = outcome;
    if (prUrl && !['final', 'no-goal'].includes(outcome)) outcome = 'partial';
    reason ||= { failed: '停止理由を取得できなかった', deadline: '利用窓または子プロセスの制限時間に到達', ceiling: '利用率の上限に到達', exhausted: '利用枠または累積試行上限に到達', 'no-goal': '実行対象の未完了目標なし' }[stopOutcome] || null;
    if (stopOutcome === 'failed') failureKey ||= 'unknown-failure';
    else failureKey = null;
    const row = makeLedger({ decision: { ...decision, usedPercent: usedBefore }, startedAt, endedAt: now(), usedAfter, ticks: record.ticks, outcome, ...selection, branch, prUrl, reason, failureKey, stopOutcome, deliveryError: record.deliveryError || null });
    try { queueRepeatedFailure(home, state, row); queueRepeatedDeferral(home, state, row); }
    catch (error) { log(`修復タスク起票失敗: ${error.message}`); row.remediationError = error.message; }
    Object.assign(record, row); save();
    fs.appendFileSync(path.join(home, '.claude', 'quota-sweep.jsonl'), JSON.stringify(row) + '\n');
    // 停止理由と failureKey は executor-usage 側にも残す。quota-sweep.jsonl だけに置いていたため、
    // executor-usage しか読まない delegation-health では全滅行が no_output と表示され、原因
    // （EPERM・窓情報不足・対話検出）が見えなかった（2026-10-21 の codex 6連続 failed が該当）。
    const usageRow = { t: row.ts, provider: `quota-sweep:${provider}`, model: provider === 'claude' ? env.ORGIAST_QUOTA_SWEEP_MODEL || 'sonnet' : 'codex', in: inputTokens, out: outputTokens, tokens: inputTokens + outputTokens, secs: row.durationSec, status: outcome, attempt: record.attempts, failover: false };
    if (reason) usageRow.reason = reason;
    if (failureKey) usageRow.failureKey = failureKey;
    fs.appendFileSync(path.join(home, '.claude', 'executor-usage.jsonl'), JSON.stringify(usageRow) + '\n');
    log(`${provider}: ${outcome}, ticks=${record.ticks}, reason=${reason || '完了'}`);
    const oneLine = value => String(value).replace(/[\r\n]+/g, ' ').slice(0, 250);
    try { if (outcome !== 'no-goal') await notify([`${provider}/${decision.window}`, `${usedBefore}% → ${usedAfter ?? '?'}%`, `tick: ${record.ticks}`, oneLine(selection.goal), prUrl || '変更なし', outcome === 'partial' ? '成果あり・未完了' : outcome, reason ? `理由: ${oneLine(reason)}` : '検証完了'].join('\n'), { home }); }
    catch (error) { log(`DM failed: ${error.message}`); }
  }
}

export async function main(argv = process.argv.slice(2), io = {}) {
  const options = parseArgs(argv), { home } = options, dir = path.join(home, '.claude');
  const now = io.now ?? Date.now, spawnImpl = io.spawnImpl ?? spawnSync;
  const print = io.print ?? console.log;
  const emit = report => { print(options.json ? JSON.stringify(report, null, 2) : report.reason || JSON.stringify(report)); return report; };
  const stateFile = path.join(dir, 'quota-sweep-state.json');
  if (options.status) return emit({ state: json(stateFile), ledger: read(path.join(dir, 'quota-sweep.jsonl')).trim().split('\n').filter(Boolean).slice(-10).map(line => JSON.parse(line)) });
  const env = { ...process.env, ...parseAutoSessionEnvText(read(path.join(dir, 'auto-session.env'))) };
  if (env.ORGIAST_QUOTA_SWEEP === '0') return emit({ skipped: true, reason: 'ORGIAST_QUOTA_SWEEP=0' });
  const requestedHomes = io.wslHome ?? (argv.includes('--home') ? [] : passiveWslHomes());
  const wslHomes = Array.isArray(requestedHomes) ? [...requestedHomes] : [requestedHomes];
  // 1回のスイープは decision 用・開始前 check 用・再取得用と同じ oauth/usage を数十秒に3回叩く。
  // 2026-10-23T07:10Z の window-info 失敗はその直後に起きた。成功した読み取りだけを短時間
  // 再利用し、失敗はキャッシュしない（checkConditions の再試行を妨げない）。
  const claudeReadTtlMs = io.claudeReadTtlMs ?? 15_000;
  let claudeCache = null, claudeCachedAt = 0;
  const windows = io.readWindows ?? (async () => {
    const at = now();
    let claude = claudeCache && at - claudeCachedAt < claudeReadTtlMs ? claudeCache : null;
    if (!claude) {
      claude = await readClaudeWindows({ home, fetchImpl: io.fetchImpl });
      if (claude.length) { claudeCache = claude; claudeCachedAt = at; }
    }
    const codex = readCodexWindows({ home, wslHome: wslHomes, now: now() });
    const all = [...claude, ...codex]; all.reasons = { claude: claude.reason, codex: codex.reason }; return all;
  });
  // A dry-run only reads files/API; no locks, processes, notifications or state mutations.
  if (options['dry-run']) {
    const observed = await windows();
    return emit({ windows: observed, reasons: observed.reasons, decision: decideSweep({ windows: observed, now: now(), ...options }).filter(d => options.provider === 'all' || d.provider === options.provider) });
  }
  if ((io.platform ?? process.platform) !== 'win32') return emit({ skipped: true, reason: 'Scheduled sweep requires Windows; use --dry-run for observations' });
  fs.mkdirSync(dir, { recursive: true });
  const log = text => { fs.appendFileSync(path.join(dir, 'quota-sweep.log'), `${new Date(now()).toISOString()} ${text}\n`); if (!options.json) print(text); };
  const release = acquireLock(path.join(dir, 'quota-sweep.lock'));
  if (!release) { log('skip: lock held'); return emit({ skipped: true, reason: 'lock held' }); }
  try {
    const state = json(stateFile, { lastRun: {} });
    const wsl = Object.hasOwn(io, 'wsl') ? io.wsl : argv.includes('--home') ? null : discoverWsl({ spawnImpl });
    if (wsl?.home && !wslHomes.includes(wsl.home)) wslHomes.push(wsl.home);
    const active = io.active ?? (async provider => {
      if (provider === 'claude') return interactiveClaude({ home, now: now() });
      const r = wsl ? spawnImpl('wsl', ['-d', wsl.distro, '--', 'ps', '-eo', 'args='], { encoding: 'utf8', windowsHide: true, timeout: 10_000 })
        : spawnImpl('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "Get-CimInstance Win32_Process | Where-Object {$_.Name -match '^codex(?:\\.exe)?$'} | ForEach-Object {$_.CommandLine}"], { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
      return r.status !== 0 || interactiveCodex(r.stdout);
    });
    if (wsl && options.provider !== 'claude') {
      const auth = syncWslCodexAuth({ homeDir: home, spawnImpl, log });
      if (auth.action === 'synced') {
        state.codexAuthChangedAt = now(); atomic(stateFile, state);
        log('Codex account changed; new authenticated session log required');
      }
    }
    const currentWindows = async () => filterWindowsForCurrentAuth(await windows(), state);
    const observed = await currentWindows();
    const decisions = decideSweep({ windows: observed, now: now(), ...options }).filter(d => (options.provider === 'all' || options.provider === d.provider) && canRunWindow(state, d));
    if (!decisions.length) {
      // 読み取り自体が失敗していた場合、これまでは「窓が無い」とだけ出て原因が残らなかった。
      const readIssues = Object.entries(observed.reasons ?? {}).filter(([, r]) => r).map(([p, r]) => `${p}: ${r}`);
      log(`skip: no eligible reset window${readIssues.length ? ` (${readIssues.join('; ')})` : ''}`);
    }
    for (const decision of decisions) {
      if (await active(decision.provider)) { log(`skip: interactive ${decision.provider}`); continue; }
      await runSweep(decision, { ...io, leadMinutes: options.leadMinutes, minRemainingPercent: options.minRemainingPercent, home, state, save: () => atomic(stateFile, state), windows: currentWindows, active, log, env, now, spawnImpl, wsl });
    }
    return emit({ decision: decisions, state });
  } finally { release(); }
}
if (isEntry(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
