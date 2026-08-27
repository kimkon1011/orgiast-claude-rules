#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { isEntry } from './is-entry.mjs';

const MARKER = '<!-- NEXT-SESSION v1 -->';
const SIX_HOURS = 6 * 60 * 60 * 1000;
export const DEFAULT_REPO = path.resolve(import.meta.dirname, '..');

function firstBlockBounds(md) {
  const first = md.indexOf(MARKER);
  if (first < 0) return { start: 0, end: md.length };
  const second = md.indexOf(MARKER, first + MARKER.length);
  return { start: first, end: second < 0 ? md.length : second };
}

function sectionFrom(block, heading) {
  const escapedHeading = String(heading).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^##[ \\t]+${escapedHeading}(?=[ \\t（(]|$).*$`, 'm');
  const match = re.exec(block);
  if (!match) return '';
  const start = match.index;
  const afterHeading = match.index + match[0].length;
  const rest = block.slice(afterHeading);
  const next = /^##[ \t]+.+$/m.exec(rest);
  return block.slice(start, next ? afterHeading + next.index : block.length).replace(/[\r\n]+$/, '');
}

export function parseHandoff(md) {
  const source = String(md ?? '');
  const { start, end } = firstBlockBounds(source);
  const block = source.slice(start, end);
  const todoSection = sectionFrom(block, '残TODO');
  const todos = [];
  const lines = todoSection.split(/\r?\n/).slice(1);
  for (let index = 0; index < lines.length;) {
    const match = lines[index].match(/^\s*\d+[.)、]\s+(.+?)\s*$/);
    if (!match) { index += 1; continue; }
    const todoLines = [match[1]];
    index += 1;
    let blankCount = 0;
    while (index < lines.length) {
      const line = lines[index];
      if (/^\s*\d+[.)、]\s+/.test(line) || /^##[ \t]+/.test(line)) break;
      if (!line.trim()) {
        blankCount += 1;
        if (blankCount >= 2) break;
      } else {
        while (blankCount > 0) { todoLines.push(''); blankCount -= 1; }
        todoLines.push(line);
      }
      index += 1;
    }
    todos.push(todoLines.join('\n'));
  }
  const sections = {};
  for (const name of ['対象', '完了条件', '触る前に読む memory']) {
    const value = sectionFrom(block, name);
    if (value) sections[name] = value;
  }
  return { block, todos, sections };
}

export function todoExclusionReason(todo, today = new Date()) {
  const text = String(todo);
  if (/~~[^~]*~~/.test(text)) return '取り消し線（完了済み）';
  if (/(要判断|判断待ち|未決)/.test(text)) return '判断待ち';
  if (/ブロック中/.test(text)) return 'ブロック中';
  if ((text.includes('別セッション') && text.includes('着手')) || /(着手中|作業中)/.test(text)) return '他セッションが着手中';
  const todayNumber = today.getFullYear() * 10000 + (today.getMonth() + 1) * 100 + today.getDate();
  for (const match of text.matchAll(/(\d{4})-(\d{2})-(\d{2})\s*以降/g)) {
    const date = `${match[1]}-${match[2]}-${match[3]}`;
    const dateNumber = Number(`${match[1]}${match[2]}${match[3]}`);
    if (dateNumber > todayNumber) return `${date}以降`;
  }
  return '';
}

export function filterTodos(todos, today = new Date()) {
  return todos.filter((todo) => !todoExclusionReason(todo, today));
}

function existingOrDefault(candidate, exists) {
  if (exists(candidate)) return candidate;
  return DEFAULT_REPO;
}

export function loadConfig(homeDir, readFile = fs.readFileSync) {
  try {
    const parsed = JSON.parse(readFile(path.join(homeDir, '.claude', 'auto-session.json'), 'utf8'));
    const repoByKeyword = Object.fromEntries(Object.entries(parsed?.repoByKeyword ?? {}).filter(([key, value]) => key && typeof value === 'string'));
    return { historyCwd: typeof parsed?.historyCwd === 'string' ? parsed.historyCwd : '', repoByKeyword };
  } catch {
    return { historyCwd: '', repoByKeyword: {} };
  }
}

export function pickCwd(todoText, exists = fs.existsSync, rules = {}) {
  const text = String(todoText);
  const candidate = Object.entries(rules).find(([keyword]) => text.includes(keyword))?.[1] ?? DEFAULT_REPO;
  return existingOrDefault(candidate, exists);
}

function cwdSlug(cwd) {
  return String(cwd ?? '').replace(/[^A-Za-z0-9]/g, '-');
}

function defaultListDirs(projectsDir) {
  return fs.readdirSync(projectsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => path.join(projectsDir, entry.name));
}

function defaultNewestTranscript(bucket) {
  return fs.readdirSync(bucket).filter((name) => name.endsWith('.jsonl')).map((name) => {
    const file = path.join(bucket, name);
    return { path: file, mtimeMs: fs.statSync(file).mtimeMs };
  }).sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
}

function defaultReadCwd(file) {
  const content = fs.readFileSync(file, 'utf8');
  const match = content.match(/"cwd"\s*:\s*("(?:\\.|[^"\\])*")/);
  if (!match) return '';
  try { return JSON.parse(match[1]); } catch { return ''; }
}

export function detectHistoryCwd({
  projectsDir,
  listDirs = defaultListDirs,
  newestTranscript = defaultNewestTranscript,
  readCwd = defaultReadCwd,
  exists = fs.existsSync,
}) {
  let buckets = [];
  try {
    buckets = listDirs(projectsDir).map((entry) => {
      const bucket = typeof entry === 'string' ? entry : entry.path;
      let transcript;
      try { transcript = newestTranscript(bucket); } catch { transcript = null; }
      if (typeof transcript === 'string') transcript = { path: transcript, mtimeMs: 0 };
      return { bucket, transcript };
    }).filter(({ transcript }) => transcript?.path).sort((a, b) => (b.transcript.mtimeMs ?? 0) - (a.transcript.mtimeMs ?? 0));
  } catch { return DEFAULT_REPO; }

  for (const { bucket, transcript } of buckets) {
    let cwd;
    try { cwd = readCwd(transcript.path); } catch { continue; }
    const bucketName = path.basename(bucket);
    const alternatives = [cwd];
    if (/^[A-Za-z]:[\\/]/.test(cwd)) alternatives.push(`${cwd[0] === cwd[0].toLowerCase() ? cwd[0].toUpperCase() : cwd[0].toLowerCase()}${cwd.slice(1)}`);
    const matched = alternatives.find((candidate) => cwdSlug(candidate) === bucketName);
    if (matched && exists(matched)) return matched;
  }
  return DEFAULT_REPO;
}

export function buildChildArgs(repoCwd, historyCwd, sessionId) {
  // 2026-08-26 実測: acceptEdits はファイル編集だけを自動承認し、Bash は承認待ちで無人実行が最初のコマンドで止まる。
  // --permission-mode を渡さず ~/.claude/settings.json の既定 auto を継承すると、Bash（git -C ... rev-parse）も通る。
  const args = ['-p', '', '--output-format', 'json', '--model', 'opus', '--add-dir', repoCwd];
  if (historyCwd !== repoCwd) args.push('--add-dir', historyCwd);
  if (sessionId) args.push('--session-id', sessionId);
  return args;
}

function numericVersion(entry) {
  const normalized = String(entry).replace(/\\/g, '/');
  const match = normalized.match(/anthropic\.claude-code-([0-9]+(?:\.[0-9]+)*)(?:-[^/]+)?(?:\/|$)/i);
  return match ? match[1].split('.').map(Number) : null;
}

function compareVersion(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const difference = (a[i] ?? 0) - (b[i] ?? 0);
    if (difference) return difference;
  }
  return 0;
}

export function resolveClaudeExe(entries = extensionExecutables(), claudeCli = process.env.CLAUDE_CLI) {
  if (claudeCli) return claudeCli;
  const candidates = entries
    .map((entry) => ({ entry, version: numericVersion(entry) }))
    .filter(({ version }) => version);
  candidates.sort((a, b) => compareVersion(b.version, a.version));
  return candidates[0]?.entry ?? 'claude';
}

export function decideRun({ lockExists, lockPid, lockAgeMs, pidAlive, disabled }) {
  if (disabled) return { run: false, reason: 'disabled' };
  if (!lockExists) return { run: true, reason: 'no-lock' };
  if (pidAlive && Number(lockAgeMs) < SIX_HOURS) return { run: false, reason: `active-lock:${lockPid}` };
  return { run: true, reason: 'stale-lock' };
}

export function markTodoDone(md, todoText, note) {
  const source = String(md);
  const { start, end } = firstBlockBounds(source);
  const block = source.slice(start, end);
  const firstLine = String(todoText).split(/\r?\n/, 1)[0];
  const escaped = firstLine.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const lineRe = new RegExp(`^(\\s*\\d+[.)、]\\s+)${escaped}(\\s*)$`, 'm');
  const changed = block.replace(lineRe, (_whole, prefix, suffix) => `${prefix}~~${firstLine}~~ → ✅ ${note}${suffix}`);
  return source.slice(0, start) + changed + source.slice(end);
}

export function buildPrompt(todo, sections, repoCwd, date = new Date()) {
  const attached = ['対象', '完了条件', '触る前に読む memory'].map((name) => sections[name]).filter(Boolean).join('\n\n');
  const day = date.toISOString().slice(0, 10).replaceAll('-', '');
  return [
    'あなたは無人で起動された自動セッションです。人間は見ていません。質問せず、完了まで自分で進めてください。',
    `## 目的\n${todo}`,
    attached,
    `## 固定の作業規約
- セッションの作業ディレクトリは履歴を揃えるためのフォルダであり、実際の作業対象リポジトリは ${repoCwd} である。git は必ず \`git -C ${repoCwd}\` の形で実行し、codex-do.mjs は \`--cwd ${repoCwd}\` を付ける。裸の \`git status\` / \`git checkout\` は使わない。
- 実装本体は \`node tools/codex-do.mjs "<指示>" --cwd ${repoCwd}\` で Codex に委譲する（§1.18）。監督は設計・レビュー・検証だけ。
- 他セッションと作業ツリーを共有している。\`git add -A\` / \`git commit -a\` / \`git stash\` / \`git checkout -- .\` は禁止。自分が作成・変更したファイルだけをパス指定で \`git add\` する。着手前とコミット直前に \`git status --porcelain\` を撮り、差分が自分の変更だけであることを確認する。
- ブランチは必ず main から切る。ブランチ名は \`auto/${day}-<短いスラグ>\`。
- \`node --test tools/*.test.mjs\` が緑になるまで直す。
- PR を作り、CI green を確認してから \`gh pr merge --squash\` でマージする。CI が赤なら直し、3回直して赤のままならマージせず PR を残して理由を書いて終了する。
- マージ後、変更が実際に効いているかを実物で検証する。検証できていないものを「完了」と書かない。
- 外部の定期実行(cron/GitHub Actions のスケジュール)の次回発火を待つな。待ちが必要な検証は next-session.md に残して終了しろ。
- 終了時は ~/.claude/next-session.md の先頭ブロックの該当 TODO 行だけを \`~~…~~ → ✅ <日付> 完了（PR #N）\` に行単位で置換し、ファイル全体を上書きしない。
- 秘匿値を出力しない。
- 外部への送信（メール、社外向け Discord、SNS、顧客連絡）は行わない。`,
    '## 完了報告\n最後に3行以内で「やったこと / 検証したこと / 残ったこと」を出力する。',
  ].filter(Boolean).join('\n\n');
}

function homeDir() {
  return process.env.ORGIAST_HOME || os.homedir();
}

const UUID_PATTERN = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';

export function extractSessionId(stdout) {
  const text = String(stdout ?? '');
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed?.session_id === 'string' && new RegExp(`^${UUID_PATTERN}$`).test(parsed.session_id)) return parsed.session_id;
  } catch {}
  const matches = [...text.matchAll(new RegExp(`"session_id"\\s*:\\s*"(${UUID_PATTERN})"`, 'g'))];
  return matches.at(-1)?.[1] ?? '';
}

export function transcriptPath(cwd, sessionId) {
  if (!sessionId) return '';
  const slug = cwdSlug(cwd);
  return path.resolve(homeDir(), '.claude', 'projects', slug, `${sessionId}.jsonl`);
}

export function localDate(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function safeStderrTail(stderr) {
  const redacted = String(stderr ?? '')
    .replace(/https:\/\/discord(?:app)?\.com\/api\/webhooks\/[^\s]+/gi, '[REDACTED_WEBHOOK]')
    .replace(/\b(?:sk-ant-|ghp_|github_pat_|Bearer\s+)[A-Za-z0-9._-]+/gi, '[REDACTED_TOKEN]')
    .replace(/\b([A-Za-z_][A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY))\s*[=:]\s*\S+/gi, '$1=[REDACTED]')
    .replace(/\s+/g, ' ')
    .trim();
  return redacted.slice(-200);
}

export function notificationLine(result) {
  const minutes = Math.max(0, Math.round((Date.parse(result.endedAt) - Date.parse(result.startedAt)) / 60_000));
  const pr = prNumber(result.stdout);
  const reason = result.status === 'success' ? '' : safeStderrTail(result.stderr);
  return `- ${result.todo} | ${result.status}${pr ? ` | PR #${pr}` : ''} | ${minutes}分 | transcript: ${result.transcript || '(取得できず)'} | resume: ${result.resumeCommand || '(取得できず)'}${reason ? ` | 理由: ${reason}` : ''}`;
}

function parseArgs(argv) {
  const options = { count: 1, timeoutMin: 150, dry: false, list: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--dry') options.dry = true;
    else if (argv[i] === '--list') options.list = true;
    else if (argv[i] === '--count') options.count = Math.min(3, Math.max(1, Number(argv[++i]) || 1));
    else if (argv[i] === '--timeout-min') options.timeoutMin = Math.max(1, Number(argv[++i]) || 150);
    else throw new Error(`不明な引数: ${argv[i]}`);
  }
  return options;
}

function pidIsAlive(pid) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return false;
  try { process.kill(Number(pid), 0); return true; } catch { return false; }
}

function extensionExecutables() {
  const profile = process.env.USERPROFILE || homeDir();
  const root = path.join(profile, '.vscode', 'extensions');
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^anthropic\.claude-code-/i.test(entry.name))
      .map((entry) => path.join(root, entry.name, 'resources', 'native-binary', process.platform === 'win32' ? 'claude.exe' : 'claude'))
      .filter((entry) => fs.existsSync(entry));
  } catch { return []; }
}

function runChild(executable, prompt, repoCwd, historyCwd, sessionId, timeoutMs) {
  return new Promise((resolve) => {
    const startedAt = new Date();
    const child = spawn(executable, buildChildArgs(repoCwd, historyCwd, sessionId), {
      cwd: historyCwd, env: { ...process.env, CLAUDE_HEADLESS: '1' }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => { stderr += error.message; });
    child.stdin.on('error', () => {});
    child.stdin.end(prompt, 'utf8');
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
      else { try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} } }
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ startedAt: startedAt.toISOString(), endedAt: new Date().toISOString(), exitCode: timedOut ? null : code, status: timedOut ? 'timeout' : code === 0 ? 'success' : 'failure', stdout, stderr });
    });
  });
}

function readEnvValue(file, names) {
  try {
    const content = fs.readFileSync(file, 'utf8');
    for (const line of content.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (match && names.includes(match[1])) return match[2].replace(/^("|')|("|')$/g, '');
    }
  } catch {}
  return '';
}

function findWebhook(claudeDir) {
  for (const name of ['cost-reporter.env', 'cost-monitor.env']) {
    const value = readEnvValue(path.join(claudeDir, name), ['DISCORD_COST_WEBHOOK', 'COST_WEBHOOK']);
    if (value) return value;
  }
  try {
    for (const name of fs.readdirSync(claudeDir).filter((entry) => entry.endsWith('.env')).sort()) {
      const value = readEnvValue(path.join(claudeDir, name), ['DISCORD_COST_WEBHOOK', 'COST_WEBHOOK']);
      if (value) return value;
    }
  } catch {}
  return process.env.DISCORD_COST_WEBHOOK || process.env.COST_WEBHOOK || '';
}

async function notify(webhook, content) {
  console.log(content);
  if (!webhook) return;
  try {
    const response = await fetch(webhook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: content.slice(0, 1900) }), signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  } catch (error) { console.warn(`Discord通知失敗（実行結果には影響しません）: ${error.message}`); }
}

function prNumber(output) {
  const matches = String(output).match(/(?:PR\s*#|pull\/)(\d+)/gi) ?? [];
  const last = matches.at(-1);
  return last?.match(/\d+/)?.[0] ?? '';
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const home = homeDir();
  const claudeDir = path.join(home, '.claude');
  const config = loadConfig(home);
  const autoDir = path.join(claudeDir, 'auto-session');
  const lockFile = path.join(autoDir, '.lock');
  const disabled = fs.existsSync(path.join(autoDir, 'disabled'));
  let lock = {};
  try { lock = JSON.parse(fs.readFileSync(lockFile, 'utf8')); } catch {}
  const age = lock.startedAt ? Date.now() - Date.parse(lock.startedAt) : Infinity;
  const decision = decideRun({ lockExists: fs.existsSync(lockFile), lockPid: lock.pid, lockAgeMs: age, pidAlive: pidIsAlive(lock.pid), disabled });
  if (!decision.run) { console.log(`auto-session: 起動しません (${decision.reason})`); return 0; }

  const nextFile = path.join(claudeDir, 'next-session.md');
  if (!fs.existsSync(nextFile)) { console.log('auto-session: next-session.md がありません'); return 0; }
  const parsed = parseHandoff(fs.readFileSync(nextFile, 'utf8'));
  const detectedHistoryCwd = config.historyCwd || detectHistoryCwd({ projectsDir: path.join(claudeDir, 'projects') });
  if (options.list) {
    parsed.todos.forEach((todo, i) => console.log(`${i + 1}. ${todoExclusionReason(todo) ? `除外: ${todoExclusionReason(todo)}` : '採用'} | ${todo}`));
    return 0;
  }
  const selected = filterTodos(parsed.todos).slice(0, options.count);
  if (!selected.length) { console.log('auto-session: 実行可能な TODO はありません'); return 0; }
  if (options.dry) {
    for (const todo of selected) {
      const repoCwd = pickCwd(todo, fs.existsSync, config.repoByKeyword);
      const historyCwd = fs.existsSync(detectedHistoryCwd) ? detectedHistoryCwd : repoCwd;
      console.log(`TODO: ${todo}\nREPO CWD: ${repoCwd}\nHISTORY CWD: ${historyCwd}\n\n${buildPrompt(todo, parsed.sections, repoCwd)}`);
    }
    return 0;
  }

  fs.mkdirSync(path.join(autoDir, 'runs'), { recursive: true });
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), todo: selected }, null, 2), { flag: 'w' });
  const cleanup = () => { try { fs.unlinkSync(lockFile); } catch {} };
  process.once('exit', cleanup);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { cleanup(); process.exit(130); });
  const results = [];
  try {
    const executable = resolveClaudeExe();
    for (const todo of selected) {
      const repoCwd = pickCwd(todo, fs.existsSync, config.repoByKeyword);
      const historyCwd = fs.existsSync(detectedHistoryCwd) ? detectedHistoryCwd : repoCwd;
      const sessionId = randomUUID();
      const transcript = transcriptPath(historyCwd, sessionId);
      const resumeCommand = `claude --resume ${sessionId}`;
      const startedAt = new Date();
      const record = { todo, cwd: repoCwd, repoCwd, historyCwd, sessionId, transcript, resumeCommand, startedAt: startedAt.toISOString(), status: 'running' };
      const day = localDate(startedAt);
      let n = 1;
      while (fs.existsSync(path.join(autoDir, 'runs', `${day}-${n}.json`))) n += 1;
      const runFile = path.join(autoDir, 'runs', `${day}-${n}.json`);
      fs.writeFileSync(runFile, JSON.stringify(record, null, 2));
      const result = await runChild(executable, buildPrompt(todo, parsed.sections, repoCwd), repoCwd, historyCwd, sessionId, options.timeoutMin * 60_000);
      const stdoutSessionId = extractSessionId(result.stdout);
      if (stdoutSessionId && stdoutSessionId !== sessionId) console.warn(`session_id mismatch: generated=${sessionId} stdout=${stdoutSessionId}; generated UUID を使用します`);
      Object.assign(record, result, { sessionId, transcript, resumeCommand });
      results.push(record);
      fs.writeFileSync(runFile, JSON.stringify(record, null, 2));
    }
  } finally { cleanup(); }

  const day = localDate();
  const lines = [`自動セッション ${day}`];
  for (const result of results) {
    lines.push(notificationLine(result));
  }
  await notify(findWebhook(claudeDir), lines.join('\n'));
  return results.some((result) => result.status === 'failure') ? 1 : 0;
}

if (isEntry(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }).catch((error) => { console.error(`auto-session: ${error.message}`); process.exitCode = 1; });
}
