#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isEntry } from './is-entry.mjs';

const GUILD_ID = '715211007307284530';
const API_URL = `https://discord.com/api/v10/guilds/${GUILD_ID}/members/search`;
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function normalizeName(value) {
  return String(value ?? '').normalize('NFKC').trim().toLocaleLowerCase().replace(/[\p{P}\p{S}\s]+/gu, '');
}

function memberLabels(member) {
  return [member?.nick, member?.global_name, member?.username].filter(Boolean);
}

export function matchMember(query, members) {
  const source = String(query ?? '').trim();
  const email = /^[^@\s]+@[^@\s]+$/.test(source);
  const lookup = normalizeName(email ? source.slice(0, source.indexOf('@')) : source);
  if (!lookup) return null;
  const rows = (Array.isArray(members) ? members : []).map((member) => ({ member, labels: memberLabels(member) }));
  for (const matches of [
    rows.filter((row) => row.labels.some((label) => normalizeName(label) === lookup)),
    rows.filter((row) => row.labels.some((label) => normalizeName(label).startsWith(lookup))),
    rows.filter((row) => row.labels.some((label) => normalizeName(label).includes(lookup))),
  ]) {
    if (matches.length === 1) {
      const row = matches[0];
      const label = row.labels.find((value) => normalizeName(value) === lookup)
        || row.labels.find((value) => normalizeName(value).startsWith(lookup))
        || row.labels.find((value) => normalizeName(value).includes(lookup));
      return { id: String(row.member.id), label };
    }
    if (matches.length > 1) return null;
  }
  return null;
}

function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function compactMember(row) {
  return { id: String(row.user?.id || row.id || ''), username: row.user?.username || row.username || null, global_name: row.user?.global_name || row.global_name || null, nick: row.nick || null };
}
function searchQueries(value) {
  const source = String(value ?? '').trim();
  const full = normalizeName(source);
  const local = /^[^@\s]+@[^@\s]+$/.test(source) ? normalizeName(source.slice(0, source.indexOf('@'))) : '';
  return [...new Set([full, local, (local || full).slice(0, 2)].filter(Boolean))].slice(0, 3);
}
async function requestMembers(url, token, fetchImpl) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await fetchImpl(url, { headers: { Authorization: `Bot ${token}` } });
    if (response.status === 401 || response.status === 403) {
      console.error(`discord-member-directory: メンバー検索が ${response.status} で失敗（Bot の権限を確認）`);
      return null;
    }
    if (response.status === 429 && attempt === 0) {
      let body = {};
      try { body = await response.json(); } catch {}
      const waitMs = Math.max(0, Number(body?.retry_after) || 0) * 1000;
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      continue;
    }
    if (!response.ok) throw new Error(`Discord member search API failed (${response.status})`);
    const rows = await response.json();
    if (!Array.isArray(rows)) throw new Error('Discord member search API が配列を返しませんでした');
    return rows.map(compactMember).filter((row) => row.id);
  }
  return null;
}

export async function getDiscordMembers({ query = '', home = os.homedir(), refresh = false, now = new Date(), fetchImpl = fetch } = {}) {
  const queries = searchQueries(query);
  if (queries.length === 0) return [];
  const cacheFile = path.join(home, '.claude', 'orgiast-discord-members.json');
  const cached = readJson(cacheFile);
  const cache = cached?.queries && typeof cached.queries === 'object' ? cached : { queries: {} };
  const token = process.env.DISCORD_BOT_TOKEN?.trim()
    || (() => { try { return fs.readFileSync(path.join(home, '.claude', 'orgiast-discord-bot-token.txt'), 'utf8').trim(); } catch { return ''; } })();
  if (!token) throw new Error('Discord Bot トークンが見つかりません');
  for (const searchQuery of queries) {
    const entry = cache.queries[searchQuery];
    let members;
    if (!refresh && Array.isArray(entry?.members) && now.getTime() - new Date(entry.fetched_at).getTime() < CACHE_MAX_AGE_MS) {
      members = entry.members;
    } else {
      const url = new URL(API_URL);
      url.searchParams.set('query', searchQuery);
      url.searchParams.set('limit', '10');
      members = await requestMembers(url, token, fetchImpl);
      if (members === null) return null;
      cache.queries[searchQuery] = { fetched_at: now.toISOString(), members };
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      fs.writeFileSync(cacheFile, `${JSON.stringify(cache, null, 2)}\n`, 'utf8');
    }
    if (members.length > 0) return members;
  }
  return [];
}

export async function main(args = process.argv.slice(2)) {
  const query = args.find((arg) => arg !== '--refresh') || '';
  if (!query) { console.error('usage: discord-member-directory.mjs <名前> [--refresh]'); return 1; }
  try {
    const members = await getDiscordMembers({ query, refresh: args.includes('--refresh') });
    const result = members && matchMember(query, members);
    console.log(result ? JSON.stringify(result) : 'null');
    return result ? 0 : 1;
  } catch (error) { console.error(`discord-member-directory: ${error.message}`); return 1; }
}

if (isEntry(import.meta.url)) process.exitCode = await main();
