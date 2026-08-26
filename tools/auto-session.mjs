#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { isEntry } from './is-entry.mjs';

const MARKER = '<!-- NEXT-SESSION v1 -->';
const SIX_HOURS = 6 * 60 * 60 * 1000;
const DEFAULT_REPO = String.raw`C:\Users\uers\Downloads\orgiast-claude-rules`;
const CWD_RULES = [
  ['ブース制作', String.raw`C:\Users\uers\Downloads\ブース制作アプリ`],
  ['aujust', String.raw`C:\Users\uers\Downloads\aujust-sales-automation`],
];

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
  if (exists(DEFAULT_REPO)) return DEFAULT_REPO;
  return path.resolve(import.meta.dirname, '..');
}

export function pickCwd(todoText, exists = fs.existsSync) {
  const text = String(todoText);
  const candidate = CWD_RULES.find(([keyword]) => text.includes(keyword))?.[1] ?? DEFAULT_REPO;
  return existingOrDefault(candidate, exists);
}

function numericVersion(entry) {
  const normalized = String(entry).replace(/\\/g, '/');
  const match = normalized.match(/anthropic\.claude-code-([0-9]+(?:\.[0-9]+)*)-win32-x64(?:\/|$)/i);
  return match ? match[1].split('.').map(Number) : null;
}

function compareVersion(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const difference = (a[i] ?? 0) - (b[i] ?? 0);
    if (difference) return difference;
  }
  return 0;
}

export function resolveClaudeExe(entries) {
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

export function buildPrompt(todo, sections, cwd, date = new Date()) {
  const attached = ['対象', '完了条件', '触る前に読む memory'].map((name) => sections[name]).filter(Boolean).join('\n\n');
  const day = date.toISOString().slice(0, 10).replaceAll('-', '');
  return [
    'あなたは無人で起動された自動セッションです。人間は見ていません。質問せず、完了まで自分で進めてください。',
    `## 目的\n${todo}`,
    attached,
    `## 固定の作業規約
- 実装本体は \`node tools/codex-do.mjs "<指示>" --cwd ${cwd}\` で Codex に委譲する（§1.18）。監督は設計・レビュー・検証だけ。
- 他セッションと作業ツリーを共有している。\`git add -A\` / \`git commit -a\` / \`git stash\` / \`git checkout -- .\` は禁止。自分が作成・変更したファイルだけをパス指定で \`git add\` する。着手前とコミット直前に \`git status --porcelain\` を撮り、差分が自分の変更だけであることを確認する。
- ブランチは必ず main から切る。ブランチ名は \`auto/${day}-<短いスラグ>\`。
- \`node --test tools/*.test.mjs\` が緑になるまで直す。
- PR を作り、CI green を確認してから \`gh pr merge --squash\` でマージする。CI が赤なら直し、3回直して赤のままならマージせず PR を残して理由を書いて終了する。
- マージ後、変更が実際に効いているかを実物で検証する。検証できていないものを「完了」と書かない。
- 終了時は ~/.claude/next-session.md の先頭ブロックの該当 TODO 行だけを \`~~…~~ → ✅ <日付> 完了（PR #N）\` に行単位で置換し、ファイル全体を上書きしない。
- 秘匿値を出力しない。
- 外部への送信（メール、社外向け Discord、SNS、顧客連絡）は行わない。`,
    '## 完了報告\n最後に3行以内で「やったこと / 検証したこと / 残ったこと」を出力する。',
  ].filter(Boolean).join('\n\n');
}

function homeDir() {
  return process.env.ORGIAST_HOME || os.homedir();
}

function parseArgs(argv) {
  const options = { count: 1, timeoutMin: 45, dry: false, list: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--dry') options.dry = true;
    else if (argv[i] === '--list') options.list = true;
    else if (argv[i] === '--count') options.count = Math.min(3, Math.max(1, Number(argv[++i]) || 1));
    else if (argv[i] === '--timeout-min') options.timeoutMin = Math.max(1, Number(argv[++i]) || 45);
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
      .filter((entry) => entry.isDirectory() && /^anthropic\.claude-code-.*-win32-x64$/i.test(entry.name))
      .map((entry) => path.join(root, entry.name, 'resources', 'native-binary', 'claude.exe'))
      .filter((entry) => fs.existsSync(entry));
  } catch { return []; }
}

function runChild(executable, prompt, cwd, timeoutMs) {
  return new Promise((resolve) => {
    const startedAt = new Date();
    const child = spawn(executable, ['-p', '', '--output-format', 'json', '--model', 'opus', '--permission-mode', 'acceptEdits', '--add-dir', cwd], {
      cwd, env: { ...process.env, CLAUDE_HEADLESS: '1' }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
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
  if (!webhook) { console.log(content); return; }
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
  const claudeDir = path.join(homeDir(), '.claude');
  const autoDir = path.join(claudeDir, 'auto-session');
  const lockFile = path.join(autoDir, '.lock');
  const disabled = fs.existsSync(path.join(autoDir, 'disabled'));
  let lock = {};
  try { lock = JSON.parse(fs.readFileSync(lockFile, 'utf8')); } catch {}
  const age = lock.startedAt ? Date.now() - Date.parse(lock.startedAt) : Infinity;
  const decision = decideRun({ lockExists: fs.existsSync(lockFile), lockPid: lock.pid, lockAgeMs: age, pidAlive: pidIsAlive(lock.pid), disabled });
  if (!decision.run) { console.log(`auto-session: 起動しません (${decision.reason})`); return 0; }

  const nextFile = path.join(claudeDir, 'next-session.md');
  const parsed = parseHandoff(fs.readFileSync(nextFile, 'utf8'));
  if (options.list) {
    parsed.todos.forEach((todo, i) => console.log(`${i + 1}. ${todoExclusionReason(todo) ? `除外: ${todoExclusionReason(todo)}` : '採用'} | ${todo}`));
    return 0;
  }
  const selected = filterTodos(parsed.todos).slice(0, options.count);
  if (!selected.length) { console.log('auto-session: 実行可能な TODO はありません'); return 0; }
  if (options.dry) {
    for (const todo of selected) {
      const cwd = pickCwd(todo);
      console.log(`TODO: ${todo}\nCWD: ${cwd}\n\n${buildPrompt(todo, parsed.sections, cwd)}`);
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
    const executable = resolveClaudeExe(extensionExecutables());
    for (const todo of selected) {
      const cwd = pickCwd(todo);
      const result = await runChild(executable, buildPrompt(todo, parsed.sections, cwd), cwd, options.timeoutMin * 60_000);
      const record = { todo, cwd, ...result };
      results.push(record);
      const day = result.startedAt.slice(0, 10);
      let n = 1;
      while (fs.existsSync(path.join(autoDir, 'runs', `${day}-${n}.json`))) n += 1;
      fs.writeFileSync(path.join(autoDir, 'runs', `${day}-${n}.json`), JSON.stringify(record, null, 2));
    }
  } finally { cleanup(); }

  const day = new Date().toISOString().slice(0, 10);
  const lines = [`自動セッション ${day}`];
  for (const result of results) {
    const minutes = Math.max(0, Math.round((Date.parse(result.endedAt) - Date.parse(result.startedAt)) / 60_000));
    const pr = prNumber(result.stdout);
    lines.push(`- ${result.todo} | ${result.status}${pr ? ` | PR #${pr}` : ''} | ${minutes}分`);
  }
  await notify(findWebhook(claudeDir), lines.join('\n'));
  return results.some((result) => result.status === 'failure') ? 1 : 0;
}

if (isEntry(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }).catch((error) => { console.error(`auto-session: ${error.message}`); process.exitCode = 1; });
}
