#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { getDriveToken } from './lib/drive-auth.mjs';
import { isFailureLine } from './nightly-health.mjs';
import { isEntry } from './is-entry.mjs';

const BEGIN = '<!-- OPEN-WORK:BEGIN -->';
const END = '<!-- OPEN-WORK:END -->';
const REPO = 'kimkon1011/orgiast-claude-rules';
const SHEET_ID = '1WtsSiDlId8EgyzA15pJbeCGfvMHUgBqrUMmucax4A24';
const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const execFileAsync = promisify(execFile);

function reason(error) {
  return String(error?.message || error || '不明なエラー').replace(/\s+/g, ' ').trim();
}

function jstStamp(date) {
  const parts = new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).formatToParts(date);
  const p = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${p.year}/${p.month}/${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

function jstDate(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date);
  const p = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

function outputOf(result) {
  return typeof result === 'string' ? result : String(result?.stdout || '');
}

async function command(execImpl, commandName, args, options = {}) {
  return outputOf(await execImpl(commandName, args, { encoding: 'utf8', ...options }));
}

async function collectPrs(execImpl) {
  const text = await command(execImpl, 'gh', ['pr', 'list', '--repo', REPO, '--json', 'number,title,updatedAt,isDraft', '--limit', '50']);
  const value = JSON.parse(text || '[]');
  if (!Array.isArray(value)) throw new Error('gh の応答が配列ではありません');
  return value.map((pr) => ({
    text: `PR #${pr.number} ${pr.title}${pr.isDraft ? '（下書き）' : ''}（更新 ${pr.updatedAt || '不明'}）`,
    raw: pr
  }));
}

async function collectBranches(execImpl, repoDir) {
  const refs = await command(execImpl, 'git', ['ls-remote', '--heads', 'origin', 'refs/heads/auto/*'], { cwd: repoDir });
  await command(execImpl, 'git', ['fetch', '--no-write-fetch-head', 'origin', 'refs/heads/auto/*:refs/remotes/origin/auto/*'], { cwd: repoDir });
  const names = refs.split(/\r?\n/).map((line) => line.match(/refs\/heads\/(auto\/\S+)$/)?.[1]).filter(Boolean);
  const items = [];
  for (const name of names) {
    const ahead = Number((await command(execImpl, 'git', ['rev-list', '--count', `origin/main..origin/${name}`], { cwd: repoDir })).trim());
    const behind = Number((await command(execImpl, 'git', ['rev-list', '--count', `origin/${name}..origin/main`], { cwd: repoDir })).trim());
    if (!Number.isFinite(ahead) || !Number.isFinite(behind)) throw new Error(`${name} のcommit数を解釈できません`);
    if (ahead < 1) continue;
    const committedAt = (await command(execImpl, 'git', ['log', '-1', '--format=%cI', `origin/${name}`], { cwd: repoDir })).trim();
    const warning = behind > 0 ? ' ⚠️ そのままマージ不可（main へ移植が必要）' : '';
    const detail = ` — 先行 ${ahead} / 遅れ ${behind}（最終コミット ${committedAt || '不明'}）`;
    const maxBaseLength = 98 - Array.from(warning).length;
    const base = truncate(`${name}${detail}`, maxBaseLength);
    items.push({ text: `${base}${warning}`, raw: { name, ahead, behind, committedAt }, mergeable: behind === 0 });
  }
  return items;
}

async function collectTasks(fetchImpl, getToken) {
  const token = await getToken({ scope: SHEETS_SCOPE });
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(SHEET_ID)}/values/${encodeURIComponent('タスク!A2:O')}`;
  const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`Sheets API エラー: HTTP ${response.status} ${await response.text()}`);
  const body = await response.json();
  const rows = Array.isArray(body.values) ? body.values : [];
  return rows.filter((row) => row.some((cell) => String(cell || '').trim()) && String(row[12] || '').trim() !== '完了').map((row) => ({
    text: `${String(row[2] || 'rankなし')} ${String(row[0] || 'IDなし')} ${String(row[5] || 'タイトルなし')}（状態: ${String(row[12] || '未設定')}）`,
    raw: row,
    rank: String(row[2] || '').trim()
  }));
}

function collectTodos(home) {
  const file = path.join(home, '.claude', 'next-session.md');
  let text;
  try { text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''); }
  catch (error) { if (error?.code === 'ENOENT') return { items: [], method: '該当なし（next-session.md は散文のみ）' }; throw error; }
  const lines = text.split(/\r?\n/);
  const checkboxLines = lines.map((line) => line.match(/^\s*[-*+]\s+\[([ xX])\]\s+(.+\S|\S)\s*$/)).filter(Boolean);
  if (checkboxLines.length) {
    return {
      items: checkboxLines.filter((match) => match[1] === ' ').map((match) => ({ text: match[2], raw: match[2] })),
      method: '未チェックのチェックボックス'
    };
  }
  const heading = lines.findIndex((line) => /^#{1,6}\s+.*(?:TODO|残)/i.test(line));
  if (heading >= 0) {
    const sectionLines = lines.slice(heading + 1);
    const nextHeading = sectionLines.findIndex((line) => /^#{1,6}\s+/.test(line));
    const body = nextHeading < 0 ? sectionLines : sectionLines.slice(0, nextHeading);
    const items = body.map((line) => line.match(/^(?:[-*+] |\d+[.)]\s+)(.+\S|\S)\s*$/)?.[1]).filter(Boolean)
      .map((value) => ({ text: value, raw: value }));
    return { items, method: 'TODO・残見出し節の箇条書き' };
  }
  return { items: [], method: '該当なし（next-session.md は散文のみ）' };
}

function collectNightly(home, now) {
  const file = path.join(home, '.claude', 'logs', `nightly-batch-${jstDate(now)}.log`);
  let text;
  try { text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''); }
  catch (error) { if (error?.code === 'ENOENT') return []; throw error; }
  return text.split(/\r?\n/).filter((line) => /NG/i.test(line) && isFailureLine(line))
    .map((line) => ({ text: line.trim(), raw: line }));
}

function truncate(value, maxLength = 98) {
  const chars = Array.from(String(value).replace(/\s+/g, ' ').trim());
  return chars.length <= maxLength ? chars.join('') : `${chars.slice(0, Math.max(0, maxLength - 1)).join('')}…`;
}

function section(title, bucket, limit, extra = '', note = '') {
  if (bucket.error) return `### ${title}\n${truncate(`取得失敗: ${bucket.error}`, 100)}`;
  const lines = [`### ${title}`, `件数: ${bucket.items.length}件${extra}`];
  if (note) lines.push(note);
  for (const item of bucket.items.slice(0, limit)) lines.push(`- ${truncate(item.text)}`);
  if (bucket.items.length > limit) lines.push(`…ほか ${bucket.items.length - limit}件`);
  return lines.join('\n');
}

function replaceSection(existing, block) {
  const start = existing.indexOf(BEGIN);
  const end = start < 0 ? -1 : existing.indexOf(END, start + BEGIN.length);
  if (start >= 0 && end >= 0) return `${existing.slice(0, start)}${block}${existing.slice(end + END.length)}`;
  const separator = existing && !existing.endsWith('\n') ? '\n\n' : existing ? '\n' : '';
  return `${existing}${separator}${block}\n`;
}

export async function runOpenWork(options = {}) {
  const home = options.home || os.homedir();
  const now = options.now instanceof Date ? options.now : new Date();
  const execImpl = options.execImpl || execFileAsync;
  const fetchImpl = options.fetchImpl || fetch;
  const getToken = options.getToken || getDriveToken;
  const args = options.args || [];
  const log = options.log || console.log;
  const repoDir = options.repoDir || path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const parsedLimit = Number(args[args.indexOf('--limit') + 1]);
  const limit = args.includes('--limit') && Number.isInteger(parsedLimit) && parsedLimit > 0 ? parsedLimit : 10;
  const buckets = Object.fromEntries(['PR', 'ブランチ', 'タスク', 'TODO', '夜間異常'].map((name) => [name, { items: [], error: '' }]));
  const attempt = async (name, fn) => { try { buckets[name].items = await fn(); } catch (error) { buckets[name].error = reason(error); } };
  await Promise.all([
    attempt('PR', () => collectPrs(execImpl)),
    attempt('ブランチ', () => collectBranches(execImpl, repoDir)),
    attempt('タスク', () => collectTasks(fetchImpl, getToken)),
    attempt('TODO', async () => {
      const result = collectTodos(home);
      buckets.TODO.method = result.method;
      return result.items;
    }),
    attempt('夜間異常', async () => collectNightly(home, now))
  ]);
  const ranks = { P1: 0, P2: 0, P3: 0 };
  for (const task of buckets['タスク'].items) if (task.rank in ranks) ranks[task.rank]++;
  const failures = Object.entries(buckets).filter(([, bucket]) => bucket.error).map(([name]) => name);
  const counts = Object.fromEntries(Object.entries(buckets).map(([name, bucket]) => [name, bucket.items.length]));
  let summary = `ok:PR${counts.PR} ブランチ${counts['ブランチ']} タスク${counts['タスク']}(P1 ${ranks.P1}) TODO${counts.TODO} 夜間異常${counts['夜間異常']}`;
  if (failures.length) summary += ` / 取得失敗:${failures.join(',')}`;
  const allEmpty = failures.length === 0 && Object.values(counts).every((count) => count === 0);
  const content = [
    `## 未処理の在庫（${jstStamp(now)}）`,
    section('未処理PR', buckets.PR, limit),
    section('取り残しブランチ', buckets['ブランチ'], limit, `（うちそのままマージ可 ${buckets['ブランチ'].items.filter((item) => item.mergeable).length}件）`),
    section('タスク台帳の未完了', buckets['タスク'], limit, `（P1 ${ranks.P1} / P2 ${ranks.P2} / P3 ${ranks.P3}）`),
    section('残TODO', buckets.TODO, limit, '', `方式: ${buckets.TODO.method || '該当なし（next-session.md は散文のみ）'}`),
    section('夜間ジョブの異常', buckets['夜間異常'], limit),
    ...(allEmpty ? ['未処理の在庫はありません'] : []),
    summary
  ].join('\n\n');
  const block = `${BEGIN}\n${content}\n${END}`;
  const result = { counts, ranks, failures, summary, content, buckets };
  if (args.includes('--json')) log(JSON.stringify(result, null, 2));
  else if (args.includes('--dry-run')) log(block);
  else {
    const file = path.join(home, '.claude', 'open-work.md');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let existing = '';
    try { existing = fs.readFileSync(file, 'utf8'); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    fs.writeFileSync(file, replaceSection(existing, block), 'utf8');
  }
  log(summary);
  return result;
}

if (isEntry(import.meta.url)) await runOpenWork({ args: process.argv.slice(2) });
