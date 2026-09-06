#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadRelayConfig, runGh } from './feedback-to-issues.mjs';
import { getDiscordMembers, matchMember } from './discord-member-directory.mjs';
import { isEntry } from './is-entry.mjs';

const DEFAULT_LIMIT = 20;

function clean(value) { return String(value ?? '').trim(); }
function readItems(file) {
  try { const value = JSON.parse(fs.readFileSync(file, 'utf8')); return Array.isArray(value?.items) ? value.items : []; } catch { return []; }
}

export function pickRecipient(ledgerItem, members) {
  const direct = clean(ledgerItem?.submitter_discord_id);
  if (direct) return { id: direct, label: direct };
  return matchMember(ledgerItem?.submitter, members);
}

export function buildDonePayload(ledgerItem, issue, overrides = {}) {
  const number = ledgerItem?.number;
  return {
    submitter_discord_id: clean(overrides.submitter_discord_id || ledgerItem?.submitter_discord_id),
    app_name: clean(ledgerItem?.app_name),
    title: clean(ledgerItem?.title || issue?.title),
    summary: clean(overrides.summary) || `対応が完了しました（GitHub Issue #${number} クローズ）`,
    url: clean(overrides.url) || clean(issue?.url) || clean(ledgerItem?.url),
    notify_kim: true,
  };
}

function issueFor(issues, item) {
  if (issues instanceof Map) return issues.get(String(item?.message_id)) || issues.get(item?.message_id);
  if (Array.isArray(issues)) return issues.find((entry) => String(entry?.message_id) === String(item?.message_id))?.issue;
  return issues?.[item?.message_id];
}

export function selectPending(ledgerItems, notified, issues, limit = DEFAULT_LIMIT) {
  const done = new Set((Array.isArray(notified) ? notified : notified?.items || []).map((item) => String(item?.message_id)));
  const selected = [];
  for (const ledgerItem of Array.isArray(ledgerItems) ? ledgerItems : []) {
    if (done.has(String(ledgerItem?.message_id))) continue;
    const issue = issueFor(issues, ledgerItem);
    if (issue?.state !== 'CLOSED') continue;
    selected.push({ ledgerItem, issue });
    if (selected.length >= limit) break;
  }
  return selected;
}

export function formatUndeliverable(items) {
  if (!Array.isArray(items) || items.length === 0) return '';
  return items.map(({ ledgerItem, issue } = {}) => `・[${clean(ledgerItem?.app_name) || '不明'}] ${clean(ledgerItem?.title) || '（無題）'} … 提出者「${clean(ledgerItem?.submitter) || '不明'}」を Discord で特定できず未返信 / ${clean(issue?.url) || clean(ledgerItem?.url)}`).join('\n');
}

export function relayEndpoint(base, endpoint) {
  try {
    const url = new URL(String(base));
    url.pathname = url.pathname.replace(/\/api\/feedback-intake\/?$/, endpoint);
    url.search = '';
    url.hash = '';
    return url.href;
  } catch { return ''; }
}

function parseArgs(args) {
  const valueAfter = (flag) => { const index = args.indexOf(flag); return index >= 0 ? clean(args[index + 1]) : ''; };
  const parsedLimit = Number.parseInt(valueAfter('--limit'), 10);
  return {
    dry: args.includes('--dry'),
    limit: Number.isInteger(parsedLimit) && parsedLimit > 0 ? parsedLimit : DEFAULT_LIMIT,
    messageId: valueAfter('--message-id'), summary: valueAfter('--summary'), url: valueAfter('--url'),
  };
}

function viewIssue(item) {
  const result = runGh(['issue', 'view', String(item.number), '--repo', item.repo, '--json', 'state,closedAt,title,url']);
  if (result.error || result.status !== 0) throw new Error(clean(result.stderr) || result.error?.message || `gh exit ${result.status}`);
  return JSON.parse(result.stdout);
}

async function postJson(url, secret, payload, fetchImpl) {
  const response = await fetchImpl(url, { method: 'POST', headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  let data = null;
  try { data = await response.json(); } catch {}
  return { status: response.status, ok: response.ok && data?.ok === true, data };
}

function appendNotified(file, entry) {
  const items = readItems(file);
  if (items.some((item) => String(item?.message_id) === String(entry.message_id))) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ items: [...items, entry] }, null, 2)}\n`, 'utf8');
}

export async function main(args = process.argv.slice(2), { home = os.homedir(), fetchImpl = fetch } = {}) {
  const options = parseArgs(args);
  if (args.includes('--message-id') && !options.messageId) { console.error('feedback-done-notify: --message-id には値を指定してください'); return 1; }
  const config = loadRelayConfig(home);
  if (!config.url || !config.secret) { console.log('feedback-done-notify: 中継が未設定なのでスキップ'); return 0; }
  const ledgerFile = path.join(home, '.claude', 'feedback-issue-ledger.json');
  const notifiedFile = path.join(home, '.claude', 'feedback-done-notified.json');
  const ledgerItems = readItems(ledgerFile);
  if (!ledgerItems.length) return 0;
  const notified = readItems(notifiedFile);
  const notifiedIds = new Set(notified.map((item) => String(item?.message_id)));
  let candidates;
  if (options.messageId) {
    const ledgerItem = ledgerItems.find((item) => String(item?.message_id) === options.messageId);
    if (!ledgerItem) { console.error(`feedback-done-notify: 台帳に message_id=${options.messageId} がありません`); return 1; }
    if (notifiedIds.has(options.messageId)) console.log(`feedback-done-notify: 通知済みのためスキップ message_id=${options.messageId}`);
    candidates = notifiedIds.has(options.messageId) ? [] : [{ ledgerItem, issue: { state: 'MANUAL', title: ledgerItem.title, url: ledgerItem.url } }];
  } else {
    const issues = new Map();
    for (const item of ledgerItems) {
      if (notifiedIds.has(String(item?.message_id))) continue;
      try { issues.set(String(item.message_id), viewIssue(item)); }
      catch (error) { console.warn(`feedback-done-notify: Issue 取得失敗 message_id=${item.message_id} (${error.message})`); }
    }
    candidates = selectPending(ledgerItems, notified, issues, options.limit);
  }

  const membersByQuery = new Map();
  const loadMembers = async (query) => {
    if (membersByQuery.has(query)) return membersByQuery.get(query);
    let members;
    try { members = await getDiscordMembers({ query, home, fetchImpl }); }
    catch (error) { console.warn(`feedback-done-notify: Discord 名簿の取得に失敗 (${error.message})`); members = []; }
    membersByQuery.set(query, members || []);
    return members || [];
  };
  const undeliverable = [];
  let consecutiveServerFailures = 0;
  const doneUrl = relayEndpoint(config.url, '/api/feedback-done');
  for (const candidate of candidates) {
    const { ledgerItem, issue } = candidate;
    let recipient = pickRecipient(ledgerItem, []);
    if (!recipient) recipient = pickRecipient(ledgerItem, await loadMembers(ledgerItem?.submitter));
    if (!recipient) { undeliverable.push(candidate); console.log(`feedback-done-notify: 未達 message_id=${ledgerItem.message_id}`); continue; }
    const payload = buildDonePayload(ledgerItem, issue, { submitter_discord_id: recipient.id, summary: options.summary, url: options.url });
    if (options.dry) { console.log(`feedback-done-notify: dry message_id=${ledgerItem.message_id} recipient=${recipient.id} url=${payload.url}`); continue; }
    if (readItems(notifiedFile).some((item) => String(item?.message_id) === String(ledgerItem.message_id))) {
      console.log(`feedback-done-notify: 通知済みのためスキップ message_id=${ledgerItem.message_id}`);
      continue;
    }
    try {
      const response = await postJson(doneUrl, config.secret, payload, fetchImpl);
      if (!response.ok) {
        consecutiveServerFailures = response.status >= 500 ? consecutiveServerFailures + 1 : 0;
        console.warn(`feedback-done-notify: 送信失敗 message_id=${ledgerItem.message_id} (HTTP ${response.status})`);
        if (consecutiveServerFailures >= 5) { console.warn('feedback-done-notify: 5xx が連続5回のため打ち切ります'); break; }
        continue;
      }
      consecutiveServerFailures = 0;
      appendNotified(notifiedFile, { message_id: ledgerItem.message_id, submitter_discord_id: recipient.id, notified_at: new Date().toISOString(), url: payload.url });
      console.log(`feedback-done-notify: 通知済み message_id=${ledgerItem.message_id}`);
    } catch (error) { consecutiveServerFailures = 0; console.warn(`feedback-done-notify: 送信失敗 message_id=${ledgerItem.message_id} (${error.message})`); }
  }
  const body = formatUndeliverable(undeliverable);
  if (body && !options.dry) {
    try {
      const response = await postJson(relayEndpoint(config.url, '/api/notify'), config.secret, { title: '完了報告の未達リスト', body, url: '' }, fetchImpl);
      if (!response.ok) console.warn(`feedback-done-notify: 未達リスト通知失敗 (HTTP ${response.status})`);
    } catch (error) { console.warn(`feedback-done-notify: 未達リスト通知失敗 (${error.message})`); }
  }
  return 0;
}

if (isEntry(import.meta.url)) process.exitCode = await main();
