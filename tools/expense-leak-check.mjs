#!/usr/bin/env node
// Read-only freee/Gmail/Yahoo reconciliation. Only the dedicated Sheet tab and kim DM are written.
import { readFile, writeFile, mkdir, rename, open, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { getAccessToken } from './lib/freee-auth.mjs';
import { sheetsMetadata, sheetsGet, sheetsAppend, ensureSheetTab, quoteTab } from './lib/sheets-dwd.mjs';
import { notifyKim } from './notify-kim.mjs';
import { isEntry } from './is-entry.mjs';

export const COMPANY_ID = 11975741;
export const SPREADSHEET_ID = '1n4KyUN6iEGwj0Tg0boZjhZUDhCCiJovvgEaRBCT26gE';
export const TAB = 'AI経費漏れチェック';
export const SHEET_LINK = `https://docs.google.com/a/orgiast.jp/spreadsheets/d/${SPREADSHEET_ID}/edit`;
export const HEADER = ['検出日', '取引日', '口座', '利用先(内容)', '金額', '判定', '証跡の受信箱', '証跡メール件名', '証跡メール日付', '証跡リンク', '推定プロジェクトコード', 'freee wallet_txn id', '対応状況'];
export const RULES = {
  alwaysPrivate: [
    { terms: ['So-net', 'ソネット'], amounts: [324, 1440, 2, 3682] },
    { terms: ['赤ちゃん', 'ベビー', 'おむつ', 'オムツ', '哺乳瓶', '粉ミルク', '乳児'] },
  ],
  alwaysExpense: ['PC', 'パソコン', '電子機器', '炭酸水', '文房具', '事務用品', '消耗品', '電池'],
};
export const LIMITS = { gmail: 300, yahoo: 150, runtimeMs: 40 * 60_000, reserveMs: 90_000 };
const USERS = ['kim@orgiast.jp', 'seisaku-team@orgiast.jp'];
const HERE = dirname(fileURLToPath(import.meta.url));
const DAY = 86_400_000;
export const normalize = (text) => String(text ?? '').normalize('NFKC').toLowerCase();
const compact = (text) => normalize(text).replace(/[^\p{L}\p{N}]/gu, '');
export const jstDay = (date = new Date()) => new Date(date.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);
export const shiftDay = (day, count) => new Date(Date.parse(`${day}T00:00:00Z`) + count * DAY).toISOString().slice(0, 10);
export const projectCode = (day) => `${day.slice(2, 4)}${day.slice(5, 7)}01OR`;
function validDay(day) { return /^\d{4}-\d{2}-\d{2}$/.test(day) && !Number.isNaN(Date.parse(day)) && shiftDay(day, 0) === day; }
export function parseArgs(argv, env = process.env) {
  const opts = { today: env.EXPENSE_LEAK_TODAY || jstDay(), dryRun: false, weekly: false, noYahoo: false, noGmail: false, limit: Infinity, verification: false };
  const flags = { '--dry-run': 'dryRun', '--weekly': 'weekly', '--no-yahoo': 'noYahoo', '--no-gmail': 'noGmail', '--verification': 'verification' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (flags[arg]) opts[flags[arg]] = true;
    else if (['--from', '--to', '--limit', '--out'].includes(arg)) {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`Missing value: ${arg}`);
      opts[arg.slice(2)] = argv[++i];
    } else throw new Error(`Unknown option: ${arg}`);
  }
  if (!validDay(opts.today)) throw new Error('Invalid EXPENSE_LEAK_TODAY');
  opts.to ??= opts.today;
  if (!validDay(opts.to)) throw new Error('Invalid --to');
  opts.from ??= shiftDay(opts.to, -90);
  if (!validDay(opts.from) || opts.from > opts.to) throw new Error('Invalid date range');
  opts.limit = Number(opts.limit);
  if (opts.limit !== Infinity && (!Number.isSafeInteger(opts.limit) || opts.limit < 1)) throw new Error('Invalid --limit');
  if (opts.verification && opts.limit > 5) throw new Error('--verification requires --limit <= 5');
  const home = env.EXPENSE_LEAK_HOME || homedir();
  opts.statePath = join(home, '.claude', 'state', 'expense-leak-check.json');
  opts.out = resolve(opts.out || join(home, '.claude', 'logs', 'expense-leak', `${opts.today}.json`));
  opts.yahooScript = env.EXPENSE_LEAK_YAHOO_SCRIPT || join(homedir(), 'Downloads', 'CLAUDE.md配布', 'yahoo-auction-sniper', 'yahoo-mail-search.mjs');
  return opts;
}
export function weeklySkip(today, lastRunAt) {
  if (!lastRunAt || !Number.isFinite(Date.parse(lastRunAt))) return false;
  const lastDay = jstDay(new Date(lastRunAt));
  const age = Date.parse(today) - Date.parse(lastDay);
  // Same-day protection also covers a second Scheduler action on Monday.
  return age === 0 || (new Date(`${today}T00:00:00Z`).getUTCDay() !== 1 && age >= 0 && age <= 6 * DAY);
}
export function merchantToken(description) {
  const first = normalize(description).replace(/[^\p{L}\p{N}\s]/gu, ' ').trim().split(/\s+/)[0] || '';
  return /^[\u30a0-\u30ff]+$/.test(first) ? first.slice(0, 4) : first;
}
export function amountVariants(amount) {
  const raw = String(Math.abs(Number(amount)));
  const comma = Math.abs(Number(amount)).toLocaleString('en-US', { maximumFractionDigits: 10 });
  return [...new Set([raw, comma, `¥${comma}`, `${raw}円`])];
}
export function ruleVerdict(txn, privateTerms = []) {
  const description = compact(txn.description);
  if (RULES.alwaysPrivate.some((rule) => rule.terms.some((word) => description.includes(compact(word))) && (!rule.amounts || rule.amounts.includes(Math.abs(txn.amount)))) ||
      privateTerms.some((word) => compact(word) && description.includes(compact(word)))) return '私用(自動)';
  if (RULES.alwaysExpense.some((word) => word === 'PC' ? /(^|[^a-z])pc([^a-z]|$)/i.test(normalize(txn.description)) : description.includes(compact(word)))) return '経費(確認不要)';
  return null;
}
export function gmailQuery(txn) {
  const amounts = amountVariants(txn.amount).map((x) => `"${x}"`).join(' ');
  const merchant = merchantToken(txn.description);
  // after/before epoch seconds pin the ±10-day inclusive interval to JST.
  const after = Math.floor(Date.parse(`${shiftDay(txn.date, -10)}T00:00:00+09:00`) / 1000);
  const before = Math.floor(Date.parse(`${shiftDay(txn.date, 11)}T00:00:00+09:00`) / 1000);
  return `{${amounts}}${merchant ? ` "${merchant}"` : ''} after:${after} before:${before}`;
}
function inWindow(day, txn) { return validDay(day) && day >= shiftDay(txn.date, -10) && day <= shiftDay(txn.date, 10); }
export function parseYahoo(text, txn, today) {
  const evidence = [];
  let unverified = 0;
  for (const line of text.split(/\r?\n/)) {
    const row = line.match(/^\d+\.\s+(.+)$/)?.[1];
    if (!row) continue;
    const full = row.match(/(20\d{2})[\/年-](\d{1,2})[\/月-](\d{1,2})日?/);
    const short = !full && row.match(/(?:^|\s)(\d{1,2})[\/月](\d{1,2})(?:日|\s)/);
    let day = full ? `${full[1]}-${full[2].padStart(2, '0')}-${full[3].padStart(2, '0')}` : '';
    if (short) {
      day = `${today.slice(0, 4)}-${short[1].padStart(2, '0')}-${short[2].padStart(2, '0')}`;
      if (day > today) day = `${Number(today.slice(0, 4)) - 1}${day.slice(4)}`;
    }
    const merchant = merchantToken(txn.description);
    // Plain-text search output cannot prove an amount hidden in the mail body.
    const amounts = normalize(row).match(/\d[\d,]*(?:\.\d+)?/g) || [];
    const hasAmount = amounts.some((n) => Number(n.replaceAll(',', '')) === Math.abs(txn.amount));
    if (day && inWindow(day, txn) && merchant && compact(row).includes(compact(merchant)) && hasAmount) {
      evidence.push({ box: 'kimkon1011@yahoo.co.jp', subject: row, date: day, from: '', link: 'https://mail.yahoo.co.jp/u/pc/f/', metadataLimited: true });
    } else unverified++;
  }
  return { evidence, unverified };
}
export function childSearch(script, args, timeout) {
  return new Promise((resolveChild) => {
    execFile(process.execPath, [script, ...args], { windowsHide: true, timeout, maxBuffer: 2 * 1024 * 1024 }, (error, stdout) => {
      // Do not propagate raw child stderr (may contain credentials or browser settings).
      resolveChild({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout: stdout || '', timedOut: !!error?.killed });
    });
  });
}
export async function makeFreeeGet() {
  let token;
  try { token = await getAccessToken(); } catch { throw new Error('freee authentication failed (check DB/token configuration)'); }
  return async (path, params = {}) => {
    if (!/^\/api\/1\/(walletables|wallet_txns(?:\/\d+)?)$/.test(path)) throw new Error('Unsupported freee read');
    const url = new URL(`https://api.freee.co.jp${path}`);
    for (const [key, value] of Object.entries({ company_id: COMPANY_ID, ...params })) url.searchParams.set(key, String(value));
    const response = await fetch(url, { method: 'GET', headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`freee GET HTTP ${response.status}`);
    return response.json();
  };
}
export async function collectTxns(get, opts, state, timeLeft = () => true) {
  const json = await get('/api/1/walletables');
  if (!Array.isArray(json.walletables)) throw new Error('Invalid walletables response');
  const wallets = json.walletables.filter((w) => String(w.name).normalize('NFKC').startsWith('金立替'));
  const seen = new Map();
  const statusCounts = {};
  let complete = true;
  for (const wallet of wallets) {
    for (let offset = 0; ; offset += 100) {
      if (!timeLeft()) { complete = false; break; }
      const page = await get('/api/1/wallet_txns', { walletable_id: wallet.id, walletable_type: wallet.type, start_date: opts.from, end_date: opts.to, limit: 100, offset });
      if (!Array.isArray(page.wallet_txns)) throw new Error('Invalid wallet_txns response');
      let added = 0;
      for (const txn of page.wallet_txns) {
        if (Number(txn.walletable_id) !== Number(wallet.id) || txn.walletable_type !== wallet.type) throw new Error('freee wallet filter mismatch');
        if (!Number.isSafeInteger(txn.id) || !validDay(txn.date) || !Number.isFinite(txn.amount) || typeof txn.status !== 'number') throw new Error('Invalid wallet transaction fields');
        if (txn.date < opts.from || txn.date > opts.to) throw new Error('freee date filter mismatch');
        if (!seen.has(String(txn.id))) { added++; statusCounts[txn.status] = (statusCounts[txn.status] || 0) + 1; }
        seen.set(String(txn.id), { id: txn.id, date: txn.date, amount: txn.amount, description: txn.description || '', status: txn.status, entry_side: txn.entry_side, walletable_id: txn.walletable_id, walletable_type: txn.walletable_type, account: wallet.name });
        if (txn.status !== 1) delete state.txns[String(txn.id)];
      }
      if (page.wallet_txns.length < 100) break;
      if (!added) throw new Error('freee pagination made no progress');
    }
    if (!complete) break;
  }
  // Out-of-window/absent ids are not presumed resolved. Confirm each with GET.
  for (const id of Object.keys(state.txns)) {
    if (seen.has(id)) continue;
    if (!timeLeft()) { complete = false; break; }
    if (!/^\d+$/.test(id)) throw new Error('Invalid state transaction id');
    const detail = await get(`/api/1/wallet_txns/${id}`);
    if (!detail.wallet_txn || typeof detail.wallet_txn.status !== 'number') throw new Error('Invalid wallet_txn detail');
    if (detail.wallet_txn.status !== 1) delete state.txns[id];
  }
  return { wallets, statusCounts, complete, candidates: [...seen.values()].filter((t) => t.status === 1).sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id) };
}
export async function searchEvidence(txn, opts, budget, deps) {
  const evidence = [];
  const issues = [];
  let deferred = '';
  for (const user of USERS) {
    if (opts.noGmail) { deferred ||= '未検索(無効化)'; continue; }
    if (budget.gmail[user] >= LIMITS.gmail) { deferred = '未検索(上限)'; continue; }
    if (!deps.timeLeft()) { deferred = '未検索(時間上限)'; break; }
    budget.gmail[user]++;
    const result = await deps.search(join(HERE, 'gmail-search.mjs'), ['--user', user, '--query', gmailQuery(txn), '--max', '20'], deps.timeout());
    if (result.code !== 0) { issues.push(`Gmail ${user}: exit ${result.code}`); deferred ||= '未検索(障害)'; continue; }
    let messages;
    try { const parsed = JSON.parse(result.stdout); messages = parsed.messages; if (parsed.skipped) { deferred ||= '未検索(障害)'; issues.push(`Gmail ${user}: skipped ${parsed.skipped}`); } } catch { /* handled below */ }
    if (!Array.isArray(messages)) { issues.push(`Gmail ${user}: invalid JSON`); deferred ||= '未検索(障害)'; continue; }
    for (const message of messages) {
      const timestamp = Date.parse(message.date);
      if (!message.threadId || !Number.isFinite(timestamp) || !inWindow(jstDay(new Date(timestamp)), txn)) continue;
      evidence.push({ box: user, subject: message.subject || '', date: message.date, from: message.from || '', link: `https://mail.google.com/mail/u/${user}/#all/${message.threadId}` });
    }
  }
  if (opts.noYahoo) deferred ||= '未検索(無効化)';
  else if (budget.yahooFailed) deferred ||= '未検索(障害)';
  else if (budget.yahooUnavailable) { /* Explicitly skip Yahoo after exit 2; Gmail results remain usable. */ }
  else {
    const queries = [...amountVariants(txn.amount), merchantToken(txn.description)].filter(Boolean);
    // Await every browser child before launching another; never use --open.
    for (const query of queries) {
      if (budget.yahoo >= LIMITS.yahoo) { deferred = '未検索(上限)'; break; }
      if (!deps.timeLeft()) { deferred = '未検索(時間上限)'; break; }
      budget.yahoo++;
      const result = await deps.search(opts.yahooScript, ['--query', query, '--max', '50'], deps.timeout());
      if (result.code === 2) { budget.yahooUnavailable = true; break; }
      if (result.code !== 0) { budget.yahooFailed = true; issues.push(`Yahoo: exit ${result.code}`); deferred ||= '未検索(障害)'; break; }
      const parsed = parseYahoo(result.stdout, txn, opts.today);
      evidence.push(...parsed.evidence);
      budget.yahooUnverified += parsed.unverified;
      if (parsed.evidence.length) break;
    }
  }
  return { evidence: [...new Map(evidence.map((e) => [`${e.box}:${e.link}:${e.subject}`, e])).values()], issues, deferred };
}
export function sheetRows(results, today, verification = false) {
  return results.filter((r) => !r.deferred).map((r) => [today, r.date, r.account, r.description, r.amount, r.verdict,
    r.evidence.map((e) => e.box).join('\n'), r.evidence.map((e) => e.subject).join('\n'), r.evidence.map((e) => e.date).join('\n'), r.evidence.map((e) => e.link).join('\n'), projectCode(r.date), String(r.id), verification ? '検証(削除可)' : '']);
}
export function dmText(result) {
  const counts = (v) => result.results.filter((r) => r.verdict === v).length;
  const unknown = result.results.filter((r) => r.verdict === '不明(要確認)').slice(0, 10);
  const text = [`経費漏れチェック ${result.today}`, `候補総数 ${result.candidateTotal} / 今回 ${result.results.length} / 証跡あり ${result.results.filter((r) => r.evidence.length).length} / 不明 ${counts('不明(要確認)')} / 私用 ${counts('私用(自動)')} / 確認不要 ${counts('経費(確認不要)')} / 未完了 ${result.results.filter((r) => r.deferred).length}`,
    ...unknown.map((r) => `${r.date} ${r.description.replace(/\s+/g, ' ').slice(0, 60)} ${r.amount.toLocaleString('ja-JP')}円`),
    SHEET_LINK, 'kim@orgiast.jp で開く'];
  if (result.yahooUnavailable) text.push('デスクトップ『ヤフオク再ログイン（ダブルクリック）』をお願いします');
  if (result.issues.length) text.push(`一部検索を完了できませんでした (${result.issues.length}件)。結果JSONを確認してください。`);
  return text.join('\n');
}
async function readState(path) {
  try {
    const state = JSON.parse(await readFile(path, 'utf8'));
    if (!state.txns || typeof state.txns !== 'object' || Array.isArray(state.txns)) throw new Error('Invalid state');
    return state;
  } catch (error) { if (error.code === 'ENOENT') return { lastRunAt: null, txns: {} }; throw new Error('Cannot read state; refusing to discard prior progress'); }
}
export async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, path);
}
const defaultSheets = { metadata: sheetsMetadata, get: sheetsGet, append: sheetsAppend, ensure: ensureSheetTab };
export async function runCheck(opts, injected = {}) {
  const started = Date.now();
  const timeLeft = injected.timeLeft || (() => Date.now() - started < LIMITS.runtimeMs - LIMITS.reserveMs);
  const timeout = () => Math.max(1, Math.min(90_000, LIMITS.runtimeMs - LIMITS.reserveMs - (Date.now() - started)));
  const sheets = injected.sheets || defaultSheets;
  const save = injected.save || atomicJson;
  const state = injected.state || await readState(opts.statePath);
  if (opts.weekly && weeklySkip(opts.today, state.lastRunAt)) return { skip: true };
  const result = { today: opts.today, from: opts.from, to: opts.to, dryRun: opts.dryRun, wallets: [], statusCounts: {}, candidateTotal: 0, results: [], cacheHits: 0, yahooUnavailable: false, issues: [], appended: 0, complete: false };
  const budget = { gmail: Object.fromEntries(USERS.map((u) => [u, 0])), yahoo: 0, yahooUnavailable: false, yahooFailed: false, yahooUnverified: 0 };
  result.searches = budget;
  async function checkpoint() { await save(opts.out, result); if (!opts.dryRun) await save(opts.statePath, state); }
  try {
    const get = injected.freeeGet || await makeFreeeGet();
    const inventory = await collectTxns(get, opts, state, timeLeft);
    Object.assign(result, { wallets: inventory.wallets, statusCounts: inventory.statusCounts, candidateTotal: inventory.candidates.length });
    const metadata = await sheets.metadata(SPREADSHEET_ID);
    const privateTab = metadata.sheets?.find((s) => s.properties.title === '毎回私的利用')?.properties;
    const privateTerms = privateTab ? (await sheets.get(SPREADSHEET_ID, `${quoteTab(privateTab.title)}!A1:A${privateTab.gridProperties.rowCount}`)).flat().map(String).filter((s) => s.trim() && !['項目名', '利用先', '内容', '毎回私的利用'].includes(s.trim())) : [];
    for (const txn of inventory.candidates.slice(0, opts.limit)) {
      const cached = state.txns[String(txn.id)];
      if (cached?.verdict) {
        result.results.push({ ...txn, verdict: cached.verdict, evidence: cached.evidence || [], checkedAt: cached.checkedAt, cached: true }); result.cacheHits++; continue;
      }
      if (!timeLeft()) { result.results.push({ ...txn, verdict: '未検索(時間上限)', evidence: [], deferred: true }); continue; }
      const rule = ruleVerdict(txn, privateTerms);
      const search = rule === '私用(自動)' ? { evidence: [], issues: [], deferred: '' } : await searchEvidence(txn, opts, budget, { search: injected.search || childSearch, timeLeft, timeout });
      result.issues.push(...search.issues);
      // A verified receipt is enough to ask for submission even when another mailbox is offline.
      const deferred = !!search.deferred && !search.evidence.length;
      const verdict = rule === '私用(自動)' ? rule : search.evidence.length ? '証跡あり(要申請)' : rule || (deferred ? search.deferred : '不明(要確認)');
      const checkedAt = new Date().toISOString();
      result.results.push({ ...txn, verdict, evidence: search.evidence, checkedAt, ...(rule ? { ruleVerdict: rule } : {}), ...(deferred ? { deferred: true, searchStatus: search.deferred } : {}) });
      // Deferred entries deliberately have no verdict: retry next run; never pin an outage as unknown.
      state.txns[String(txn.id)] = deferred ? { evidence: search.evidence, checkedAt, searchStatus: search.deferred } : { verdict, evidence: search.evidence, checkedAt };
      result.yahooUnavailable = budget.yahooUnavailable;
      await checkpoint();
    }
    result.yahooUnavailable = budget.yahooUnavailable;
    result.complete = inventory.complete && !result.results.some((r) => r.deferred) && result.results.length === inventory.candidates.length;
    result.deferredTotal = result.results.filter((r) => r.deferred).length;
    if (!opts.dryRun) {
      const tab = await sheets.ensure(SPREADSHEET_ID, TAB, HEADER);
      const existing = await sheets.get(SPREADSHEET_ID, `${quoteTab(TAB)}!L2:L${Math.max(2, tab.gridProperties.rowCount)}`);
      const ids = new Set(existing.flat().map(String));
      const rows = sheetRows(result.results, opts.today, opts.verification).filter((row) => !ids.has(row[11]));
      if (rows.length) {
        const appended = await sheets.append(SPREADSHEET_ID, `${quoteTab(TAB)}!A:M`, rows);
        result.appended = rows.length;
        const range = appended.updates?.updatedRange;
        if (!range) throw new Error('Sheet append missing updated range');
        const verified = await sheets.get(SPREADSHEET_ID, range);
        if (verified.length !== rows.length || verified.some((row, i) => HEADER.some((_, c) => String(row[c] ?? '') !== String(rows[i][c])))) throw new Error('Sheet append read-back mismatch');
        result.appendedRange = range;
      }
      result.notification = await (injected.notify || notifyKim)(dmText(result), { webhookFallback: false });
      if (result.notification.delivered !== 'dm') throw new Error('Discord DM not delivered');
      state.lastRunAt = `${opts.today}T03:00:00+09:00`;
    }
    await checkpoint();
    return result;
  } catch (error) {
    // Only our controlled messages are safe to persist; low-level errors can include secrets.
    result.issues.push(/^(freee |Invalid |Unsupported |Sheets |Sheet |Output tab |Discord |Cannot read)/.test(error.message) ? error.message : 'Run failed (network, filesystem or response error)');
    result.failed = true;
    await checkpoint();
    return result;
  }
}
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  // Lock dry runs too: all processes share the Yahoo browser profile and state.
  await mkdir(dirname(opts.statePath), { recursive: true });
  const lockPath = `${opts.statePath}.lock`;
  let lock;
  try { lock = await open(lockPath, 'wx'); }
  catch (error) { if (error.code === 'EEXIST') { console.log('skip: expense-leak-check already running (lock)'); return; } throw error; }
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    const result = await runCheck(opts);
    if (result.skip) console.log('skip: weekly expense-leak-check');
    else if (opts.dryRun) console.log(JSON.stringify(result, null, 2));
    else console.log(`expense-leak-check: candidates=${result.candidateTotal} processed=${result.results.length} cached=${result.cacheHits} deferred=${result.deferredTotal || 0} appended=${result.appended} dm=${result.notification?.delivered || 'none'} yahooFailed=${result.searches.yahooFailed} failed=${!!result.failed}`);
    if (result.failed) process.exitCode = 1;
  } finally { await lock.close(); await unlink(lockPath); }
}
if (isEntry(import.meta.url)) main().catch(() => { console.error('expense-leak-check: configuration/state/filesystem error; no credential details logged'); process.exitCode = 1; });
