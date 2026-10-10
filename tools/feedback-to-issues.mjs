#!/usr/bin/env node
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { backgroundSpawnOptions } from './lib/background-spawn.mjs';
import { isEntry } from './is-entry.mjs';

// アプリ名→リポの台帳。新アプリはここに1行足すと Issue 化と完了報告(feedback-done-notify)の対象に入る。
// 追加漏れは feedback-form-gate.mjs が本番反映時に止める(§2.11)。
export function loadFeedbackApps(file = new URL('./feedback-apps.json', import.meta.url)) {
  try {
    const entries = Object.entries(JSON.parse(fs.readFileSync(file, 'utf8')));
    return Object.fromEntries(entries.filter(([name, repo]) => name && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)));
  } catch {
    return {};
  }
}

export const DEFAULT_REPO_MAP = {
  '購買部管理アプリ': 'kimkon1011/purchasing-management-app',
  ...loadFeedbackApps(),
};

// 専用の intake（booth-feedback-intake）が存在し、GitHub Issue 経路に載せないアプリ。
// 未マッピング（監視漏れの警示）と区別して専用経路扱いにする。
export const DEDICATED_PIPELINE_APPS = new Set(['ブース制作アプリ']);

export function clean(value) {
  return String(value ?? '').trim();
}

export function parseDismissId(args) {
  const dismissIndex = args.indexOf('--dismiss');
  return dismissIndex >= 0 ? clean(args[dismissIndex + 1]) : null;
}

export function parseRepoMap(value = '') {
  const result = {};
  for (const entry of String(value).split(',')) {
    const separator = entry.indexOf('=');
    if (separator < 1) continue;
    const appName = entry.slice(0, separator).trim();
    const repo = entry.slice(separator + 1).trim();
    // gh を shell 経由で呼ぶため、リポジトリ名にコマンドとして解釈される文字を許さない。
    if (appName && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) result[appName] = repo;
  }
  return result;
}

export function parseHostMap(value = '') {
  const result = {};
  for (const entry of String(value).split(',')) {
    const separator = entry.indexOf('=');
    if (separator < 1) continue;
    const host = entry.slice(0, separator).trim();
    const repo = entry.slice(separator + 1).trim();
    // gh に渡す値と URL の照合キーを設定から安全に限定し、意図しないコマンド解釈を防ぐ。
    if (/^[A-Za-z0-9.-]+$/.test(host) && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
      result[host.toLowerCase()] = repo;
    }
  }
  return result;
}

export function resolveRepo(appName, mapValue = '') {
  return { ...DEFAULT_REPO_MAP, ...parseRepoMap(mapValue) }[clean(appName)] || null;
}

export function resolveRepoFromUrl(sourceUrl, repoMapValue = '', hostMapValue = '') {
  let hostname;
  try {
    hostname = new URL(clean(sourceUrl)).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (!hostname) return null;

  const explicitRepo = parseHostMap(hostMapValue)[hostname];
  if (explicitRepo) return explicitRepo;

  const firstLabel = hostname.split('.')[0];
  const repoMap = { ...DEFAULT_REPO_MAP, ...parseRepoMap(repoMapValue) };
  // URL から未知のリポジトリを推測せず、既に許可された表の値だけを候補にする。
  return Object.values(repoMap).find((repo) => repo.split('/')[1]?.toLowerCase() === firstLabel) || null;
}

export function resolveRepoForItem(item, repoMapValue = '', hostMapValue = '') {
  return resolveRepo(item?.app_name, repoMapValue)
    || resolveRepoFromUrl(item?.source_url, repoMapValue, hostMapValue);
}

export function buildIssueTitle(item) {
  const prefix = item?.kind === 'bug' ? '不具合' : item?.kind === 'request' ? '要望' : '';
  return prefix ? `[${prefix}] ${clean(item?.title)}` : null;
}

export function buildIssueBody(item) {
  const lines = [
    clean(item?.body) || '（本文なし）',
    '',
    `提出者: ${clean(item?.submitter) || '（記載なし）'}`,
    `画面: ${clean(item?.page_path) || '（記載なし）'}`,
    `提出元URL: ${clean(item?.source_url) || '（記載なし）'}`,
    `Discord: ${clean(item?.discord_url) || '（記載なし）'}`,
  ];
  if (item?.has_attachment === true) lines.push('', 'スクショは Discord の元メッセージを参照');
  // どの DM から生まれた Issue かを後から機械的に検索できるようにする(feedback-replies.mjs が使う)。
  lines.push('', `<!-- feedback-dm:${clean(item?.message_id)} -->`);
  const identity = JSON.stringify({ submitter: clean(item?.submitter), submitter_discord_id: clean(item?.submitter_discord_id) })
    .replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
  lines.push('', `<!-- feedback-submitter: ${identity} -->`);
  return lines.join('\n');
}

export function isIssueCandidate(item, mapValue = '', hostMapValue = '') {
  return item?.parse_ok === true && Boolean(resolveRepoForItem(item, mapValue, hostMapValue)) && Boolean(buildIssueTitle(item));
}

export function selectCandidates(items, limit, mapValue = '', hostMapValue = '') {
  const candidates = items.filter((item) => isIssueCandidate(item, mapValue, hostMapValue));
  return { selected: candidates.slice(0, limit), remaining: Math.max(0, candidates.length - limit) };
}

export function parseEnvText(text) {
  const values = {};
  for (const line of String(text).split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    values[match[1]] = match[2].replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, '$1$2');
  }
  return values;
}

export function loadRelayConfig(home = os.homedir()) {
  const fromFiles = {};
  const envDir = path.join(home, '.claude');
  let names = [];
  try { names = fs.readdirSync(envDir).filter((name) => name.endsWith('.env')).sort(); } catch {}
  for (const name of names) {
    try { Object.assign(fromFiles, parseEnvText(fs.readFileSync(path.join(envDir, name), 'utf8'))); } catch {}
  }
  // PC 固有の環境変数を最優先にし、未設定の値だけを共通 env ファイル群から補う。
  return {
    url: clean(process.env.FEEDBACK_RELAY_URL) || clean(fromFiles.FEEDBACK_RELAY_URL),
    secret: clean(process.env.FEEDBACK_RELAY_SECRET) || clean(fromFiles.FEEDBACK_RELAY_SECRET),
  };
}

export function appendFeedbackIssueLedger(file, item) {
  let ledger = { items: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(parsed?.items)) ledger = { ...parsed, items: parsed.items };
  } catch {}
  if (ledger.items.some((entry) => String(entry?.message_id) === String(item?.message_id))) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const next = { ...ledger, items: [...ledger.items, item] };
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, file);
  return true;
}

export function issueIdentity(output) {
  const url = clean(output).split(/\s+/).find((value) => /^https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/\d+\/?$/.test(value)) || '';
  const match = url.match(/\/issues\/(\d+)\/?$/);
  return match ? { number: Number(match[1]), url } : null;
}

export function shellQuote(value) {
  const text = String(value);
  if (process.platform === 'win32') return `"${text.replace(/%/g, '%%').replace(/"/g, '""')}"`;
  return `'${text.replace(/'/g, `'"'"'`)}'`;
}

export function runGh(args, options = {}) {
  // Windows の gh.cmd は直接 spawn できないため shell を使い、値はすべて個別に quote する。
  const command = ['gh', ...args].map(shellQuote).join(' ');
  return spawnSync(command, { ...options, shell: true, encoding: 'utf8', windowsHide: true });
}

// Both the fast intake and daily sweep use this idempotent Issue/ledger operation.
export function ensureFeedbackIssue(item, repo, { home = os.homedir(), gh = runGh } = {}) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || !/^[^"\\\r\n]+$/.test(String(item.message_id || ''))) throw new Error('Invalid feedback identity');
  const ledgerFile = path.join(home, '.claude', 'feedback-issue-ledger.json');
  const lock = path.join(home, '.claude', 'feedback-issue-locks', createHash('sha256').update(String(item.message_id)).digest('hex'));
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  try { fs.mkdirSync(lock); } catch {
    // 異常終了で残った古い錠は 10 分で破棄する（永久に Issue 化できなくなるのを防ぐ）。
    try { if (Date.now() - fs.statSync(lock).mtimeMs > 10 * 60 * 1000) { fs.rmSync(lock, { recursive: true, force: true }); fs.mkdirSync(lock); } else throw new Error('busy'); }
    catch { throw new Error('Issue operation already in progress; retry next sweep'); }
  }
  let temp;
  try {
    let ledger = { items: [] };
    try { ledger = JSON.parse(fs.readFileSync(ledgerFile, 'utf8')); } catch (e) { if(e.code !== 'ENOENT') throw e; }
    if(!Array.isArray(ledger.items)) throw new Error('Invalid Issue ledger');
    const recorded = ledger.items.find(row => String(row.message_id) === String(item.message_id));
    if(recorded) return recorded;
    const marker = `<!-- feedback-dm:${item.message_id} -->`;
    const lookup = gh(['issue','list','--repo',repo,'--state','all','--search',`"feedback-dm:${item.message_id}" in:body`,'--json','number,url,body','--limit','100']);
    if(lookup.error || lookup.status !== 0) throw new Error('Issue lookup failed');
    const results = JSON.parse(lookup.stdout);
    let issue = results.find(row => row.body?.includes(marker));
    if(!issue) {
      temp = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-issue-'));
      const bodyFile = path.join(temp,'body.md');
      fs.writeFileSync(bodyFile,buildIssueBody(item));
      gh(['label','create','feedback','--repo',repo,'--color','D93F0B','--description','アプリ内フォームからの不具合・要望']);
      const created=gh(['issue','create','--repo',repo,'--title',buildIssueTitle(item) || '[不具合] '+clean(item.title),'--label','feedback','--body-file',bodyFile]);
      if(created.error || created.status !== 0) throw new Error('Issue creation failed');
      issue=issueIdentity(created.stdout);
      if(!issue) throw new Error('Issue URL missing');
    }
    const entry={message_id:item.message_id,repo,number:issue.number,url:issue.url,app_name:clean(item.app_name),title:clean(item.title),submitter:clean(item.submitter),submitter_discord_id:clean(item.submitter_discord_id)||null,created_at:new Date().toISOString()};
    // 台帳記録の失敗は従来どおり警告に留める（Issue は作成済みで、次回は marker 検索で重複を避ける）。
    try { appendFeedbackIssueLedger(ledgerFile,entry); }
    catch (error) { console.warn(`feedback-to-issues: Issue 台帳への記録に失敗 message_id=${item.message_id} (${error.message})`); }
    return entry;
  } finally { if(temp)fs.rmSync(temp,{recursive:true,force:true});fs.rmSync(lock,{recursive:true,force:true}); }
}

function relayUrls(base) {
  const pending = new URL(base);
  pending.searchParams.set('pending', '1');
  pending.searchParams.set('limit', '50');
  const ack = new URL(base);
  ack.pathname = `${ack.pathname.replace(/\/$/, '')}/ack`;
  ack.search = '';
  return { pending, ack };
}

export async function relayRequest(url, secret, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { Authorization: `Bearer ${secret}`, ...(options.headers || {}) },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await response.json();
  if (data?.ok !== true) throw new Error('ok=true ではない応答');
  return data;
}

function increment(reasons, reason) {
  reasons[reason] = (reasons[reason] || 0) + 1;
}

export async function main(args = process.argv.slice(2)) {
  const dry = args.includes('--dry') || args.includes('--dry-run');
  const dismissId = parseDismissId(args);
  const limitIndex = args.indexOf('--limit');
  const requestedLimit = limitIndex >= 0 ? Number.parseInt(args[limitIndex + 1], 10) : 5;
  const limit = Number.isInteger(requestedLimit) && requestedLimit > 0 ? requestedLimit : 5;
  const config = loadRelayConfig();
  if (!config.url || !config.secret) {
    console.log('feedback-to-issues: 中継が未設定なのでスキップ');
    return 0;
  }
  if (dismissId !== null) {
    if (!dismissId) {
      console.error('feedback-to-issues: --dismiss には message_id を指定する');
      return 1;
    }
    if (dry) {
      console.log(`feedback-to-issues: 対象外予定（--dry） message_id=${dismissId}`);
      return 0;
    }
    const urls = relayUrls(config.url);
    try {
      const ack = await relayRequest(urls.ack, config.secret, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message_id: dismissId }),
      });
      if (ack.acked !== true) throw new Error('acked=true ではない応答');
    } catch (error) {
      console.error(`feedback-to-issues: 対象外化に失敗 message_id=${dismissId} (${error.message})`);
      return 1;
    }
    console.log(`feedback-to-issues: 対象外にしました message_id=${dismissId}`);
    return 0;
  }
  const probe = runGh(['--version']);
  if (probe.error || probe.status !== 0) {
    console.log('feedback-to-issues: gh が無いのでスキップ');
    return 0;
  }

  const repoMapValue = process.env.FEEDBACK_REPO_MAP || '';
  const hostMapValue = process.env.FEEDBACK_HOST_MAP || '';
  const reasons = {};
  let items;
  const urls = relayUrls(config.url);
  try {
    const data = await relayRequest(urls.pending, config.secret);
    if (!Array.isArray(data.items)) throw new Error('items が配列ではない応答');
    items = data.items;
  } catch (error) {
    console.error(`feedback-to-issues: 中継からの取得に失敗 (${error.message})`);
    return 1;
  }

  const { selected, remaining: overLimit } = selectCandidates(items, limit, repoMapValue, hostMapValue);
  const selectedIds = new Set(selected.map((item) => String(item.message_id)));
  let created = 0;
  let acked = 0;

  for (const item of items) {
    const messageId = clean(item?.message_id) || '不明';
    if (item?.parse_ok !== true) {
      console.log(`feedback-to-issues: 解析できないのでスキップ message_id=${messageId}`);
      increment(reasons, '解析失敗');
      continue;
    }
    const appName = clean(item?.app_name);
    if (DEDICATED_PIPELINE_APPS.has(appName)) {
      console.log(`feedback-to-issues: 専用経路なのでスキップ(ブースintake) app=${appName} message_id=${messageId}`);
      increment(reasons, '専用経路');
      continue;
    }
    const appRepo = resolveRepo(item?.app_name, repoMapValue);
    const repo = resolveRepoForItem(item, repoMapValue, hostMapValue);
    if (!repo) {
      console.log(`feedback-to-issues: 未マッピングなのでスキップ app=${clean(item?.app_name)} message_id=${messageId}`);
      increment(reasons, '未マッピング');
      continue;
    }
    if (!appRepo) {
      let hostname = '';
      try { hostname = new URL(clean(item?.source_url)).hostname; } catch {}
      console.log(`feedback-to-issues: アプリ名が解決できないため提出元URLのホストで解決 host=${hostname} repo=${repo}`);
    }
    const title = buildIssueTitle(item);
    if (!title) {
      console.log(`feedback-to-issues: 種別不明なのでスキップ message_id=${messageId}`);
      increment(reasons, '種別不明');
      continue;
    }
    if (!selectedIds.has(String(item.message_id))) {
      increment(reasons, '上限超過');
      continue;
    }
    if (dry) {
      console.log(`feedback-to-issues: 作成予定 repo=${repo} title=${title}`);
      continue;
    }

    try {
      ensureFeedbackIssue(item, repo);
      created += 1;
      console.log(`feedback-to-issues: 作成済み repo=${repo} title=${title} message_id=${messageId}`);
      try {
        const ack = await relayRequest(urls.ack, config.secret, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message_id: item.message_id }),
        });
        if (ack.acked !== true) throw new Error('acked=true ではない応答');
        acked += 1;
      } catch (error) {
        console.warn(`feedback-to-issues: Issue は作成したが ack に失敗（次回重複の可能性） message_id=${messageId} (${error.message})`);
        increment(reasons, 'ack失敗');
      }
    } catch (error) {
      console.error(`feedback-to-issues: Issue 作成失敗 message_id=${messageId} (${error.message})`);
      increment(reasons, '作成失敗');
    }
  }

  if (overLimit > 0) console.log(`feedback-to-issues: 上限を超えた ${overLimit}件は次回に回します`);
  const skipped = Object.values(reasons).reduce((sum, count) => sum + count, 0);
  const details = Object.entries(reasons).map(([reason, count]) => `${reason}:${count}`).join(', ') || 'なし';
  // dry-run と未 ack の項目はすべて中継に残るため、取得範囲内の残件として明示する。
  const remaining = dry ? items.length : items.length - acked;
  console.log(`作成: ${dry ? 0 : created}件 / スキップ: ${skipped}件（${details}）/ 残り: ${remaining}件`);
  return 0;
}

// ブース制作アプリの不具合要望も 10 分毎に拾う必要がある(不具合=即実行/要望=当日夜が要件)。
// 専用タスクを別に登録するのが本筋だが、Task Scheduler への登録は環境によって
// 実行できないことがある(2026-09-02: 登録が権限で通らず、タスクが存在しない時間帯が生まれた)。
// このタスク(OrgiastFeedbackIntakeFast)は既に 10 分毎に回っているので、ここから相乗りさせて
// 「専用タスクが無くても拾える」状態を作る。専用タスクがある場合は二重に走るが、
// intake は [FB:<key>] と台帳で冪等なので重複注入は起きない。
export async function chainBoothFeedbackIntake({ argv = process.argv.slice(2), spawnImpl } = {}) {
  if (argv.includes('--dry') || argv.includes('--dry-run') || argv.includes('--no-chain')) return 'skipped';
  try {
    const { spawn } = spawnImpl ? { spawn: spawnImpl } : await import('node:child_process');
    const target = path.join(import.meta.dirname, 'booth-feedback-intake.mjs');
    const child = spawn(process.execPath, [target], { ...backgroundSpawnOptions(), stdio: 'ignore' });
    child.unref?.();
    return 'spawned';
  } catch (error) {
    // 相乗りの失敗でこのタスクの exit code を汚さない。
    console.warn(`feedback-to-issues: booth-feedback-intake の相乗り起動に失敗 (${error?.message || error})`);
    return 'failed';
  }
}

if (isEntry(import.meta.url)) {
  process.exitCode = await main();
  await chainBoothFeedbackIntake();
}
