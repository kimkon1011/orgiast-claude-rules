#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mergePr } from './pr-merge.mjs';
import { notifyKim } from './notify-kim.mjs';
import { isEntry } from './is-entry.mjs';

const REPO = 'kimkon1011/orgiast-claude-rules';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIELDS = 'number,title,state,isDraft,updatedAt,headRefName,mergedAt,statusCheckRollup,author';
const DAY = 86400000;
const ACTIONABLE = new Set(['mergeable', 'ci-failed', 'ci-pending', 'closed-unmerged', 'draft-stale', 'todo-stale']);
const INVENTORY = { 'session-stale': 'セッション', 'branch-stale': 'ブランチ' };
const isActionable = item => ACTIONABLE.has(item.category) && item.action !== 'merged';
function summarizeInventory(items) {
  return Object.fromEntries(Object.keys(INVENTORY).map(category => {
    const entries = items.filter(item => item.category === category);
    return [category, { count: entries.length, oldestDays: entries.reduce((max, item) => Math.max(max, item.ageDays), 0) }];
  }));
}
export function parseArgs(args) {
  const result = { staleDays: 3, dry: false, json: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dry') result.dry = true;
    else if (args[i] === '--json') result.json = true;
    else if (args[i] === '--stale-days') {
      const value = args[++i];
      if (!value || !Number.isFinite(Number(value)) || Number(value) < 0) throw new Error('--stale-days requires a nonnegative number');
      result.staleDays = Number(value);
    } else throw new Error(`Unknown argument: ${args[i]}`);
  }
  return result;
}
export function classifyPr(pr) {
  if (pr.mergedAt || pr.state === 'MERGED') return null;
  if (pr.state === 'CLOSED') return 'closed-unmerged';
  if (pr.state !== 'OPEN') return null;
  if (pr.isDraft) return 'draft-stale';
  const checks = pr.statusCheckRollup;
  if (!Array.isArray(checks) || !checks.length) return 'ci-pending';
  if (checks.some(c => ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(c.conclusion || c.state))) return 'ci-failed';
  return checks.every(c => c.__typename === 'CheckRun'
    ? c.status === 'COMPLETED' && c.conclusion === 'SUCCESS'
    : c.__typename === 'StatusContext' && c.state === 'SUCCESS') ? 'mergeable' : 'ci-pending';
}
const quote = value => `'${String(value).replaceAll("'", "''")}'`; // PowerShell resume commands
const clean = value => String(value).replace(/[\r\n]+/g, ' ');
export function renderReport(result) {
  const lines = ['# 停滞作業', '', `更新: ${result.generatedAt} / 閾値: ${result.staleDays}日超`,
    'TODOは初回にファイル更新日時、以降は行内容の変更を基準に計測。ブランチ照合は取得した直近100 PRの範囲。', ''];
  for (const category of [...new Set(result.items.map(i => i.category))]) {
    lines.push(`## ${category}`, '');
    const entries = result.items.filter(i => i.category === category).sort((a, b) => b.ageDays - a.ageDays);
    const visible = INVENTORY[category] ? entries.slice(0, 20) : entries;
    for (const item of visible) {
      lines.push(`- ${item.ageDays.toFixed(1)}日 / ${item.number ? `#${item.number} / ` : ''}${clean(item.title)} / ${item.action || '要確認'}`,
        `  - 再開: ${item.resume}`, ...(item.error ? [`  - エラー: ${clean(item.error)}`] : []));
    }
    if (entries.length > visible.length) lines.push(`- 他${entries.length - visible.length}件`);
    lines.push('');
  }
  if (!result.items.length) lines.push('停滞なし', '');
  if (result.errors.length) lines.push('## 収集・実行エラー', '', ...result.errors.map(e => `- ${clean(e)}`), '');
  return lines.join('\n');
}
export function notificationText(items, reportPath, staleDays = 3) {
  const actionable = items.filter(isActionable);
  const inventory = summarizeInventory(items);
  const counts = [...new Set(actionable.map(i => i.category))].map(c => `${c}: ${actionable.filter(i => i.category === c).length}件`);
  const top = [...actionable].sort((a, b) => b.ageDays - a.ageDays).slice(0, 5)
    .map(i => `- ${i.ageDays.toFixed(1)}日 ${i.category} ${i.number ? `#${i.number} ` : ''}${clean(i.title).slice(0, 140)}`);
  const summary = Object.entries(inventory).filter(([, stats]) => stats.count)
    .map(([category, stats]) => `${INVENTORY[category]}${stats.count}件（最古${stats.oldestDays.toFixed(1)}日）`).join('・');
  const footer = [summary ? `${summary}が${staleDays}日超停滞（詳細はファイル）` : '', `全文: ${clean(reportPath)}`].filter(Boolean).join('\n').slice(0, 1000);
  const body = ['停滞作業（自動前進できなかったもの）', ...counts, '経過日数上位5件:', ...top].join('\n');
  return `${body.slice(0, 2000 - footer.length - 1)}\n${footer}`;
}
export async function runWatch({ home = os.homedir(), repo = ROOT, staleDays = 3, dry = false, now = Date.now() } = {}, {
  exec = execFileSync, merge = mergePr, notify = notifyKim,
} = {}) {
  const result = { generatedAt: new Date(now).toISOString(), staleDays, dry, items: [], errors: [], notification: null };
  const command = (file, args) => String(exec(file, args, { cwd: repo, encoding: 'utf8', timeout: 60000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }));
  const collect = (source, fn) => { try { return fn(); } catch (e) { result.errors.push(`${source}: ${e.message}`); return null; } };
  const add = item => {
    const ageDays = (now - new Date(item.updatedAt).getTime()) / DAY;
    if (Number.isFinite(ageDays) && ageDays > staleDays) result.items.push({ ...item, ageDays });
  };
  const prs = collect('PR', () => {
    const data = JSON.parse(command('gh', ['-R', REPO, 'pr', 'list', '--state', 'all', '--limit', '100', '--json', FIELDS]));
    if (!Array.isArray(data)) throw new Error('Expected PR array');
    return data;
  });
  const login = prs ? collect('GitHub account', () => command('gh', ['api', 'user', '--jq', '.login']).trim()) : null;
  const authors = new Set(['kimkon1011', ...(login ? [login.toLowerCase()] : [])]);
  for (const pr of prs || []) {
    if (!authors.has(pr.author?.login?.toLowerCase())) continue;
    const category = classifyPr(pr);
    if (category) add({ category, number: pr.number, title: pr.title, updatedAt: pr.updatedAt,
      resume: `gh -R ${REPO} pr view ${pr.number} --web` });
  }
  collect('branches', () => {
    const refs = command('git', ['for-each-ref', '--sort=-committerdate', 'refs/remotes/origin', '--format=%(refname:strip=3)%09%(committerdate:iso-strict)%09%(symref)']);
    for (const line of refs.trim().split('\n')) {
      const [name, updatedAt, symref] = line.trimEnd().split('\t');
      if (!name || symref || ['HEAD', 'main', 'master'].includes(name)) continue;
      const linked = (prs || []).filter(pr => pr.headRefName === name);
      if (linked.length && linked.every(pr => pr.mergedAt || pr.state === 'MERGED')) continue;
      add({ category: 'branch-stale', title: name, updatedAt,
        resume: `git -C ${quote(repo)} log -5 ${quote(`refs/remotes/origin/${name}`)} --` });
    }
  });
  // A nightly rewrite of unrelated TODOs must not make unchanged work look fresh.
  const todoStatePath = path.join(home, '.claude', 'stale-work-state.json');
  let previousTodos = {};
  if (fs.existsSync(todoStatePath)) {
    previousTodos = collect('TODO state', () => {
      const data = JSON.parse(fs.readFileSync(todoStatePath, 'utf8'));
      if (!data.todos || typeof data.todos !== 'object' || Array.isArray(data.todos)) throw new Error('Invalid TODO state');
      return data.todos;
    }) || {};
  }
  const nextTodos = {};
  const todoCollected = collect('TODO', () => {
    const file = path.join(home, '.claude', 'next-session.md');
    if (!fs.existsSync(file)) return true;
    const updatedAt = fs.statSync(file).mtime.toISOString();
    let inside = false;
    for (const [index, line] of fs.readFileSync(file, 'utf8').split(/\r?\n/).entries()) {
      if (/^##\s+残TODO(?:\s|$)/.test(line)) { inside = true; continue; }
      if (/^#{1,2}\s/.test(line)) inside = false;
      if (inside && line.trim() && !/^\s*#/.test(line) && !line.includes('~~') && !/^\s*[-*]\s+\[[xX]\]/.test(line)) {
        const key = createHash('sha256').update(line.trim()).digest('hex');
        const prior = previousTodos[key];
        const unchangedSince = typeof prior === 'string' && Number.isFinite(Date.parse(prior)) ? prior : updatedAt;
        nextTodos[key] = unchangedSince;
        add({ category: 'todo-stale', title: line.trim(), updatedAt: unchangedSince, file, line: index + 1, resume: `code --goto ${quote(`${file}:${index + 1}`)}` });
      }
    }
    return true;
  });
  const walk = dir => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '_deleted-backup' || entry.name === 'subagents') continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) collect(file, () => walk(file));
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) collect(file, () => add({
        category: 'session-stale', title: path.relative(path.join(home, '.claude', 'projects'), file), file,
        updatedAt: fs.statSync(file).mtime.toISOString(), resume: `claude --resume ${quote(path.basename(file, '.jsonl'))}`,
      }));
    }
  };
  collect('sessions', () => walk(path.join(home, '.claude', 'projects')));
  for (const item of result.items.filter(i => i.category === 'mergeable')) {
    if (dry) { item.action = 'マージ予定'; continue; }
    try {
      // Bind gh's implicit repository to the same repository used for collection.
      const merged = await merge({ pr: item.number, repo, keepBranch: true }, {
        exec: (file, args, opts) => exec(file, file === 'gh' ? ['-R', REPO, ...args] : args, { ...opts, windowsHide: true }),
      });
      if (merged?.state !== 'MERGED' || !merged.mergedAt) throw new Error('Merge read-back not confirmed');
      item.action = 'merged';
    } catch (e) { item.action = 'merge-failed'; item.error = e.message; }
  }
  result.items.sort((a, b) => b.ageDays - a.ageDays);
  // Keep source details for the bounded file report; inventory summaries carry no rows.
  result.actionable = result.items.filter(isActionable);
  result.inventory = summarizeInventory(result.items);
  result.reportPath = path.join(home, '.claude', 'stale-work.md');
  fs.mkdirSync(path.dirname(result.reportPath), { recursive: true });
  fs.writeFileSync(result.reportPath, renderReport(result));
  if (!dry && todoCollected) {
    fs.writeFileSync(todoStatePath, JSON.stringify({ todos: nextTodos }, null, 2));
  }
  if (!dry && result.actionable.length) {
    try {
      result.notification = await notify(notificationText(result.items, result.reportPath, staleDays), { home, webhookFallback: false });
      if (result.notification?.delivered !== 'dm') result.errors.push(`notification: ${result.notification?.reason || 'DM not delivered'}`);
    } catch (e) { result.errors.push(`notification: ${e.message}`); }
    fs.writeFileSync(result.reportPath, renderReport(result));
  }
  return result;
}
export async function main(args = process.argv.slice(2)) {
  try {
    const options = parseArgs(args);
    const result = await runWatch(options);
    console.log(options.json ? JSON.stringify(result, null, 2) : renderReport(result));
    return result.errors.length ? 1 : 0;
  } catch (e) { console.error(`stale-work-watch: ${e.message}`); return 1; }
}
if (isEntry(import.meta.url)) process.exitCode = await main();
