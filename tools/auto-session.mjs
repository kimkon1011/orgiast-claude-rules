#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { isEntry } from './is-entry.mjs';
import { DEFAULT_REPO_MAP, parseRepoMap } from './feedback-to-issues.mjs';

const MARKER = '<!-- NEXT-SESSION v1 -->';
const SIX_HOURS = 6 * 60 * 60 * 1000;
export const DEFAULT_REPO = path.resolve(import.meta.dirname, '..');

export function localDate(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function firstBlockBounds(md) {
  const first = md.indexOf(MARKER);
  if (first < 0) return { start: 0, end: md.length };
  const second = md.indexOf(MARKER, first + MARKER.length);
  return { start: first, end: second < 0 ? md.length : second };
}

export function sectionFrom(block, heading) {
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

export function buildChildArgs(repoCwd, historyCwd) {
  // 2026-08-26 実測: acceptEdits はファイル編集だけを自動承認し、Bash は承認待ちで無人実行が最初のコマンドで止まる。
  // --permission-mode を渡さず ~/.claude/settings.json の既定 auto を継承すると、Bash（git -C ... rev-parse）も通る。
  // 無人の残TODO消化に Opus は過剰で、§1.18 の監督用途は最小限に留めるため既定は Sonnet。
  const model = process.env.ORGIAST_AUTO_SESSION_MODEL || 'sonnet';
  const args = ['-p', '', '--output-format', 'json', '--model', model, '--add-dir', repoCwd];
  if (historyCwd !== repoCwd) args.push('--add-dir', historyCwd);
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

export function buildPrompt(todo, sections, repoCwd, summaryFile, timeoutMin = 60, date = new Date()) {
  const attached = ['対象', '完了条件', '触る前に読む memory'].map((name) => sections[name]).filter(Boolean).join('\n\n');
  const day = localDate(date).replaceAll('-', '');
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
- 進捗は節目ごと（ブランチ作成 / PR 作成 / CI green / マージ / 検証結果 / 残ったこと）に ${summaryFile} へ追記する。このファイルだけは強制終了されても残るので、「やったことは必ずここに書く」。追記は \`>>\` 相当とし、全文を上書きしない。
- 外部の定期実行（GitHub Actions の schedule など）の結果を待つ場合、5分を超えるポーリングをしてはいけない。待ちが必要なら ${summaryFile} に「検証は次回の自動セッションで行う」と追記し、~/.claude/next-session.md の残TODO先頭に検証だけの1行を追加して終了する。
- 開始から ${Math.max(0, timeoutMin - 10)} 分でまとめに入り、サマリ追記と残TODO更新を先に済ませる。
- 終了時は ~/.claude/next-session.md の先頭ブロックの該当 TODO 行だけを \`~~…~~ → ✅ <日付> 完了（PR #N）\` に行単位で置換し、ファイル全体を上書きしない。
- 秘匿値を出力しない。
- 外部への送信（メール、社外向け Discord、SNS、顧客連絡）は行わない。`,
    '## 完了報告\n最後に3行以内で「やったこと / 検証したこと / 残ったこと」を出力する。',
  ].filter(Boolean).join('\n\n');
}

export function feedbackIssueExclusionReason(issue) {
  const labels = Array.isArray(issue?.labels) ? issue.labels : [];
  return labels.some((label) => (typeof label === 'string' ? label : label?.name) === 'in-progress')
    ? 'in-progress（対応中）'
    : '';
}

export function filterFeedbackIssues(issues) {
  return (Array.isArray(issues) ? issues : []).filter((issue) => !feedbackIssueExclusionReason(issue));
}

export function buildFeedbackPrompt(issue, repo, repoCwd, summaryFile, timeoutMin = 60) {
  return `あなたは無人で起動された自動セッションです。人間は見ていません。質問せず、以下のフォーム報告を対応してください。

## 入力
これは社員がアプリ内フォームから報告した内容です。
- リポジトリ: ${repo}
- Issue: #${issue.number}
- タイトル: ${issue.title}
- URL: ${issue.url}

### 本文
${issue.body || '（本文なし）'}

## 作業手順
1. Issue とコードを確認して原因を特定する。
2. 修正し、そのリポジトリのテスト・型チェック・ビルドをすべて通す。
3. 必ず main の最新状態から新しいブランチを切る。main の作業ツリーを直接流用しない。
4. PR を作り、本文に \`Closes #${issue.number}\` を入れる。CI の結果を確認する。

## 禁止事項
- PR をマージしない。
- 本番へデプロイしない。
- main へ直接 push しない。
- 承認は kim が GitHub で行う。承認を代行しない。
- 報告が曖昧で修正内容を特定できない場合、推測で実装しない。Issue に「何が分かれば直せるか」をコメントして終了する。
- 他セッションと作業ツリーを共有しているため、git add -A / git commit -a / git stash / git checkout -- . を使わない。
- 秘匿値をコード、PR、ログへ書かない。

## 実行環境
- 実リポジトリは ${repoCwd}。git は \`git -C ${repoCwd}\`、実装委譲は \`node tools/codex-do.mjs "<指示>" --cwd ${repoCwd}\` のように対象を明示する。
- 作業経過を ${summaryFile} に逐次追記する。PR URL・PRタイトル・CI結果を必ず最後に記録する。
- 5分を超える長時間ポーリングをしてはいけない。開始から ${Math.max(1, timeoutMin - 10)} 分でまとめに入る。

## 完了報告
最後に次の3行で出力してください（作れなければ値に「なし」と理由を書く）。
PR URL: <URL>
PRタイトル: <タイトル>
CI結果: <結果と残ったこと>`;
}

export function feedbackNotifyUrl(base) {
  try {
    const url = new URL(String(base));
    url.pathname = url.pathname.replace(/\/api\/feedback-intake\/?$/, '/api/notify');
    url.search = '';
    url.hash = '';
    return url.href;
  } catch { return ''; }
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

export function recoverSessionId({ dir, startedAt, endedAt, readdir = fs.readdirSync, stat = fs.statSync }) {
  try {
    const lower = Date.parse(startedAt) - 60_000;
    const upper = Date.parse(endedAt) + 60_000;
    if (!Number.isFinite(lower) || !Number.isFinite(upper)) return '';
    return readdir(dir)
      .filter((name) => new RegExp(`^${UUID_PATTERN}\\.jsonl$`).test(name))
      .map((name) => ({ name, birthtimeMs: stat(path.join(dir, name)).birthtimeMs }))
      .filter(({ birthtimeMs }) => birthtimeMs >= lower && birthtimeMs <= upper)
      .sort((a, b) => b.birthtimeMs - a.birthtimeMs)[0]?.name.replace(/\.jsonl$/, '') ?? '';
  } catch { return ''; }
}

export function appendClosedSession(file, sessionId, io = {}) {
  if (!new RegExp(`^${UUID_PATTERN}$`).test(String(sessionId))) return false;
  const read = io.read ?? fs.readFileSync;
  const write = io.write ?? fs.writeFileSync;
  const rename = io.rename ?? fs.renameSync;
  const temporary = `${file}.tmp${process.pid}`;
  try {
    let parsed;
    // close-session と並行していても古いメモリ上の値で上書きしないよう、書く直前に必ず実ファイルを読む。
    try { parsed = JSON.parse(read(file, 'utf8')); } catch { parsed = { ids: [] }; }
    const ids = Array.isArray(parsed?.ids) ? parsed.ids : [];
    if (ids.includes(sessionId)) return false;
    write(temporary, JSON.stringify({ ids: [...ids, sessionId] }, null, 2));
    rename(temporary, file);
    return true;
  } catch {
    try { fs.unlinkSync(temporary); } catch {}
    return false;
  }
}

function parseArgs(argv) {
  const options = { count: 1, feedbackCount: 1, timeoutMin: 60, dry: false, list: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--dry') options.dry = true;
    else if (argv[i] === '--list') options.list = true;
    else if (argv[i] === '--count') options.count = Math.min(3, Math.max(1, Number(argv[++i]) || 1));
    else if (argv[i] === '--feedback-count') options.feedbackCount = Math.min(3, Math.max(1, Number(argv[++i]) || 1));
    else if (argv[i] === '--timeout-min') options.timeoutMin = Math.max(1, Number(argv[++i]) || 60);
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

function runChild(executable, prompt, repoCwd, historyCwd, timeoutMs) {
  return new Promise((resolve) => {
    const startedAt = new Date();
    const child = spawn(executable, buildChildArgs(repoCwd, historyCwd), {
      cwd: historyCwd, env: { ...process.env, CLAUDE_HEADLESS: '1' }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let launchFailed = false;
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => { launchFailed = true; stderr += error.message; });
    child.stdin.on('error', () => {});
    child.stdin.end(prompt, 'utf8');
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
      else { try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} } }
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ startedAt: startedAt.toISOString(), endedAt: new Date().toISOString(), exitCode: timedOut ? null : code, status: timedOut ? 'timeout' : code === 0 ? 'success' : 'failure', launchFailed, stdout, stderr });
    });
  });
}

function shellQuote(value) {
  const text = String(value);
  if (process.platform === 'win32') return `"${text.replace(/%/g, '%%').replace(/"/g, '""')}"`;
  return `'${text.replace(/'/g, `'"'"'`)}'`;
}

function runGh(args) {
  // gh.cmd も扱えるよう shell を使うため、外部入力を含む引数は必ず個別に quote する。
  return spawnSync(['gh', ...args].map(shellQuote).join(' '), { shell: true, encoding: 'utf8', windowsHide: true });
}

function feedbackRepos(mapValue = process.env.FEEDBACK_REPO_MAP || '') {
  return [...new Set(Object.values({ ...DEFAULT_REPO_MAP, ...parseRepoMap(mapValue) }))];
}

function listFeedbackIssues() {
  const probe = runGh(['--version']);
  if (probe.error || probe.status !== 0) return [];
  const found = [];
  for (const repo of feedbackRepos()) {
    const result = runGh(['issue', 'list', '--repo', repo, '--label', 'feedback', '--state', 'open', '--json', 'number,title,url,body,labels']);
    if (result.error || result.status !== 0) {
      console.warn(`auto-session: フォーム報告の取得失敗 repo=${repo}`);
      continue;
    }
    try { found.push(...JSON.parse(result.stdout).map((issue) => ({ ...issue, repo }))); }
    catch { console.warn(`auto-session: フォーム報告のJSON解析失敗 repo=${repo}`); }
  }
  return found;
}

const feedbackRepoCwdCache = new Map();

export function normalizeGitHubRepo(remoteUrl) {
  const normalized = String(remoteUrl ?? '').trim().replace(/\\/g, '/');
  const match = normalized.match(/^(?:(?:https?:\/\/github\.com\/|git@github\.com:))?([^/:]+)\/([^/]+?)(?:\.git)?\/*$/i);
  return match ? `${match[1]}/${match[2]}`.toLowerCase() : '';
}

function feedbackSearchRoots(home = homeDir(), extra = process.env.AUTO_SESSION_REPO_DIRS || '') {
  const downloads = path.join(home, 'Downloads');
  return [...new Set([
    downloads,
    path.join(downloads, 'CLAUDE.md配布'),
    ...String(extra).split(';').map((entry) => entry.trim()).filter(Boolean).map((entry) => path.resolve(entry)),
  ])];
}

function repositoryCandidates(roots, io) {
  const candidates = [];
  for (const root of roots) {
    // 深い再帰はバッチ全体を遅くするため、指定された探索先自身と直下だけを見る。
    candidates.push(root);
    try {
      candidates.push(...io.readdir(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(root, entry.name)));
    } catch {}
  }
  return [...new Set(candidates)];
}

export function feedbackRepoCwd(repo, options = {}) {
  const target = normalizeGitHubRepo(repo);
  const useCache = !options.roots && !options.io;
  if (useCache && feedbackRepoCwdCache.has(target)) return feedbackRepoCwdCache.get(target);
  const io = {
    exists: options.io?.exists ?? fs.existsSync,
    readdir: options.io?.readdir ?? fs.readdirSync,
    remoteUrl: options.io?.remoteUrl ?? ((candidate) => spawnSync('git', ['-C', candidate, 'remote', 'get-url', 'origin'], { encoding: 'utf8', windowsHide: true })),
  };
  const roots = options.roots ?? feedbackSearchRoots();
  let found = '';
  for (const candidate of repositoryCandidates(roots, io)) {
    if (!io.exists(path.join(candidate, '.git'))) continue;
    const result = io.remoteUrl(candidate);
    if (!result?.error && result?.status === 0 && normalizeGitHubRepo(result.stdout) === target) { found = candidate; break; }
  }
  const fallback = path.join(homeDir(), 'Downloads', String(repo).split('/').at(-1));
  const resolved = found || fallback;
  if (useCache) feedbackRepoCwdCache.set(target, resolved);
  return resolved;
}

function ensureFeedbackRepo(repo) {
  const repoCwd = feedbackRepoCwd(repo);
  if (fs.existsSync(repoCwd)) return { repoCwd, ok: true, error: '' };
  // 対象を標準リポジトリへ誤吸着させず、存在しない場合だけ正規の GitHub リポジトリを取得する。
  console.warn(`auto-session: 既存の作業ツリーが見つからないため新規クローンします repo=${repo} cwd=${repoCwd}`);
  const cloned = runGh(['repo', 'clone', repo, repoCwd]);
  return { repoCwd, ok: !cloned.error && cloned.status === 0 && fs.existsSync(repoCwd), error: cloned.stderr || cloned.error?.message || '' };
}

function setInProgress(issue, add) {
  if (add) runGh(['label', 'create', 'in-progress', '--repo', issue.repo, '--color', 'FBCA04', '--description', '自動セッションが対応中']);
  return runGh(['issue', 'edit', String(issue.number), '--repo', issue.repo, add ? '--add-label' : '--remove-label', 'in-progress']);
}

function relayConfig(claudeDir) {
  let url = process.env.FEEDBACK_RELAY_URL || '';
  let secret = process.env.FEEDBACK_RELAY_SECRET || '';
  try {
    for (const name of fs.readdirSync(claudeDir).filter((entry) => entry.endsWith('.env')).sort()) {
      if (!url) url = readEnvValue(path.join(claudeDir, name), ['FEEDBACK_RELAY_URL']);
      if (!secret) secret = readEnvValue(path.join(claudeDir, name), ['FEEDBACK_RELAY_SECRET']);
    }
  } catch {}
  return { url: feedbackNotifyUrl(url), secret };
}

async function notifyFeedback(config, payload) {
  if (!config.url || !config.secret) { console.log('auto-session: フォーム報告の中継が未設定なので通知をスキップ'); return; }
  try {
    const response = await fetch(config.url, { method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${config.secret}` }, body: JSON.stringify(payload), signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  } catch (error) { console.warn(`auto-session: フォーム報告の通知失敗 (${error.message})`); }
}

function feedbackPrDetails(text) {
  const source = String(text ?? '');
  const url = source.match(/https:\/\/github\.com\/[^\s)]+\/pull\/\d+/)?.[0] ?? '';
  const title = source.match(/(?:PRタイトル|PR title)\s*[:：]\s*(.+)/i)?.[1]?.trim() ?? '（PRタイトルを取得できず）';
  const ci = source.match(/CI(?:結果)?\s*[:：]\s*(.+)/i)?.[1]?.trim() ?? '（CI結果を取得できず）';
  return { url, title, ci };
}

function enrichFeedbackPrDetails(details) {
  if (!details.url) return details;
  const result = runGh(['pr', 'view', details.url, '--json', 'title,statusCheckRollup']);
  if (result.error || result.status !== 0) return details;
  try {
    const parsed = JSON.parse(result.stdout);
    const checks = Array.isArray(parsed.statusCheckRollup) ? parsed.statusCheckRollup : [];
    const states = checks.map((check) => check.conclusion || check.state || check.status).filter(Boolean);
    return {
      ...details,
      title: parsed.title || details.title,
      ci: states.length ? states.join(', ') : details.ci,
    };
  } catch { return details; }
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

function failureReason(result) {
  if (!['timeout', 'failure'].includes(result.status) || !String(result.stderr ?? '').trim()) return '';
  const sanitized = String(result.stderr)
    .replace(/\r?\n/g, ' ')
    .replace(/(authorization\s*:\s*bearer\s+)\S+/gi, '$1[REDACTED]')
    .replace(/((?:token|secret|password|api[_-]?key)\s*[=:]\s*)\S+/gi, '$1[REDACTED]')
    .replace(/https:\/\/discord(?:app)?\.com\/api\/webhooks\/\S+/gi, '[REDACTED_WEBHOOK]')
    .trim();
  return sanitized ? ` | 理由: ${sanitized.slice(-200)}` : '';
}

export function formatResultLine(result, minutes, pr = '') {
  return `- ${result.todo} | ${result.status}${pr ? ` | PR #${pr}` : ''} | ${minutes}分 | transcript: ${result.transcript || '(取得できず)'} | resume: ${result.resumeCommand || '(取得できず)'}${failureReason(result)}`;
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
  // フォーム報告は next-session.md と独立した入力源なので、片方が無くてももう片方を止めない。
  const parsed = fs.existsSync(nextFile) ? parseHandoff(fs.readFileSync(nextFile, 'utf8')) : { block: '', todos: [], sections: {} };
  const feedbackIssues = listFeedbackIssues();
  const detectedHistoryCwd = config.historyCwd || detectHistoryCwd({ projectsDir: path.join(claudeDir, 'projects') });
  if (options.list) {
    parsed.todos.forEach((todo, i) => console.log(`[next-session] ${i + 1}. ${todoExclusionReason(todo) ? `除外: ${todoExclusionReason(todo)}` : '採用'} | ${todo}`));
    feedbackIssues.forEach((issue) => console.log(`[feedback] ${issue.repo}#${issue.number}. ${feedbackIssueExclusionReason(issue) ? `除外: ${feedbackIssueExclusionReason(issue)}` : '採用'} | ${issue.title}`));
    if (!feedbackIssues.length) console.log('[feedback] 0件（対象リポジトリに未対応 Issue なし、または gh なし）');
    return 0;
  }
  const selected = filterTodos(parsed.todos).slice(0, options.count);
  const selectedFeedback = filterFeedbackIssues(feedbackIssues).slice(0, options.feedbackCount);
  if (!selected.length && !selectedFeedback.length) { console.log('auto-session: 実行可能な TODO とフォーム報告はありません'); return 0; }
  if (options.dry) {
    for (const [index, todo] of selected.entries()) {
      const repoCwd = pickCwd(todo, fs.existsSync, config.repoByKeyword);
      const historyCwd = fs.existsSync(detectedHistoryCwd) ? detectedHistoryCwd : repoCwd;
      const summaryFile = path.join(autoDir, 'runs', `dry-${index + 1}.summary.md`);
      console.log(`[next-session]\nTODO: ${todo}\nREPO CWD: ${repoCwd}\nHISTORY CWD: ${historyCwd}\n\n${buildPrompt(todo, parsed.sections, repoCwd, summaryFile, options.timeoutMin)}`);
    }
    for (const [index, issue] of selectedFeedback.entries()) {
      const repoCwd = feedbackRepoCwd(issue.repo);
      const historyCwd = fs.existsSync(detectedHistoryCwd) ? detectedHistoryCwd : repoCwd;
      const summaryFile = path.join(autoDir, 'runs', `dry-feedback-${index + 1}.summary.md`);
      console.log(`[feedback]\nISSUE: ${issue.repo}#${issue.number} ${issue.title}\nREPO CWD: ${repoCwd}\nHISTORY CWD: ${historyCwd}\n\n${buildFeedbackPrompt(issue, issue.repo, repoCwd, summaryFile, options.timeoutMin)}`);
    }
    if (!selectedFeedback.length) console.log('[feedback]\nDRY対象: 0件');
    return 0;
  }

  fs.mkdirSync(path.join(autoDir, 'runs'), { recursive: true });
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), todo: selected, feedback: selectedFeedback.map(({ repo, number }) => `${repo}#${number}`) }, null, 2), { flag: 'w' });
  const cleanup = () => { try { fs.unlinkSync(lockFile); } catch {} };
  process.once('exit', cleanup);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { cleanup(); process.exit(130); });
  const results = [];
  const feedbackResults = [];
  try {
    const executable = resolveClaudeExe();
    for (const todo of selected) {
      const repoCwd = pickCwd(todo, fs.existsSync, config.repoByKeyword);
      const historyCwd = fs.existsSync(detectedHistoryCwd) ? detectedHistoryCwd : repoCwd;
      const day = localDate();
      let n = 1;
      let runFile;
      let summaryFile;
      // サマリ自体を排他的に作ることで、子を起動する前に同日の番号を確実に所有する。
      while (true) {
        runFile = path.join(autoDir, 'runs', `${day}-${n}.json`);
        summaryFile = path.join(autoDir, 'runs', `${day}-${n}.summary.md`);
        if (fs.existsSync(runFile)) { n += 1; continue; }
        try { fs.writeFileSync(summaryFile, '', { flag: 'wx' }); break; } catch (error) {
          if (error?.code !== 'EEXIST') throw error;
          n += 1;
        }
      }
      const result = await runChild(executable, buildPrompt(todo, parsed.sections, repoCwd, summaryFile, options.timeoutMin), repoCwd, historyCwd, options.timeoutMin * 60_000);
      const stdoutSessionId = extractSessionId(result.stdout);
      const transcriptDir = path.dirname(transcriptPath(historyCwd, '00000000-0000-0000-0000-000000000000'));
      const recoveredSessionId = stdoutSessionId ? '' : recoverSessionId({ dir: transcriptDir, startedAt: result.startedAt, endedAt: result.endedAt });
      const sessionId = stdoutSessionId || recoveredSessionId;
      const sessionIdSource = stdoutSessionId ? 'stdout' : recoveredSessionId ? 'recovered' : '';
      const transcript = transcriptPath(historyCwd, sessionId);
      const resumeCommand = sessionId ? `claude --resume ${sessionId}` : '';
      let summary = '';
      try { summary = fs.readFileSync(summaryFile, 'utf8'); } catch {}
      // 完走したものだけ「閉じた」扱いにする。timeout / failure は purge に退避させると
      // claude --resume で拾えなくなり、途中まで進んだ作業を追えなくなるため残す。
      const closedRegistered = result.status === 'success'
        ? appendClosedSession(path.join(claudeDir, 'closed-sessions.json'), sessionId)
        : false;
      const record = { todo, cwd: repoCwd, repoCwd, historyCwd, summaryFile, summary, sessionId, sessionIdSource, transcript, resumeCommand, closedRegistered, ...result };
      results.push(record);
      fs.writeFileSync(runFile, JSON.stringify(record, null, 2));
    }
    for (const issue of selectedFeedback) {
      const prepared = ensureFeedbackRepo(issue.repo);
      if (!prepared.ok) {
        feedbackResults.push({ issue, status: 'failure', launchFailed: true, stderr: prepared.error || '対象リポジトリを取得できませんでした' });
        continue;
      }
      const marked = setInProgress(issue, true);
      if (marked.error || marked.status !== 0) {
        feedbackResults.push({ issue, status: 'failure', launchFailed: true, stderr: marked.stderr || 'in-progress ラベルを付けられませんでした' });
        continue;
      }
      const repoCwd = prepared.repoCwd;
      const historyCwd = fs.existsSync(detectedHistoryCwd) ? detectedHistoryCwd : repoCwd;
      const stamp = `${localDate()}-feedback-${issue.repo.split('/').at(-1)}-${issue.number}`;
      const runFile = path.join(autoDir, 'runs', `${stamp}.json`);
      const summaryFile = path.join(autoDir, 'runs', `${stamp}.summary.md`);
      fs.writeFileSync(summaryFile, '', { flag: 'a' });
      const result = await runChild(executable, buildFeedbackPrompt(issue, issue.repo, repoCwd, summaryFile, options.timeoutMin), repoCwd, historyCwd, options.timeoutMin * 60_000);
      let summary = '';
      try { summary = fs.readFileSync(summaryFile, 'utf8'); } catch {}
      const record = { source: 'feedback', issue, cwd: repoCwd, summaryFile, summary, ...result };
      feedbackResults.push(record);
      fs.writeFileSync(runFile, JSON.stringify(record, null, 2));
      // 起動そのものに失敗した場合だけ、次回が再試行できるよう対応中ラベルを戻す。
      if (result.launchFailed) setInProgress(issue, false);
    }
  } finally { cleanup(); }

  const day = localDate();
  const lines = [`自動セッション ${day}`];
  for (const result of results) {
    const minutes = Math.max(0, Math.round((Date.parse(result.endedAt) - Date.parse(result.startedAt)) / 60_000));
    // timeout で kill されると stdout は丸ごと失われるので、生き残るサマリ側も併せて走査する。
    const pr = prNumber(`${result.stdout}
${result.summary ?? ''}`);
    lines.push(`${formatResultLine(result, minutes, pr)}\n${result.summary ? `summary:\n${result.summary.slice(0, 700)}` : 'summary: (記録なし)'}`);
  }
  await notify(findWebhook(claudeDir), lines.join('\n'));
  const relay = relayConfig(claudeDir);
  let feedbackSucceeded = 0;
  for (const result of feedbackResults) {
    const details = enrichFeedbackPrDetails(feedbackPrDetails(`${result.stdout ?? ''}\n${result.summary ?? ''}`));
    // 子の終了コードにかかわらず、PR が存在するなら kim に承認導線を必ず渡す。
    if (details.url) {
      feedbackSucceeded += 1;
      await notifyFeedback(relay, { title: 'フォーム報告の修正PRができました', body: `#${result.issue.number} ${result.issue.title}\n${details.title}\nCI: ${details.ci}`, url: details.url });
    }
  }
  const feedbackFailed = feedbackResults.length - feedbackSucceeded;
  if (feedbackFailed > 0) await notifyFeedback(relay, { title: 'フォーム報告の自動対応結果', body: `${feedbackResults.length}件試行し、${feedbackFailed}件でPRを作成できませんでした`, url: '' });
  return results.some((result) => result.status === 'failure') || feedbackFailed > 0 ? 1 : 0;
}

if (isEntry(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }).catch((error) => { console.error(`auto-session: ${error.message}`); process.exitCode = 1; });
}
