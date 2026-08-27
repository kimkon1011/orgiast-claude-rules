#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isEntry } from './is-entry.mjs';

const API = 'https://discord.com/api/v10';
const USER_AGENT = 'DiscordBot (https://orgiast.jp, 1.0)';
const MAX_MESSAGES = 1000;

export function parseSince(value, now = Date.now()) {
  if (!value) return null;
  const relative = /^(\d+)([dh])$/i.exec(String(value));
  if (relative) {
    const unit = relative[2].toLowerCase() === 'd' ? 864e5 : 36e5;
    return Number(now) - Number(relative[1]) * unit;
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function authorName(message) {
  return message?.author?.global_name || message?.author?.username || '不明';
}

function compactMessage(message) {
  return {
    id: String(message?.id || ''),
    timestamp: message?.timestamp || null,
    author: authorName(message),
    content: String(message?.content || '').replace(/\s+/g, ' ').trim(),
  };
}

export function summarizeMessages(messages, opts = {}) {
  const since = opts.since == null ? null : Number(opts.since);
  const filtered = messages
    .filter((message) => since == null || Date.parse(message?.timestamp || '') >= since)
    .sort((a, b) => Date.parse(a?.timestamp || '') - Date.parse(b?.timestamp || ''));
  const counts = new Map();
  let attachments = 0, links = 0, mentions = 0;
  for (const message of filtered) {
    const name = authorName(message);
    counts.set(name, (counts.get(name) || 0) + 1);
    attachments += Array.isArray(message?.attachments) ? message.attachments.length : 0;
    links += (String(message?.content || '').match(/https?:\/\/[^\s<>]+/g) || []).length;
    mentions += Array.isArray(message?.mentions)
      ? message.mentions.length
      : (String(message?.content || '').match(/<@!?\d+>/g) || []).length;
  }
  const tailCount = Math.max(0, Number(opts.tail ?? 10));
  let regex = null;
  if (opts.grep instanceof RegExp) regex = new RegExp(opts.grep.source, opts.grep.flags.replace(/[gy]/g, ''));
  else if (opts.grep) regex = new RegExp(String(opts.grep), 'i');
  const allMatches = regex ? filtered.filter((message) => regex.test(String(message?.content || ''))) : [];
  return {
    channelId: String(opts.channelId || ''),
    channelName: opts.channelName || null,
    fetched: filtered.length,
    truncated: Boolean(opts.truncated),
    range: {
      from: filtered[0]?.timestamp || null,
      to: filtered.at(-1)?.timestamp || null,
    },
    authors: [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'ja')),
    attachments, links, mentions,
    tail: filtered.slice(-tailCount).map(compactMessage),
    matches: allMatches.slice(0, 20).map(compactMessage),
    matchCount: allMatches.length,
    matchOmitted: Math.max(0, allMatches.length - 20),
    grep: opts.grep instanceof RegExp ? opts.grep.source : opts.grep ? String(opts.grep) : null,
  };
}

function displayTime(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '-';
  return `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

// 1通あたりの上限。bot の長文レポートが1通で予算を食い潰し、「直近10件」が
// 実質1件になるのを防ぐ(実測: 1通で 2,000 文字超のコスト日報が流れている)。
export const PER_MESSAGE_CHARS = 200;

export function clipMessageBody(content, limit = PER_MESSAGE_CHARS) {
  const body = String(content || '');
  if (!body) return '(本文なし)';
  return body.length <= limit ? body : `${body.slice(0, limit)}…(全${body.length}字)`;
}

function lineFor(message) {
  return `[${displayTime(message.timestamp)}] ${message.author}: ${clipMessageBody(message.content)}`;
}

// 行単位で削り、省略件数を必ず残す。単一行が巨大な場合だけ本文を文字単位で縮める。
export function truncateToBudget(text, budgetChars, omittedCount = 1) {
  const budget = Math.max(0, Number(budgetChars) || 0);
  if (text.length <= budget) return text;
  const lines = String(text).split('\n');
  let removed = Math.max(0, Number(omittedCount) || 0);
  const notice = () => `…他 ${removed} 件省略`;
  while (lines.length > 1 && `${lines.join('\n')}\n${notice()}`.length > budget) {
    lines.pop(); removed++;
  }
  if (!removed) removed = 1;
  let result = `${lines.join('\n')}\n${notice()}`;
  if (result.length > budget) {
    const suffix = notice();
    if (suffix.length >= budget) return suffix.slice(0, budget);
    result = `${String(lines[0] || '').slice(0, Math.max(0, budget - suffix.length - 1))}\n${suffix}`;
  }
  return result;
}

function jsonWithinBudget(summary, budget) {
  const value = {
    channelId: summary.channelId, fetched: summary.fetched, truncated: summary.truncated,
    range: summary.range, authors: summary.authors, attachments: summary.attachments,
    links: summary.links, mentions: summary.mentions, tail: [...summary.tail], matches: [...summary.matches],
  };
  let omitted = 0, output = JSON.stringify(value);
  while (output.length > budget && (value.tail.length || value.matches.length)) {
    if (value.tail.length >= value.matches.length && value.tail.length) value.tail.shift();
    else value.matches.pop();
    omitted++;
    value.omitted = `…他 ${omitted} 件省略`;
    output = JSON.stringify(value);
  }
  return output.length <= budget ? output : JSON.stringify({ channelId: summary.channelId, fetched: summary.fetched, omitted: `…他 ${summary.fetched} 件省略` });
}

export function formatDigest(summary, opts = {}) {
  const budget = Math.max(1, Number(opts.budgetChars ?? 6000));
  if (opts.json) return jsonWithinBudget(summary, budget);
  const channel = summary.channelName ? `#${summary.channelName}` : summary.channelId;
  const lines = [
    `## ${channel} 直近 ${summary.fetched} 件 (${displayTime(summary.range.from)} 〜 ${displayTime(summary.range.to)})${summary.truncated ? ' [1000件で打ち切り]' : ''}`,
    `投稿者: ${summary.authors.map((x) => `${x.name} ${x.count}`).join(' / ') || 'なし'}`,
    `添付 ${summary.attachments} / リンク ${summary.links} / メンション ${summary.mentions}`,
    '', `### 直近 ${summary.tail.length} 件`,
    ...summary.tail.map(lineFor),
  ];
  if (summary.grep) {
    lines.push('', `### --grep "${summary.grep}" に一致 ${summary.matchCount} 件（最大20件）`, ...summary.matches.map(lineFor));
    if (summary.matchOmitted) lines.push(`…他 ${summary.matchOmitted} 件省略`);
  }
  return truncateToBudget(lines.join('\n'), budget);
}

export async function fetchMessages({ channelId, limit = 100, since = null, token, fetchImpl = globalThis.fetch }) {
  const wanted = Math.min(MAX_MESSAGES, Math.max(1, Number(limit) || 100));
  const messages = [];
  let before = null, reachedSince = false;
  while (messages.length < wanted && !reachedSince) {
    const pageLimit = Math.min(100, wanted - messages.length);
    const url = new URL(`${API}/channels/${encodeURIComponent(channelId)}/messages`);
    url.searchParams.set('limit', String(pageLimit));
    if (before) url.searchParams.set('before', before);
    const response = await fetchImpl(url, { headers: { 'User-Agent': USER_AGENT, Authorization: `Bot ${token}` } });
    if (!response.ok) throw new Error(`Discord API エラー: HTTP ${response.status}`);
    const page = await response.json();
    if (!Array.isArray(page)) throw new Error('Discord API の応答が配列ではありません');
    for (const message of page) {
      const time = Date.parse(message?.timestamp || '');
      if (since != null && Number.isFinite(time) && time < since) { reachedSince = true; continue; }
      messages.push(message);
      if (messages.length >= wanted) break;
    }
    if (page.length < pageLimit || page.length === 0) break;
    before = String(page.at(-1)?.id || '');
    if (!before) break;
  }
  return { messages, truncated: Number(limit) >= MAX_MESSAGES && messages.length >= MAX_MESSAGES };
}

function parseArgs(argv) {
  const opts = { limit: 100, tail: 10, budgetChars: 6000, json: false };
  const valued = new Set(['channel', 'limit', 'since', 'grep', 'tail', 'budget-chars', 'raw-out', 'fixture']);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') { opts.json = true; continue; }
    if (!arg.startsWith('--') || !valued.has(arg.slice(2)) || argv[i + 1] == null) throw new Error(`不正な引数: ${arg}`);
    const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    opts[key] = argv[++i];
  }
  opts.limit = Number(opts.limit); opts.tail = Number(opts.tail); opts.budgetChars = Number(opts.budgetChars);
  if (!Number.isInteger(opts.limit) || opts.limit < 1 || !Number.isInteger(opts.tail) || opts.tail < 0 || !Number.isInteger(opts.budgetChars) || opts.budgetChars < 1) throw new Error('limit/tail/budget-chars は正の整数（tail は0以上）で指定してください');
  return opts;
}

function readTrimmed(file) {
  try { return fs.readFileSync(file, 'utf8').trim(); } catch { return ''; }
}

export async function main(argv = process.argv.slice(2)) {
  let opts;
  try { opts = parseArgs(argv); } catch (error) { console.error(error.message); return 2; }
  const home = os.homedir();
  const channelId = opts.channel || readTrimmed(path.join(home, '.claude', 'orgiast-discord-channel-id.txt'));
  if (!channelId) { console.error('Discord チャンネルIDが見つかりません'); return 2; }
  const since = opts.since ? parseSince(opts.since) : null;
  if (opts.since && since == null) { console.error('--since の形式が不正です'); return 2; }
  let messages, truncated = false;
  try {
    if (opts.fixture) messages = JSON.parse(fs.readFileSync(opts.fixture, 'utf8'));
    else {
      const token = process.env.DISCORD_BOT_TOKEN?.trim() || readTrimmed(path.join(home, '.claude', 'orgiast-discord-bot-token.txt'));
      if (!token) { console.error('Discord Bot トークンが見つかりません'); return 2; }
      ({ messages, truncated } = await fetchMessages({ channelId, limit: opts.limit, since, token }));
    }
    if (!Array.isArray(messages)) throw new Error('メッセージデータが配列ではありません');
    if (opts.rawOut) {
      fs.writeFileSync(opts.rawOut, JSON.stringify(messages, null, 2));
      console.error(`生JSONを ${opts.rawOut} に保存しました（全文が要るときだけ読んでください）`);
    }
    const summary = summarizeMessages(messages, { ...opts, channelId, since, truncated });
    process.stdout.write(`${formatDigest(summary, opts)}\n`);
    return 0;
  } catch (error) {
    console.error(`discord-digest: ${error.message}`);
    return 1;
  }
}

if (isEntry(import.meta.url)) process.exitCode = await main();
