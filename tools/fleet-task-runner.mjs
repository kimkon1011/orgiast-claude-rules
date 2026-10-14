#!/usr/bin/env node
// fleet-mail の --exec codex 経路の実行本体。受信ポーリングからデタッチ起動され、
// 相手PCの Codex（定額枠）に本文を実装させ、結果を fleet-agent-results/<id>.json に書く。
// ポーリングはこの結果ファイルができたら返信する（長時間ブロックしない）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isEntry } from './is-entry.mjs';
import { validId, sendHubFailure, parseExecMarkers, createClient, resolveFleetLabel, updateInbox, syncMailState, acquireLock, TERMINAL_STATUSES, isMissingClaudeError, missingClaudeMessage } from './fleet-mail.mjs';
import { loadOptin, consentCommand, runPrompt, validExecCwd, hubReport, redactSecrets } from './fleet-agent.mjs';
import { parseEnvText } from './env-kv.mjs';
import { resolveClaudeExecutableFromDisk } from './claude-exe.mjs';
import { updateQuestion, clearResume, RESUME_LIMIT_MS, validSessionId } from './fleet-question-relay.mjs';

const ownRepo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const execMarker = /^<!--\s*fleet-exec:\s*codex\s*-->\s*$/;
const execCwdMarker = /^<!--\s*fleet-exec-cwd:\s*(.*?)\s*-->\s*$/;

// 本文先頭のマーカー 2 行を取り除く（送信側 --exec codex が挿入したもの）。
export function stripExecMarkers(body) {
  const lines = String(body ?? '').split(/\r?\n/);
  if (!execMarker.test(lines[0] ?? '')) return { cwd: null, body: String(body ?? '') };
  let index = 1;
  let cwd = null;
  const cwdMatch = (lines[index] ?? '').match(execCwdMarker);
  if (cwdMatch) { cwd = cwdMatch[1]; index += 1; }
  return { cwd, body: lines.slice(index).join('\n') };
}

// cwd 指定は「存在するディレクトリ」かつ「.git を持つ」ときだけ採用する。
// 採用できなければ既定（ORGIAST_REPO ?? ownRepo）に落とし、理由を返す。
export function resolveCwd(requested, { ownRepo: repo = ownRepo, exists = fs.existsSync, stat = fs.statSync } = {}) {
  const fallback = process.env.ORGIAST_REPO ?? repo;
  if (!requested) return { cwd: fallback, rejected: null };
  const resolved = path.resolve(String(requested));
  if (!exists(resolved)) return { cwd: fallback, rejected: `cwd 指定を拒否: ディレクトリが存在しません (${resolved})` };
  let isDir = false;
  try { isDir = stat(resolved).isDirectory(); } catch { isDir = false; }
  if (!isDir) return { cwd: fallback, rejected: `cwd 指定を拒否: ディレクトリではありません (${resolved})` };
  if (!exists(path.join(resolved, '.git'))) return { cwd: fallback, rejected: `cwd 指定を拒否: .git がありません (${resolved})` };
  return { cwd: resolved, rejected: null };
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
}

function gitLines(cwd, args, run) {
  try {
    const result = run('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true, timeout: 20_000 });
    if (result?.status !== 0) return '';
    // git status --short は先頭の空白に意味がある（" M" = 未ステージ）ので末尾だけ落とす。
    return String(result.stdout ?? '').split(/\r?\n/).slice(0, 40).join('\n').trimEnd();
  } catch { return ''; }
}

// 返信本文の形式（outputTail の前に付ける）。
export function formatReply({ exitCode, cwd, minutes, gitStatus, gitLog, outputTail }) {
  return [
    `[fleet-exec codex] exit=${exitCode ?? 'unknown'} cwd=${cwd} 所要=${minutes}分`,
    'git status:',
    gitStatus || '(変更なし)',
    'git log:',
    gitLog || '(取得できませんでした)',
    '--- codex-do 出力末尾 ---',
    outputTail || '(出力なし)',
  ].join('\n');
}

// Own the session only in this detached process. Persist the result before transport so
// a later poll can retry a failed reply without ever executing the prompt twice.
export async function runClaudeTask({ id, home, spawnImpl = spawn, now = Date.now, request, resolveClaudeExe = resolveClaudeExecutableFromDisk,
  promptSetTimer, promptClearTimer, stderr = console.error } = {}) {
  validId(id);
  const dir = path.join(home, '.claude'), resultFile = path.join(dir, 'fleet-agent-results', `${id}.json`);
  const release = acquireLock(`${resultFile}.runner.lock`, { now });
  if (!release) return { skipped: 'locked' };
  let sessionId, owns = false;
  const cleanup = async () => {
    const clear = async sid => {
      for (let attempt = 0; attempt < 5; attempt++) {
        if (clearResume(home, sid, id)) return;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    };
    if (owns && sessionId) await clear(sessionId);
    // A new Claude session learns its id in its hook, which tags it with this mail id.
    {
      const questions = path.join(dir, 'fleet-questions');
      if (fs.existsSync(questions)) for (const name of fs.readdirSync(questions).filter(n => /^[A-Za-z0-9][A-Za-z0-9_-]*\.json$/.test(n))) await clear(name.slice(0, -5));
    }
  };
  try {
    const mail = readJson(path.join(dir, 'fleet-inbox', `${id}.json`));
    if (!mail || TERMINAL_STATUSES.includes(mail.status)) return { skipped: 'terminal' };
    const config = parseEnvText(fs.readFileSync(path.join(dir, 'fleet-sheet.env'), 'utf8'));
    request ??= createClient({ url: config.FLEET_SHEET_URL, token: config.FLEET_SHEET_TOKEN });
    const label = resolveFleetLabel(home);
    const marked = parseExecMarkers(mail.body);
    const exec = { ...marked, exec: mail.exec || marked.exec, cwd: mail.execCwd || marked.cwd, resumeSessionId: mail.resumeSessionId || marked.resumeSessionId };
    if (exec.exec !== 'claude') return { skipped: 'not-claude' };
    sessionId = exec.resumeSessionId;
    const scheduledAt = Date.parse(mail.executionStartedAt);
    const executionStart = Number.isFinite(scheduledAt) ? scheduledAt : now();
    let result = readJson(resultFile);
    if (!result) {
      let executable = 'claude', candidates = [];
      try {
        const reason = !config.FLEET_HUB || mail.from !== config.FLEET_HUB ? 'not-hub' : !validExecCwd(exec.cwd) ? 'bad-cwd' : null;
        if (reason) result = { exitCode: null, reason, outputTail: `reason: ${reason}` };
        else if (!loadOptin(path.join(dir, 'fleet-agent-optin.json')).includes('claude-resume')) result = { exitCode: null, outputTail: `未オプトイン。承諾コマンド: ${consentCommand('claude-resume')}` };
        else {
          if (sessionId) {
            validSessionId(sessionId);
            const claim = updateQuestion(home, sessionId, current => {
              if (current?.resumingAt && now() - Date.parse(current.resumingAt) < RESUME_LIMIT_MS) return null;
              return { ...current, sessionId, cwd: exec.cwd, resumingAt: new Date(now()).toISOString(), drivenByHub: true, answeredAt: new Date(now()).toISOString(), resumeMailId: id };
            });
            if (!claim) {
              updateInbox(id, current => { if (!current) return null; const next = { ...current }; delete next.executionStartedAt; return next; }, { home });
              return { skipped: 'session-busy' };
            }
            owns = true;
          }
          const resolved = await resolveClaudeExe({ platform: process.platform, env: process.env });
          executable = (typeof resolved === 'string' ? resolved : resolved?.executable) || 'claude';
          candidates = resolved?.candidates || [];
          await syncMailState({ home, id, action: 'seen', seenBy: 'headless', from: label, request, now, stderr });
          const remaining = RESUME_LIMIT_MS - (now() - executionStart);
          result = remaining <= 0 ? { exitCode: null, timedOut: true } : await runPrompt({
            claudeExe: executable, body: exec.body, cwd: exec.cwd, resumeSessionId: sessionId, resumeMailId: id,
            drivenByHub: true, home, spawnImpl, timeoutSeconds: remaining / 1000, setTimer: promptSetTimer, clearTimer: promptClearTimer });
          if (isMissingClaudeError(result)) result = { ...result, stdoutTail: '', outputTail: missingClaudeMessage(executable, candidates) };
        }
      } catch (error) { result = { exitCode: null, outputTail: isMissingClaudeError(error) ? missingClaudeMessage(executable, candidates) : `実行失敗: ${redactSecrets(error.message)}` }; }
      finally { await cleanup(); }
      result = hubReport(result);
      if (result.error) result.error = redactSecrets(result.error);
      writeJsonAtomic(resultFile, result);
    }
    const current = readJson(path.join(dir, 'fleet-inbox', `${id}.json`));
    if (TERMINAL_STATUSES.includes(current?.status)) return result;
    try {
      if (result.reason) {
        await sendHubFailure({ home, mail, result, request, label, now, stderr });
        return result;
      }
      const reply = await request('mail-reply', { id, from: label, resultBody: result.outputTail, auto: true, hop: Number(mail.hop || 0) + 1, priority: 'normal' });
      if (!reply?.ok) throw new Error('reply failed');
      updateInbox(id, current => current && ({ ...current, status: reply.mail?.status === 'failed' || reply.mail?.status === 'expired' ? reply.mail.status : 'done', resultBody: result.outputTail, resultAt: new Date(now()).toISOString() }), { home });
    } catch { stderr('fleet-mail: 返信再送待ち=1'); }
    return result;
  } finally { release(); }
}

export async function runTask({ id, home, ownRepo: repo = ownRepo, spawnImpl = spawn, run = spawnSync, now = Date.now } = {}) {
  const dir = path.join(home, '.claude');
  const resultsDir = path.join(dir, 'fleet-agent-results');
  const resultFile = path.join(resultsDir, `${validId(id)}.json`);
  const startedAt = new Date(now()).toISOString();
  let cwd = process.env.ORGIAST_REPO ?? repo;
  let rejected = null;
  let exitCode = null;
  let outputTail = '';
  try {
    const mail = readJson(path.join(dir, 'fleet-inbox', `${validId(id)}.json`));
    if (!mail) throw new Error('inbox に該当メッセージがありません');
    const stripped = stripExecMarkers(mail.body);
    const resolved = resolveCwd(stripped.cwd, { ownRepo: repo });
    cwd = resolved.cwd;
    rejected = resolved.rejected;
    fs.mkdirSync(resultsDir, { recursive: true });
    const promptFile = path.join(resultsDir, `${validId(id)}.prompt.md`);
    fs.writeFileSync(promptFile, stripped.body, { mode: 0o600 });
    const logFile = path.join(resultsDir, `${validId(id)}.log`);
    const logFd = fs.openSync(logFile, 'a', 0o600);
    try {
      exitCode = await new Promise((resolve) => {
        const child = spawnImpl(process.execPath, [path.join(repo, 'tools', 'codex-do.mjs'),
          '--prompt-file', promptFile, '--cwd', cwd, '--timeout', '1800', '--kind', 'implement', '--origin', 'unattended'],
          { cwd, stdio: ['ignore', logFd, logFd], windowsHide: true });
        child.on('error', () => resolve(null));
        child.on('close', (code) => resolve(code));
      });
    } finally { fs.closeSync(logFd); }
    try { outputTail = fs.readFileSync(logFile, 'utf8').slice(-6000); } catch { outputTail = ''; }
    // cwd 指定を拒否したときは、その理由を結果本文の先頭に残す（黙って別ディレクトリで走らせない）。
    if (rejected) outputTail = `${rejected}\n${outputTail}`;
  } catch (error) {
    outputTail = `実行失敗: ${String(error?.message ?? error)}`;
  }
  const gitStatus = gitLines(cwd, ['status', '--short'], run);
  const gitLog = gitLines(cwd, ['log', '--oneline', '-3'], run);
  const finishedAt = new Date(now()).toISOString();
  const minutes = Math.max(0, Math.round((Date.parse(finishedAt) - Date.parse(startedAt)) / 60000));
  const reply = formatReply({ exitCode, cwd, minutes, gitStatus, gitLog, outputTail });
  const result = { exitCode, cwd, outputTail: reply, gitStatus, gitLog, startedAt, finishedAt, ...(rejected ? { cwdRejected: rejected } : {}) };
  // どんな例外でも結果 JSON を書いて終わる（書けないと相手が2時間タイムアウトまで待つ）。
  try { writeJsonAtomic(resultFile, result); } catch { /* 書けないときは諦める */ }
  return result;
}

if (isEntry(import.meta.url)) {
  const args = process.argv.slice(2);
  const idIndex = args.indexOf('--id');
  const id = idIndex >= 0 ? args[idIndex + 1] : undefined;
  const homeIndex = args.indexOf('--home');
  const home = homeIndex >= 0 ? args[homeIndex + 1] : process.env.ORGIAST_HOME ?? os.homedir();
  if (!id) { console.error('使い方: node tools/fleet-task-runner.mjs --id <mail id>'); process.exitCode = 2; }
  else {
    try {
      const mail = readJson(path.join(home, '.claude', 'fleet-inbox', `${validId(id)}.json`));
      const exec = mail?.exec || parseExecMarkers(mail?.body).exec;
      if (exec === 'claude') await runClaudeTask({ id, home });
      else await runTask({ id, home });
    }
    catch { console.error('fleet-task-runner: 実行失敗=1'); process.exitCode = 1; }
  }
}
