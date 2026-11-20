#!/usr/bin/env node
// GitHub リポジトリのまとまったコード修正を、Cursor cloud agent 向けの issue にする。
// 使うのはこの PC に入っている gh の既存ログインだけ。API キーも従量課金のサービスも使わない。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isEntry } from './is-entry.mjs';

export const QUEUED_LABEL = 'cursor-agent';
export const RUNNING_LABEL = 'cursor-agent:running';
export const DONE_LABEL = 'cursor-agent:done';
export const CONTRACT_LABELS = [QUEUED_LABEL, RUNNING_LABEL, DONE_LABEL];

const LABEL_META = {
  [QUEUED_LABEL]: { color: '5319E7', description: 'Cursor cloud agent queue' },
  [RUNNING_LABEL]: { color: 'FBCA04', description: 'Cursor cloud agent running' },
  [DONE_LABEL]: { color: '0E8A16', description: 'Cursor cloud agent opened a PR' },
};

const SECRET = /(?:sk-[A-Za-z0-9]{8,}|ghp_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{10,}|xox[baprs]-[A-Za-z0-9-]{8,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;

export function usage() {
  return [
    '使い方: node tools/cursor-handoff.mjs --repo <owner/name> --title "<題>" (--body "<本文>" | --body-file <path>) --from "<アカウント / PC / セッション>" [--dry-run]',
    '本文に書くもの: 目的、受け入れ条件、触るファイル・範囲、テスト方法。秘密は書かない。',
    '--dry-run は issue を作らず、gh も呼ばない。',
    'ラベル cursor-agent は待ち行列。着手は cursor-agent:running、完了は cursor-agent:done。PR 本文に Closes #N。',
  ].join('\n');
}

function take(args, flag) {
  const value = args.shift();
  if (value === undefined || value.startsWith('--')) throw new Error(`${flag} の値がありません。\n${usage()}`);
  return value;
}

export function parseArgs(argv) {
  const out = { repo: '', title: '', body: '', bodyFile: '', from: '', dryRun: false, help: false };
  const args = [...argv];
  while (args.length) {
    const token = args.shift();
    const eq = token.startsWith('--') ? token.indexOf('=') : -1;
    const flag = eq === -1 ? token : token.slice(0, eq);
    const inline = eq === -1 ? null : token.slice(eq + 1);
    const value = () => (inline === null ? take(args, flag) : inline);
    if (flag === '--dry-run') out.dryRun = true;
    else if (flag === '--help' || flag === '-h') out.help = true;
    else if (flag === '--repo') out.repo = value();
    else if (flag === '--title') out.title = value();
    else if (flag === '--body') out.body = value();
    else if (flag === '--body-file') out.bodyFile = value();
    else if (flag === '--from') out.from = value();
    else throw new Error(`不明な引数: ${token}\n${usage()}`);
  }
  return out;
}

export function normalizeRepo(input) {
  let repo = String(input || '').trim();
  repo = repo.replace(/^git@github\.com:/, '');
  repo = repo.replace(/^ssh:\/\/git@github\.com\//, '');
  repo = repo.replace(/^https?:\/\/github\.com\//, '');
  repo = repo.replace(/^github\.com\//, '');
  repo = repo.replace(/\.git$/, '').replace(/\/+$/, '');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || repo.includes('..')) {
    throw new Error(`--repo は owner/name にしてください（受け取った値: ${String(input || '').trim() || '(空)'}）`);
  }
  return repo;
}

function rejectSecrets(text, where) {
  if (SECRET.test(text)) {
    throw new Error(`${where}にトークンや秘密鍵らしい文字列があります。issue には秘密を書かず、取り除いてからやり直してください。`);
  }
}

export function buildIssueBody({ from, body }) {
  const text = String(body || '').replace(/\r\n/g, '\n').trim();
  if (!text) throw new Error('本文が空です。--body または --body-file に、目的・受け入れ条件・触る範囲・テスト方法を書いてください。');
  rejectSecrets(text, '本文');
  return [
    '<!-- cursor-lane -->',
    `依頼元: ${from}`,
    '',
    text,
    '',
    '---',
    'Cursor lane 契約（orgiast-claude-rules の docs/cursor-lane.md）:',
    '- ラベル `cursor-agent` は待ち行列。着手したら `cursor-agent:running`、PR ができたら `cursor-agent:done` に付け替える。',
    '- PR 本文に `Closes #<この issue の番号>` を書く。',
    '',
  ].join('\n');
}

export function loadBody(opts, readFile = fs.readFileSync) {
  if (opts.body && opts.bodyFile) throw new Error('--body と --body-file は同時に指定できません。');
  if (!opts.body && !opts.bodyFile) throw new Error(`--body または --body-file が必要です。\n${usage()}`);
  if (!opts.bodyFile) return opts.body;
  try {
    return readFile(opts.bodyFile, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`--body-file が見つかりません: ${opts.bodyFile}`);
    throw error;
  }
}

function validate(opts) {
  const missing = [];
  if (!String(opts.repo || '').trim()) missing.push('--repo');
  if (!String(opts.title || '').trim()) missing.push('--title');
  if (!String(opts.from || '').trim()) missing.push('--from');
  if (missing.length) throw new Error(`必須引数がありません: ${missing.join(', ')}\n${usage()}`);
  if (/[\r\n]/.test(opts.title) || opts.title.trim().length > 200) throw new Error('--title は改行なし・200文字以内にしてください。');
  if (/[\r\n]/.test(opts.from)) throw new Error('--from は1行にしてください（アカウント / PC / セッション）。');
  rejectSecrets(opts.title, 'タイトル');
  rejectSecrets(opts.from, '依頼元');
}

function clip(text) {
  return String(text || '').replace(SECRET, '[redacted]').trim().slice(0, 500);
}

function gh(spawnImpl, args, { input } = {}) {
  const result = spawnImpl('gh', args, {
    encoding: 'utf8',
    input,
    windowsHide: true,
    timeout: 60000,
    env: { ...process.env, GH_PROMPT_DISABLED: '1', GCM_INTERACTIVE: 'never' },
  });
  if (result?.error) {
    if (result.error.code === 'ENOENT') {
      const error = new Error('gh が見つかりません。GitHub CLI をインストールし、`gh auth login` で認証してください。');
      error.code = 'GH_MISSING';
      throw error;
    }
    if (result.error.code === 'ETIMEDOUT' || result.signal) {
      throw new Error('gh が時間内に終わりませんでした。認証のプロンプト待ちになっていないか確認してください。');
    }
    throw result.error;
  }
  return result || { status: 1, stdout: '', stderr: '' };
}

export function assertGhReady(spawnImpl) {
  const version = gh(spawnImpl, ['--version']);
  if (version.status !== 0) {
    const error = new Error(`gh が見つかりません。GitHub CLI をインストールし、\`gh auth login\` で認証してください。${clip(version.stderr || version.stdout) ? `\n${clip(version.stderr || version.stdout)}` : ''}`);
    error.code = 'GH_MISSING';
    throw error;
  }
  const auth = gh(spawnImpl, ['auth', 'status']);
  if (auth.status !== 0) {
    const detail = clip(auth.stderr || auth.stdout);
    const error = new Error(`gh が未認証です。\`gh auth login\` を実行してからやり直してください。${detail ? `\n${detail}` : ''}`);
    error.code = 'GH_UNAUTHENTICATED';
    throw error;
  }
}

function labelNames(stdout) {
  let parsed;
  try { parsed = JSON.parse(stdout || '[]'); }
  catch { throw new Error('gh label list の応答を読めませんでした。'); }
  if (!Array.isArray(parsed)) throw new Error('gh label list の応答を読めませんでした。');
  return parsed.map((item) => item?.name).filter(Boolean);
}

export function ensureLabels(spawnImpl, repo) {
  const listed = gh(spawnImpl, ['label', 'list', '--repo', repo, '--search', 'cursor-agent', '--limit', '100', '--json', 'name']);
  if (listed.status !== 0) {
    throw new Error(`ラベル一覧の取得に失敗しました（${repo}）。\n${clip(listed.stderr || listed.stdout)}`);
  }
  const names = new Set(labelNames(listed.stdout));
  const created = [];
  for (const name of CONTRACT_LABELS) {
    if (names.has(name)) continue;
    const meta = LABEL_META[name];
    const made = gh(spawnImpl, ['label', 'create', name, '--repo', repo, '--color', meta.color, '--description', meta.description]);
    if (made.status !== 0 && !/already exists/i.test(`${made.stderr || ''}\n${made.stdout || ''}`)) {
      throw new Error(`ラベル ${name} を作れませんでした（${repo}）。\n${clip(made.stderr || made.stdout)}`);
    }
    created.push(name);
  }
  return created;
}

export function createIssue(spawnImpl, { repo, title, body }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-handoff-'));
  const file = path.join(dir, 'body.md');
  try {
    fs.writeFileSync(file, body, { encoding: 'utf8', mode: 0o600 });
    const result = gh(spawnImpl, ['issue', 'create', '--repo', repo, '--title', title, '--body-file', file, '--label', QUEUED_LABEL]);
    if (result.status !== 0) {
      throw new Error(`issue の作成に失敗しました（${repo}）。\n${clip(result.stderr || result.stdout)}`);
    }
    const url = String(result.stdout || '').split('\n').map((line) => line.trim()).filter((line) => /^https?:\/\//.test(line)).pop() || '';
    if (!url) throw new Error(`issue を作成したあとの URL がありません。\n${clip(result.stdout || result.stderr)}`);
    return { url };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export function formatDryRun({ repo, title, from, body }) {
  return [
    'cursor-handoff: dry-run（issue は作りません。gh は呼びません）',
    `repo: ${repo}`,
    `title: ${title}`,
    `from: ${from}`,
    `labels-ensure: ${CONTRACT_LABELS.join(', ')}`,
    `issue-label: ${QUEUED_LABEL}`,
    '--- body ---',
    body,
  ].join('\n');
}

export function run(argv, { spawnImpl = spawnSync, readFile = fs.readFileSync, stdout = console.log } = {}) {
  const opts = parseArgs(argv);
  if (opts.help) {
    stdout(usage());
    return { help: true, dryRun: true };
  }
  validate(opts);
  const repo = normalizeRepo(opts.repo);
  const title = opts.title.trim();
  const from = opts.from.trim();
  const body = buildIssueBody({ from, body: loadBody(opts, readFile) });
  if (opts.dryRun) {
    stdout(formatDryRun({ repo, title, from, body }));
    return { dryRun: true, repo, title, from, body };
  }
  assertGhReady(spawnImpl);
  const createdLabels = ensureLabels(spawnImpl, repo);
  const issue = createIssue(spawnImpl, { repo, title, body });
  stdout(issue.url);
  return { dryRun: false, repo, title, from, body, createdLabels, url: issue.url };
}

if (isEntry(import.meta.url)) {
  try {
    run(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
