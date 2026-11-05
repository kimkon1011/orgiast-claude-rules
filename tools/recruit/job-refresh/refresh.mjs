#!/usr/bin/env node

import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const COMPANY_URL = 'https://en-gage.net/orgiast/';
export const LOGIN_URL = 'https://en-gage.net/company_login/login/';
export const LOGIN_ID = 'saiyo@orgiast.jp';
const DAY_MS = 86_400_000;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATE_PATH = path.join(HERE, 'state.json');
const DM_TOOL = 'C:/Users/kimko/.claude/nightly-repo/tools/discord-dm.mjs';

function decodeHtml(value) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ' };
  return value.replace(/&#(x[0-9a-f]+|\d+);|&([a-z]+);/gi, (_, numeric, name) => {
    if (numeric) return String.fromCodePoint(Number.parseInt(numeric.replace(/^x/i, ''), /^x/i.test(numeric) ? 16 : 10));
    return named[name.toLowerCase()] ?? `&${name};`;
  });
}

function plainText(html) {
  return decodeHtml(html.replace(/<script\b[\s\S]*?<\/script>/gi, ' ').replace(/<style\b[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ').trim();
}

export function parseJobList(html) {
  const matches = [...html.matchAll(/href=["'][^"']*\/orgiast\/work_(\d+)\/[^"']*["']/gi)];
  const jobs = [];
  const seen = new Set();
  for (let index = 0; index < matches.length; index += 1) {
    const id = matches[index][1];
    if (seen.has(id)) continue;
    const start = matches[index].index ?? 0;
    const end = matches[index + 1]?.index ?? Math.min(html.length, start + 20_000);
    const block = html.slice(start, end);
    const titleMatch = block.match(/<h[1-6][^>]*class=["'][^"']*(?:catch|jobTitle)[^"']*["'][^>]*>([\s\S]*?)<\/h[1-6]>/i)
      ?? block.match(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/i);
    jobs.push({
      id,
      title: titleMatch ? plainText(titleMatch[1]) : `求人 ${id}`,
      url: `https://en-gage.net/orgiast/work_${id}/`,
    });
    seen.add(id);
  }
  return jobs;
}

export function parseLastUpdated(html) {
  const text = plainText(html);
  const match = text.match(/最終更新日\s*[：:]\s*(\d{4})[/.年-]\s*(\d{1,2})[/.月-]\s*(\d{1,2})日?/);
  if (!match) return null;
  return `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
}

function dateAtMidnight(value) {
  const parsed = new Date(`${value}T00:00:00+09:00`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function daysBetween(from, to) {
  return Math.floor((to.getTime() - from.getTime()) / DAY_MS);
}

export function reconcileState(jobs, previousState = { version: 1, jobs: {} }, now = new Date()) {
  const state = { version: 1, jobs: { ...(previousState.jobs ?? {}) } };
  for (const job of jobs) {
    const old = state.jobs[job.id] ?? {};
    const changedAfterRequest = job.lastUpdated && old.lastUpdated && job.lastUpdated !== old.lastUpdated && old.lastRequestedAt;
    state.jobs[job.id] = {
      ...old,
      title: job.title,
      url: job.url,
      lastUpdated: job.lastUpdated,
      checkedAt: now.toISOString(),
      ...(changedAfterRequest ? {
        lastRequestedAt: null,
        requestedText: null,
        retryCount: 0,
        needsReview: false,
        completedAt: now.toISOString(),
      } : {}),
    };
  }
  return state;
}

export function selectJob(jobs, state, { now = new Date(), intervalDays = 14 } = {}) {
  const candidates = [];
  for (const job of jobs) {
    if (!job.lastUpdated) continue;
    const updatedAt = dateAtMidnight(job.lastUpdated);
    if (!updatedAt || daysBetween(updatedAt, now) < intervalDays) continue;
    const record = state.jobs?.[job.id] ?? {};
    if (record.needsReview) continue;
    if (record.lastRequestedAt) {
      const requestedAt = new Date(record.lastRequestedAt);
      if (!Number.isNaN(requestedAt.getTime()) && daysBetween(requestedAt, now) < 3) continue;
      if ((record.retryCount ?? 0) >= 2) continue;
    }
    candidates.push(job);
  }
  candidates.sort((a, b) => a.lastUpdated.localeCompare(b.lastUpdated) || a.id.localeCompare(b.id));
  return candidates[0] ?? null;
}

export function markExpiredRequests(jobs, state, now = new Date()) {
  for (const job of jobs) {
    const record = state.jobs?.[job.id];
    if (!record?.lastRequestedAt || record.needsReview || (record.retryCount ?? 0) < 2) continue;
    const requestedAt = new Date(record.lastRequestedAt);
    if (!Number.isNaN(requestedAt.getTime()) && daysBetween(requestedAt, now) >= 3) {
      record.needsReview = true;
      record.needsReviewAt = now.toISOString();
      record.statusNote = '2回再依頼後も公開ページの最終更新日が変わっていません';
    }
  }
}

export function createProposal(job, record = {}, now = new Date()) {
  const month = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric' })
    .formatToParts(now).find((part) => part.type === 'month')?.value;
  const variants = [
    `${month}月スタート歓迎。開始時期はお気軽にご相談ください。`,
    `${month}月からお仕事を始めたい方も歓迎します。`,
    `${month}月勤務開始をご希望の方も、ぜひご応募ください。`,
  ];
  const previousIndex = variants.indexOf(record.requestedText);
  const index = previousIndex >= 0 ? (previousIndex + 1) % variants.length : (Number(job.id) % variants.length);
  return { field: '仕事内容', location: '冒頭（1行目）に追記', text: variants[index] };
}

export function buildDm(job, proposal, { retry = false } = {}) {
  return [
    `辻有香さん、求人情報の${retry ? '再更新' : '更新'}を1件お願いします。`,
    '',
    `対象求人：${job.title}`,
    `公開URL：${job.url}`,
    `engageログイン：https://en-gage.net/company_login/login/`,
    `ログインID：${LOGIN_ID}`,
    '',
    `変更箇所：${proposal.field}の${proposal.location}`,
    '貼り付ける文（このまま貼り付けてください）：',
    proposal.text,
    '',
    '完了の目安：保存後、公開ページを開き直し、「最終更新日」が今日の日付になれば完了です。',
  ].join('\n');
}

async function fetchHtml(url, fetchImpl = fetch) {
  const response = await fetchImpl(url, { headers: { 'user-agent': 'orgiast-job-refresh/1.0 (read-only checker)' } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

export async function fetchJobs(fetchImpl = fetch) {
  const listHtml = await fetchHtml(COMPANY_URL, fetchImpl);
  const listed = parseJobList(listHtml);
  return Promise.all(listed.map(async (job) => {
    try {
      const html = await fetchHtml(job.url, fetchImpl);
      return { ...job, lastUpdated: parseLastUpdated(html), fetchError: null };
    } catch (error) {
      return { ...job, lastUpdated: null, fetchError: error.message };
    }
  }));
}

async function loadState() {
  try { return JSON.parse(await readFile(STATE_PATH, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return { version: 1, jobs: {} };
    throw error;
  }
}

async function saveState(state) {
  const temporary = `${STATE_PATH}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await rename(temporary, STATE_PATH);
}

async function sendDm(body) {
  const bodyFile = path.join(HERE, `.dm-${process.pid}.txt`);
  await writeFile(bodyFile, body, 'utf8');
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [DM_TOOL, '辻', '--body-file', bodyFile], { stdio: 'inherit', windowsHide: true });
      child.once('error', reject);
      child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`discord-dm.mjs exited with ${code}`)));
    });
  } finally {
    await unlink(bodyFile).catch(() => {});
  }
}

function parseArgs(argv) {
  const result = { dryRun: false, list: false, intervalDays: 14 };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--dry-run') result.dryRun = true;
    else if (argv[index] === '--list') result.list = true;
    else if (argv[index] === '--interval-days') result.intervalDays = Number(argv[++index]);
    else if (argv[index].startsWith('--interval-days=')) result.intervalDays = Number(argv[index].split('=')[1]);
    else throw new Error(`不明な引数: ${argv[index]}`);
  }
  if (!Number.isInteger(result.intervalDays) || result.intervalDays < 0) throw new Error('--interval-days は0以上の整数で指定してください');
  return result;
}

function listRows(jobs, state, now) {
  return jobs.map((job) => {
    const record = state.jobs[job.id] ?? {};
    let status = '対象外';
    if (!job.lastUpdated) status = `取得不可${job.fetchError ? ` (${job.fetchError})` : ''}`;
    else if (record.needsReview) status = '要確認';
    else if (record.lastRequestedAt && daysBetween(new Date(record.lastRequestedAt), now) < 3) status = '依頼後3日待ち';
    else if (record.lastRequestedAt) status = `再依頼待ち (${record.retryCount ?? 0}/2)`;
    else status = '未依頼';
    return { work_ID: job.id, 職種名: job.title, 最終更新日: job.lastUpdated ?? '取得不可', 状態: status };
  });
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const now = new Date();
  const jobs = await fetchJobs();
  const state = reconcileState(jobs, await loadState(), now);
  markExpiredRequests(jobs, state, now);
  if (args.list) {
    console.table(listRows(jobs, state, now));
    await saveState(state);
    return;
  }
  const selected = selectJob(jobs, state, { now, intervalDays: args.intervalDays });
  if (!selected) {
    await saveState(state);
    console.log('今回依頼する求人はありません。');
    return;
  }
  const record = state.jobs[selected.id];
  const retry = Boolean(record.lastRequestedAt);
  const proposal = createProposal(selected, record, now);
  const body = buildDm(selected, proposal, { retry });
  if (args.dryRun) {
    console.log(body);
    return;
  }
  await sendDm(body);
  record.lastRequestedAt = now.toISOString();
  record.requestedText = proposal.text;
  record.requestedLocation = `${proposal.field}の${proposal.location}`;
  record.retryCount = retry ? (record.retryCount ?? 0) + 1 : 0;
  record.needsReview = false;
  await saveState(state);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main().catch((error) => { console.error(`job-refresh: ${error.message}`); process.exitCode = 1; });

