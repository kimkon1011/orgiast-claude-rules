#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { searchGmail } from './gmail-search.mjs';
import { notifyKim } from './notify-kim.mjs';
import { defaultDriveKeyPath } from './lib/drive-auth.mjs';
import { isEntry } from './is-entry.mjs';

const defaultHome = () => process.env.ORGIAST_HOME || os.homedir();
const defaultConfig = () => JSON.parse(fs.readFileSync(new URL('./ai-receipt-accounts.json', import.meta.url), 'utf8'));
const dayJst = (date) => new Date(new Date(date).getTime() + 9 * 3600e3).toISOString().slice(0, 10);
const decode = (text) => String(text || '').replace(/&#39;|&#x27;|&apos;/gi, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

export function buildReceiptQuery(config, days) {
  if (!Number.isInteger(Number(days)) || Number(days) < 1) throw new Error('days must be a positive integer');
  const senders = Object.values(config.vendors).flatMap(v => v.from).map(from => `from:${from}`);
  return `(${senders.join(' OR ')}) newer_than:${days}d (receipt OR invoice OR payment OR "auto-reload" OR "usage credits" OR "spend limit" OR "API access" OR 領収 OR 請求 OR お支払い)`;
}

export function classifyVendor(from, subject, config) {
  const address = (String(from).match(/<([^>]+)>/)?.[1] || String(from)).trim().toLowerCase();
  const domain = address.split('@').pop();
  for (const [vendor, rule] of Object.entries(config.vendors)) {
    if (rule.from.some(value => {
      const token = value.toLowerCase();
      return token.includes('@') ? address === token : token.includes('.') ? domain === token || domain.endsWith(`.${token}`) : address.split('@')[0].includes(token);
    })) return vendor;
  }
  if (domain === 'stripe.com' || domain.endsWith('.stripe.com')) {
    const merchant = /your receipt from (.+)/i.exec(subject)?.[1]?.toLowerCase() || '';
    for (const [vendor, rule] of Object.entries(config.vendors)) {
      if ([vendor, ...rule.from.map(v => v.split('.')[0])].some(name => merchant.includes(name))) return vendor;
    }
  }
  return 'unknown';
}

export function parseReceiptMail(message, config) {
  const subject = decode(message.subject), body = decode(message.body || message.snippet);
  const patterns = [
    ['failed_payment', /payment to .* was unsuccessful/i],
    ['autoreload_paused', /auto-reload was paused/i],
    ['autoreload_other_card', /auto-reload went through on another saved card/i],
    ['api_off', /your Claude API access is turned off/i],
    ['spend_limit_reached', /reached its usage credits spend limit/i],
    ['spend_limit_warning', /approaching its usage credits spend limit|used 75%/i],
    ['limit_increased', /usage limit has been increased/i],
    ['usage_request', /requested more usage/i],
  ];
  const kind = patterns.find(([, re]) => re.test(subject))?.[0] || (/your receipt from/i.test(subject) || /amount paid/i.test(body) ? 'receipt' : 'other');
  const money = '(USD\\s*\\$?|US\\$|\\$|JPY\\s*|[¥￥])\\s*([0-9][0-9,]*(?:\\.[0-9]+)?)';
  const amount = new RegExp(`Amount paid\\s*${money}`, 'i').exec(body)
    || new RegExp(`\\bTotal\\s*${money}`, 'i').exec(body)
    || new RegExp(`${money}\\s*payment`, 'i').exec(subject)
    || (kind === 'autoreload_other_card' ? new RegExp(money, 'i').exec(body) : null);
  const currency = amount ? (/JPY|[¥￥]/i.test(amount[1]) ? 'JPY' : 'USD') : null;
  const value = amount ? Number(amount[2].replace(/,/g, '')) : null;
  const orgBody = body.replace(/[’‘]/g, "'");
  const org = /\bfor (.+?) went through/i.exec(orgBody)?.[1]
    || /organization '(.+?)' (?:is out of usage credits|has|is)/i.exec(orgBody)?.[1] || null;
  const cardMatch = /\b(JCB|Visa|Mastercard|American Express|Amex) ending in (\d{4})/i.exec(body);
  const last4 = cardMatch?.[2] || /\bwith\s*-\s*(\d{4})/.exec(body)?.[1];
  const date = Date.parse(message.date);
  return {
    messageId: String(message.id || message.messageId || ''), threadId: String(message.threadId || ''),
    account: message.account ?? message.to ?? '',
    recipient: String(message.to || '').match(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+/i)?.[0].toLowerCase() || null,
    vendor: classifyVendor(message.from, subject, config), kind,
    date: Number.isFinite(date) ? new Date(date).toISOString() : null,
    amountUsd: currency === 'USD' ? value : null, amountJpy: currency === 'JPY' ? value : null, currency, org,
    card: last4 ? `${cardMatch?.[1] || '-'} ${last4}` : null,
    receiptNo: /receipt\s*#([\w-]+)/i.exec(`${subject} ${body}`)?.[1] || null, subject,
  };
}

export function summarizeReceipts(rows, { now = new Date(), config = defaultConfig() } = {}) {
  const sources = {}, totals = { mtdUsd: 0, byVendor: {} }, through = new Date(now).getTime(), month = dayJst(now).slice(0, 7);
  const accounts = new Map(config.accounts.map(account => [account.toLowerCase(), account]));
  const groups = new Map();
  for (const row of rows) {
    const time = Date.parse(row.date);
    if (!Number.isFinite(time) || time > through) continue;
    const identity = JSON.stringify(row.receiptNo
      ? [row.vendor, row.receiptNo]
      : [row.vendor, row.kind, row.subject, dayJst(row.date)]);
    const group = groups.get(identity) || [];
    group.push(row);
    groups.set(identity, group);
  }
  const attributed = [...groups.values()].map(group => {
    const recipient = group.map(row => accounts.get(row.recipient?.toLowerCase())).find(Boolean);
    return { group, account: recipient || group[0].account };
  });
  const knownOrgs = new Map();
  for (const { group, account } of attributed) {
    for (const row of group) {
      if (!row.org) continue;
      const key = JSON.stringify([account, row.vendor]);
      const orgs = knownOrgs.get(key) || new Set();
      orgs.add(row.org.replace(/[’‘]/g, "'"));
      knownOrgs.set(key, orgs);
    }
  }
  for (const { group, account } of attributed) {
    const row = { ...group[0], account };
    const orgs = knownOrgs.get(JSON.stringify([account, row.vendor]));
    if (row.org) row.org = row.org.replace(/[’‘]/g, "'");
    else if (row.kind === 'receipt' && orgs?.size === 1) row.org = [...orgs][0];
    const time = Date.parse(row.date);
    const key = `${row.account}|${row.vendor}|${row.org || '-'}`;
    const source = sources[key] ||= { account: row.account, vendor: row.vendor, org: row.org, mtdReceiptCount: 0, mtdUsd: 0, last48hUsd: 0, last24hUsd: 0, reloads48h: 0, byDay: {}, events48h: [], lastDate: null, lastKind: null };
    if (!source.lastDate || time >= Date.parse(source.lastDate)) { source.lastDate = row.date; source.lastKind = row.kind; }
    const age = through - time;
    if (age <= 48 * 3600e3) source.events48h.push(row.kind);
    // Credit purchase receipts are the payment evidence. Failed payments and fallback-card notices are not added again.
    if (row.kind !== 'receipt') continue;
    const usd = Number(row.amountUsd) || 0, day = dayJst(row.date);
    source.byDay[day] = (source.byDay[day] || 0) + usd;
    if (day.startsWith(month)) { source.mtdReceiptCount++; source.mtdUsd += usd; totals.mtdUsd += usd; totals.byVendor[row.vendor] = (totals.byVendor[row.vendor] || 0) + usd; }
    if (age <= 48 * 3600e3) { source.last48hUsd += usd; source.reloads48h++; }
    if (age <= 24 * 3600e3) source.last24hUsd += usd;
  }
  return { sources, totals };
}

export function evaluateReceiptAlerts(summary, state = {}, thresholds = {}, { now = new Date() } = {}) {
  const next = { ...state, initialized: true, seenSources: { ...state.seenSources }, alerted: { ...state.alerted } };
  const alerts = [], day = dayJst(now);
  for (const [sourceKey, source] of Object.entries(summary.sources)) {
    const add = (kind, text) => {
      const key = `${kind}|${sourceKey}`, previous = next.alerted[key];
      if (previous === day || (kind === 'mtd_high' && previous?.slice(0, 7) === day.slice(0, 7))) return;
      alerts.push({ kind, sourceKey, text }); next.alerted[key] = day;
    };
    if (!next.seenSources[sourceKey]) {
      if (state.initialized === true && thresholds.newSourceAlert) add('new_billing_source', '新しい課金源を検出');
      next.seenSources[sourceKey] = new Date(now).toISOString();
    }
    if (source.last48hUsd >= thresholds.burst48hUsd || source.reloads48h >= thresholds.burstReloads48h) add('reload_burst', `48時間の支払い集中: $${source.last48hUsd.toFixed(2)} / ${source.reloads48h}回`);
    const events = [...new Set(source.events48h.filter(kind => ['failed_payment', 'autoreload_paused', 'api_off', 'spend_limit_reached'].includes(kind)))];
    if (events.length) add('billing_event', `課金イベント: ${events.join(', ')}`);
    if (source.mtdUsd >= thresholds.mtdSourceUsd) add('mtd_high', `月間支払い $${source.mtdUsd.toFixed(2)}`);
  }
  return { alerts, state: next };
}

export function formatReceiptReport(summary, alerts = []) {
  return ['領収書(全アカウント Gmail・直近48h)',
    ...alerts.map(a => `🚨 ${a.sourceKey}: ${a.text}`),
    ...Object.values(summary.sources).filter(s => s.mtdReceiptCount > 0 || s.events48h.some(kind =>
      ['failed_payment', 'autoreload_paused', 'autoreload_other_card', 'api_off', 'limit_increased', 'usage_request'].includes(kind) || kind.startsWith('spend_limit_'))).map(s => `${s.account} / ${s.vendor} / ${s.org || '-'}: 48h $${s.last48hUsd.toFixed(2)} (${s.reloads48h}回) / MTD $${s.mtdUsd.toFixed(2)} / 最終 ${s.lastKind || s.events48h.at(-1) || '-'}`),
    '※取得できた領収書のみ。0件・$0は課金なしを意味しません。円建てはUSD合計に含みません。',
  ].join('\n');
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
export function receiptLedgerAgeHours(home = defaultHome(), now = new Date()) {
  let newest = -Infinity;
  for (const name of ['ai-receipts.jsonl', 'ai-receipts-alert-state.json']) {
    try { newest = Math.max(newest, fs.statSync(path.join(home, '.claude', name)).mtimeMs); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return (new Date(now).getTime() - newest) / 3600e3;
}

export function readReceiptLedger(home) {
  let text;
  try { text = fs.readFileSync(path.join(home, '.claude', 'ai-receipts.jsonl'), 'utf8'); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return text.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line));
}
// Never include upstream error messages: authentication errors can contain credentials or mail content.
function safeReason(error) {
  if (/unauthorized_client/.test(String(error?.message))) return 'unauthorized_client';
  if (/invalid_grant/.test(String(error?.message))) return 'invalid_grant';
  const code = error?.code || error?.cause?.code || error?.name;
  if (/^(?:ENOENT|EACCES|ENOTFOUND|EAI_AGAIN|ECONNRESET|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|TimeoutError|AbortError)$/.test(code)) return `取得失敗: ${code}`;
  return Number.isInteger(error?.status) ? `HTTP ${error.status}` : '取得失敗: 未分類（自動調査対象）';
}
const transientReceiptError = error => /^(?:ENOTFOUND|EAI_AGAIN|ECONNRESET|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|TimeoutError|AbortError)$/.test(error?.code || error?.cause?.code || error?.name)
  || error?.status === 429 || error?.status >= 500 || error?.message === 'fetch failed';
export async function scanAiReceipts({ home = defaultHome(), days = 3, config = defaultConfig(), now = new Date(), appendLedger = true, searchImpl = searchGmail } = {}) {
  const dir = path.join(home, '.claude'), stateFile = path.join(dir, 'ai-receipts-alert-state.json');
  const existing = readReceiptLedger(home), seen = new Set(existing.map(row => row.messageId)), rows = [], errors = [];
  const query = buildReceiptQuery(config, days);
  for (const account of config.accounts) {
    try {
      const request = { user: account, query, max: 100, withBody: true, bodyLimit: 6000 };
      let result;
      try { result = await searchImpl(request); }
      catch (error) {
        if (!transientReceiptError(error)) throw error;
        await new Promise(resolve => setTimeout(resolve, 250));
        try { result = await searchImpl(request); }
        catch (retryError) { retryError.receiptRetried = true; throw retryError; }
      }
      for (const message of result.messages) {
        const row = parseReceiptMail({ ...message, account }, config);
        if (!row.messageId || !row.date) { errors.push({ account, reason: 'IDまたは日時不明のメールあり' }); continue; }
        if (!seen.has(row.messageId)) { seen.add(row.messageId); rows.push(row); }
      }
      if (result.messages.length >= 100 || result.estimate > result.messages.length + (result.skipped || 0)) errors.push({ account, reason: '取得上限100件・一部未計測' });
      if (result.skipped) errors.push({ account, reason: `${result.skipped}件取得不可` });
    } catch (error) { errors.push({ account, reason: safeReason(error), ...(error.receiptRetried ? { tried: '一時障害として再取得したが失敗' } : {}) }); }
  }
  const summary = summarizeReceipts([...existing, ...rows], { now, config });
  const evaluated = evaluateReceiptAlerts(summary, readJson(stateFile, {}), config.thresholds, { now });
  if (appendLedger) {
    fs.mkdirSync(dir, { recursive: true });
    if (rows.length) fs.appendFileSync(path.join(dir, 'ai-receipts.jsonl'), rows.map(row => JSON.stringify(row)).join('\n') + '\n');
    fs.writeFileSync(stateFile, JSON.stringify(evaluated.state, null, 2) + '\n');
  }
  const report = [formatReceiptReport(summary, evaluated.alerts), ...errors.map(e => `未計測: ${e.account}（${e.reason}）`)].join('\n');
  return { rows, summary, alerts: evaluated.alerts, errors, report };
}

export async function alertAiReceipts(result, { home = defaultHome(), now = new Date(), notify = notifyKim } = {}) {
  if (!result?.alerts?.length) return { delivered: 'none' };
  return notify(result.report, { home, webhookFallback: false });
}

export async function runReceiptScanCli(args = process.argv.slice(2), {
  home = defaultHome(), now = new Date(), keyPath = process.env.GOOGLE_SA_KEY ?? defaultDriveKeyPath(),
  scan = scanAiReceipts, alert = alertAiReceipts, log = console.log,
} = {}) {
  const index = args.indexOf('--days'), staleIndex = args.indexOf('--if-stale'), dryRun = args.includes('--dry-run');
  if (staleIndex >= 0) {
    const hours = Number(args[staleIndex + 1]);
    if (!Number.isFinite(hours) || hours <= 0) throw new Error('if-stale must be positive hours');
    const age = receiptLedgerAgeHours(home, now);
    if (age <= hours) { log(`skip: fresh (${age.toFixed(1)}h)`); return; }
  }
  if (!fs.existsSync(keyPath)) { log('skip: no-sa-key'); return; }
  const result = await scan({ home, now, days: index < 0 ? 3 : Number(args[index + 1]), appendLedger: !dryRun });
  if (!dryRun && args.includes('--notify')) await alert(result, { home, now });
  log(args.includes('--json') ? JSON.stringify(result, null, 2) : result.report);
}

if (isEntry(import.meta.url)) {
  try { await runReceiptScanCli(); }
  catch { console.error('ai-receipt-scan: 集計失敗（設定・台帳・接続を確認）'); process.exitCode = 1; }
}
