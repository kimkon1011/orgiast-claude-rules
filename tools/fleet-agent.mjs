#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { machineIdentity } from './machine-identity.mjs';
import { parseHandoff } from './auto-session.mjs';
import { isEntry } from './is-entry.mjs';

const ALLOWED_KINDS = new Set(['status', 'prompt', 'enable-auto-session']);
const DEFAULT_URL = 'https://raw.githubusercontent.com/kimkon1011/orgiast-claude-rules/main/fleet-directives.json';
const SECRET_PATTERN = /(https?:\/\/[^\s]*?(?:webhook|token|key)[^\s]*|(?:api[_-]?key|token|secret|webhook)[\s=:]+[^\s]+)/gi;
const STATUS_TEXT_LIMIT = 1800;
const NON_FAILURE_TASK_RESULTS = new Set([0, 267009, 267011]);

export function readEnv(file, io = fs) {
  const values = {};
  try {
    for (const line of io.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
      const match = line.match(/^([^#=]+)=(.*)$/);
      if (match) values[match[1].trim()] = match[2].trim();
    }
  } catch {}
  return values;
}

export function redactSecrets(value) {
  return String(value ?? '').replace(SECRET_PATTERN, '[REDACTED]').replace(/https:\/\/discord(?:app)?\.com\/api\/webhooks\/\S+/gi, '[REDACTED]');
}

export function targetMatches(targets, label, hostname) {
  const target = String(targets ?? '');
  return target === '' || target === 'all' || String(label).includes(target) || String(hostname).includes(target);
}

export function loadOptin(file, io = fs) {
  try {
    const parsed = JSON.parse(io.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    return Array.isArray(parsed.accept) ? parsed.accept.map(String) : [];
  } catch { return []; }
}

function runSync(program, args, options = {}) {
  try {
    return spawnSync(program, args, { encoding: 'utf8', windowsHide: true, timeout: options.timeout ?? 20_000, cwd: options.cwd, env: options.env ?? process.env });
  } catch (error) { return { status: null, stdout: '', stderr: String(error?.message ?? error), error }; }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return {}; }
}

function repoInfo(repo, run = runSync) {
  if (!repo || !fs.existsSync(path.join(repo, '.git'))) return { branch: 'unknown', behind: 'unknown' };
  run('git', ['-C', repo, 'fetch', '--quiet', 'origin', 'main'], { timeout: 30_000 });
  const branch = run('git', ['-C', repo, 'rev-parse', '--abbrev-ref', 'HEAD'], { timeout: 10_000 });
  const behind = run('git', ['-C', repo, 'rev-list', '--count', 'HEAD..origin/main'], { timeout: 10_000 });
  return { branch: branch.status === 0 ? branch.stdout.trim() : 'unknown', behind: behind.status === 0 ? behind.stdout.trim() : 'unknown' };
}

function scheduledTaskStatus(run = runSync) {
  const command = "$tasks = @((Get-ScheduledTask | Where-Object { $_.TaskName -match 'Orgiast|Claude' }) | ForEach-Object { $i = $_ | Get-ScheduledTaskInfo; [pscustomobject]@{ name = $_.TaskName; result = $i.LastTaskResult; last = $i.LastRunTime } }); ConvertTo-Json -InputObject $tasks -Compress";
  let response;
  try {
    response = run('powershell', ['-NoProfile', '-NonInteractive', '-Command', command], { timeout: 20_000 });
  } catch (error) {
    return { error: `実行例外: ${String(error?.message ?? error)}` };
  }
  if (response?.status !== 0) {
    const detail = String(response?.stderr || `exit=${response?.status ?? 'unknown'}`).trim();
    return { error: detail };
  }
  try {
    const parsed = JSON.parse(String(response.stdout ?? '').replace(/^\uFEFF/, '').trim());
    const tasks = (Array.isArray(parsed) ? parsed : [parsed]).filter((task) => task && typeof task === 'object');
    const failures = tasks.filter((task) => {
      const result = Number(task.result);
      return Number.isFinite(result) && !NON_FAILURE_TASK_RESULTS.has(result);
    }).map((task) => `${String(task.name ?? '名前不明')}(result=${Number(task.result)})`);
    return { tasks, failures };
  } catch (error) {
    return { error: `JSON不正: ${String(error?.message ?? error)}` };
  }
}

function fitStatusLines({ header, hostLine, repoLine, jobStatus, syncLine, todoLine }) {
  const fixedLines = [header, hostLine, repoLine, syncLine, todoLine];
  const fixedLength = fixedLines.join('\n').length + 1;
  const jobBudget = Math.max(0, STATUS_TEXT_LIMIT - fixedLength);
  let jobLine;
  if (jobStatus.error) {
    jobLine = `夜間ジョブ=取得できませんでした(${redactSecrets(jobStatus.error).replace(/\s+/g, ' ').slice(0, 300)})`;
  } else if (jobStatus.failures.length === 0) {
    jobLine = `夜間ジョブ=失敗なし(${jobStatus.tasks.length}件確認)`;
  } else {
    const prefix = '夜間ジョブ失敗=';
    const included = [];
    for (const failure of jobStatus.failures) {
      const candidate = [...included, failure];
      const omitted = jobStatus.failures.length - candidate.length;
      const suffix = omitted > 0 ? ` / …(他${omitted}件を省略)` : '';
      if (`${prefix}${candidate.join(' / ')}${suffix}`.length > jobBudget) break;
      included.push(failure);
    }
    const omitted = jobStatus.failures.length - included.length;
    jobLine = `${prefix}${included.join(' / ')}${omitted > 0 ? `${included.length ? ' / ' : ''}…(他${omitted}件を省略)` : ''}`;
  }
  if (jobLine.length > jobBudget) jobLine = jobLine.slice(0, jobBudget);
  return [header, hostLine, repoLine, jobLine, syncLine, todoLine];
}

export function collectStatus({ home, repo, label, hostname, run = runSync, platform = process.platform }) {
  const account = readJson(path.join(home, '.claude.json'))?.oauthAccount?.emailAddress || '未設定';
  const git = repoInfo(repo, run);
  let syncLast = 'なし';
  try {
    const lines = fs.readFileSync(path.join(home, '.claude', 'hooks', 'onboarding-sync.log'), 'utf8').trim().split(/\r?\n/);
    syncLast = redactSecrets(lines.at(-1) || 'なし').slice(0, 500);
  } catch {}
  let todoCount = 0;
  try { todoCount = parseHandoff(fs.readFileSync(path.join(home, '.claude', 'next-session.md'), 'utf8')).todos.length; } catch {}
  const accepts = loadOptin(path.join(home, '.claude', 'fleet-agent-optin.json'));
  const jobStatus = platform === 'win32' ? scheduledTaskStatus(run) : { tasks: [], failures: [] };
  const failures = jobStatus.failures ?? [];
  const lines = fitStatusLines({
    header: `📡 **[${label}]** status`,
    hostLine: `hostname=${hostname} / OS=${platform} ${os.release()} / account=${account}`,
    repoLine: `repo=${git.branch}, origin/mainより${git.behind}コミット遅れ`,
    jobStatus,
    syncLine: `onboarding-sync=${syncLast}`,
    todoLine: `残TODO=${todoCount} / prompt opt-in=${accepts.includes('prompt') ? 'yes' : 'no'}`,
  });
  const text = lines.join('\n');
  return { text: redactSecrets(text), data: { label, hostname, platform, account, git, syncLast, failures, todoCount, promptOptin: accepts.includes('prompt'), checkedAt: new Date().toISOString() } };
}

export function runPrompt({ claudeExe, body, cwd, timeoutSeconds = 1800, spawnImpl = spawn }) {
  return new Promise((resolve) => {
    const started = Date.now();
    let stdout = '';
    let stderr = '';
    let settled = false;
    const child = spawnImpl(claudeExe, ['-p', String(body ?? '')], {
      cwd, env: { ...process.env, CLAUDE_HEADLESS: '1', CI: '1' }, stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true,
    });
    child.stdin.end();
    child.stdout.on('data', (chunk) => { stdout += chunk; if (stdout.length > 100_000) stdout = stdout.slice(-100_000); });
    child.stderr.on('data', (chunk) => { stderr += chunk; if (stderr.length > 100_000) stderr = stderr.slice(-100_000); });
    const finish = (result) => { if (settled) return; settled = true; clearTimeout(timer); resolve({ ...result, durationSeconds: Math.round((Date.now() - started) / 100) / 10, outputTail: `${stdout}${stderr}`.slice(-10_000) }); };
    child.on('error', (error) => finish({ exitCode: null, error: String(error?.message ?? error), timedOut: false }));
    child.on('close', (code) => finish({ exitCode: code, timedOut: false }));
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish({ exitCode: null, timedOut: true, error: 'タイムアウトで停止' }); }, Math.max(1, Number(timeoutSeconds)) * 1000);
  });
}

function consentCommand(kind) {
  return `node -e "const f=require('fs'),o=require('os'),p=require('path').join(o.homedir(),'.claude','fleet-agent-optin.json');let a=[];try{a=JSON.parse(f.readFileSync(p,'utf8')).accept||[]}catch{};f.writeFileSync(p,JSON.stringify({accept:[...new Set([...a,'${kind}'])],acceptedAt:new Date().toISOString(),acceptedBy:o.userInfo().username},null,2))"`;
}

function warningFromResult(result) {
  const output = String(result.outputTail ?? '');
  return result.exitCode !== 0 || !output.trim() || /error|failed/i.test(output);
}

export async function processDirective(directive, context) {
  const { home, repo, label, hostname, dryRun, post, spawnImpl = spawn, run = runSync } = context;
  const id = String(directive.id ?? '');
  const kind = String(directive.kind ?? '');
  if (!id || !targetMatches(directive.targets, label, hostname)) return { action: 'skipped' };
  if (directive.expiresAt && Date.parse(directive.expiresAt) < Date.now()) return { action: 'expired' };
  if (!ALLOWED_KINDS.has(kind)) {
    const message = `⚠ **[${label}]** 未許可 kind『${kind}』は実行しません (id=${id})`;
    if (!dryRun) await post(message);
    return { action: 'denied', message };
  }
  if (kind === 'status') {
    const status = collectStatus({ home, repo, label, hostname, run });
    if (!dryRun) {
      fs.writeFileSync(path.join(home, '.claude', 'fleet-agent-last-status.json'), `${JSON.stringify(status.data, null, 2)}\n`);
      await post(status.text);
    }
    return { action: 'status', message: status.text };
  }
  const optinKind = kind === 'prompt' ? 'prompt' : 'auto-session';
  if (!loadOptin(path.join(home, '.claude', 'fleet-agent-optin.json')).includes(optinKind)) {
    const preview = String(directive.body ?? '').slice(0, 300);
    const message = `🔒 **[${label}]** 未オプトインの指示『${kind}』(id=${id})\n送信者=${directive.createdBy || '不明'} / 理由=${directive.why || 'なし'}\n本文=${preview || '(なし)'}\n承諾するにはこの1コマンド: \`${consentCommand(optinKind)}\``;
    if (!dryRun) await post(message);
    return { action: 'optin-required', message };
  }
  if (dryRun) return { action: 'dry-run' };
  if (kind === 'enable-auto-session') {
    if (process.platform !== 'win32') {
      const message = `⚠ **[${label}]** auto-session 登録は win32 のみです (id=${id})`;
      await post(message); return { action: 'unsupported', message };
    }
    const query = run('schtasks', ['/query', '/tn', 'OrgiastAutoSession'], { timeout: 10_000 });
    if (query.status === 0) { const message = `✅ **[${label}]** OrgiastAutoSession は既に登録済み (id=${id})`; await post(message); return { action: 'already-enabled', message }; }
    const result = run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(repo, 'tools', 'register-auto-session.ps1')], { timeout: 60_000 });
    const message = `${result.status === 0 ? '✅' : '⚠'} **[${label}]** auto-session 登録 exit=${result.status ?? 'unknown'} (id=${id}): ${redactSecrets(`${result.stdout || ''}${result.stderr || ''}`).slice(-1500)}`;
    await post(message); return { action: 'auto-session', message };
  }
  const cwd = directive.cwd ? path.resolve(String(directive.cwd)) : repo;
  if (!cwd || !fs.existsSync(cwd)) { const message = `⚠ **[${label}]** cwd が存在しないため実行しません: ${cwd} (id=${id})`; await post(message); return { action: 'bad-cwd', message }; }
  const result = await runPrompt({ claudeExe: process.env.CLAUDE_CLI_PATH || 'claude', body: directive.body, cwd, timeoutSeconds: directive.timeoutSeconds ?? 1800, spawnImpl });
  const resultsDir = path.join(home, '.claude', 'fleet-agent-results');
  fs.mkdirSync(resultsDir, { recursive: true });
  fs.writeFileSync(path.join(resultsDir, `${id}.json`), `${JSON.stringify(result, null, 2)}\n`);
  const warning = warningFromResult(result);
  const summary = result.timedOut ? 'タイムアウトで停止' : redactSecrets(result.outputTail).slice(-1500) || '(出力なし)';
  const message = `${warning ? '⚠' : '✅'} **[${label}]** prompt 完了 exit=${result.exitCode ?? 'unknown'} / ${result.durationSeconds}s (id=${id})\n${summary}`;
  await post(message);
  return { action: 'prompt', result, message };
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const dryRun = argv.includes('--dry-run');
  const json = argv.includes('--json');
  const home = process.env.ORGIAST_HOME || os.homedir();
  const claudeDir = path.join(home, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  const repo = process.env.ORGIAST_REPO || path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const env = readEnv(path.join(claudeDir, 'cost-reporter.env'));
  const identity = machineIdentity();
  const label = env.REPORTER_LABEL || identity.hostname || 'unknown';
  const hostname = identity.hostname || os.hostname();
  const webhook = env.DISCORD_COST_WEBHOOK || env.COST_WEBHOOK || '';
  const post = dependencies.post || (async (message) => {
    if (!webhook) return;
    try { await fetch(webhook, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'DiscordBot (https://github.com/kimkon1011/orgiast-claude-rules, 1.0) OrgiastFleetAgent' }, body: JSON.stringify({ content: message }), signal: AbortSignal.timeout(20_000) }); } catch {}
  });
  let payload;
  try {
    const base = process.env.ORGIAST_FLEET_DIRECTIVES_URL || DEFAULT_URL;
    const separator = base.includes('?') ? '&' : '?';
    const response = await (dependencies.fetch || fetch)(`${base}${separator}cb=${Date.now()}`, { signal: AbortSignal.timeout(20_000) });
    if (!response.ok) return [];
    payload = await response.json();
  } catch { return []; }
  const processedFile = path.join(claudeDir, '.fleet-agent-processed');
  const processed = new Set();
  try { for (const id of fs.readFileSync(processedFile, 'utf8').split(/\r?\n/)) if (id) processed.add(id); } catch {}
  const results = [];
  for (const directive of Array.isArray(payload?.directives) ? payload.directives : []) {
    const id = String(directive?.id ?? '');
    if (!id || processed.has(id) || !targetMatches(directive.targets, label, hostname)) continue;
    // dry-run は観察専用。ここで消費すると、直後の本番実行が同じ指示を拾えなくなる。
    if (!dryRun) {
      fs.appendFileSync(processedFile, `${id}\n`);
      processed.add(id);
    }
    results.push({ id, ...(await processDirective(directive, { home, repo, label, hostname, dryRun, post, spawnImpl: dependencies.spawnImpl, run: dependencies.run })) });
  }
  if (json) console.log(JSON.stringify(results));
  return results;
}

if (isEntry(import.meta.url)) await main();
