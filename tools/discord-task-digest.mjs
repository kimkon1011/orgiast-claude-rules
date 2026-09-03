#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fetchMessages, parseSince } from './discord-digest.mjs';
import { createLlmClient, parseEnvText, PROVIDERS } from './line-digest.mjs';
import { getDriveToken } from './lib/drive-auth.mjs';
import { isEntry } from './is-entry.mjs';

const API = 'https://discord.com/api/v10';
const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';
const DEFAULT_GUILD_ID = '715211007307284530';
const DEFAULT_SHEET_ID = '1WtsSiDlId8EgyzA15pJbeCGfvMHUgBqrUMmucax4A24';
const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const ACTIVE_STATES = new Set(['未着手', '進行中', '保留']);
const TYPES = new Set(['改善', 'タスク', '締切', '決定待ち', 'リスク']);

export function snowflakeToMs(id) {
  try { return Number((BigInt(String(id)) >> 22n) + 1420070400000n); } catch { return NaN; }
}

export function selectActiveChannels(channels, since, maxChannels = 60) {
  return channels
    .filter((channel) => channel?.type === 0 || channel?.type === 5)
    .map((channel) => ({ ...channel, lastMessageAt: snowflakeToMs(channel.last_message_id) }))
    .filter((channel) => Number.isFinite(channel.lastMessageAt) && channel.lastMessageAt >= since)
    .sort((a, b) => b.lastMessageAt - a.lastMessageAt)
    .slice(0, maxChannels);
}

function normalizedText(value) {
  return String(value ?? '').normalize('NFKC').toLocaleLowerCase().trim().replace(/\s+/g, ' ');
}

export function preprocessForTasks(messages) {
  const seen = new Set();
  const greeting = /^(了解(しました)?|ありがとうございます|ありがとう(ございます)?|おつかれさまです|お疲れ様です|よろしくお願いします|承知しました|はい|なるほど)[!！。\s]*$/iu;
  return messages.filter((message) => {
    if (message?.author?.bot === true) return false;
    const content = String(message?.content ?? message?.text ?? '').trim();
    if (!content || greeting.test(content)) return false;
    const hasAttachment = (message?.attachments?.length || message?.embeds?.length || message?.sticker_items?.length) > 0;
    if (!content && hasAttachment) return false;
    if ([...content].length < 20 && !/https?:\/\//iu.test(content) && !/\d/u.test(content)) return false;
    const key = normalizedText(content);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function jstDateParts(value) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(value));
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

function jstDayNumber(value) {
  const p = jstDateParts(value);
  return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day)) / 864e5;
}

export function priorityScore(item, { now = new Date() } = {}) {
  const urgency = Math.max(0, Math.min(3, Number(item.urgency) || 0));
  const impact = Math.max(0, Math.min(3, Number(item.impact) || 0));
  let score = urgency * 12 + impact * 12;
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(item.deadline || ''))) {
    const days = jstDayNumber(`${item.deadline}T00:00:00+09:00`) - jstDayNumber(now);
    score += days <= 0 ? 20 : days <= 3 ? 14 : days <= 7 ? 8 : days <= 14 ? 4 : 0;
  }
  const target = `${item.title || ''} ${item.action || ''} ${item.channelName || ''}`;
  if (/売上|受注|失注|請求|入金|支払|見積|契約|クレーム|事故|法務|labor|退職/iu.test(target)) score += 8;
  else if (/クライアント|顧客|様|案件|納品|施工|設営/iu.test(target)) score += 5;
  else if (/改善|マニュアル|再発防止|ヒヤリハット/iu.test(target)) score += 3;
  if (item.type === 'リスク') score += 6;
  else if (item.type === '締切') score += 4;
  return Math.min(100, Math.max(0, Math.round(score)));
}

export function priorityRank(score) {
  return score >= 75 ? 'P1' : score >= 50 ? 'P2' : score >= 25 ? 'P3' : 'P4';
}

export function dedupeKey(item) {
  const value = `${normalizedText(item.channelId)}\n${normalizedText(item.title)}`;
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 16);
}

export function titleTokens(title) {
  const normalized = String(title ?? '')
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/いただく|ください|about|する|して|より|から|まで|依頼|確認|対応|こと|の|が|を|に|は|へ|と|で|件/giu, '')
    .replace(/[\p{P}\p{S}\s]/gu, '');
  const chars = [...normalized];
  if (chars.length < 2) return new Set();
  return new Set(chars.slice(0, -1).map((char, index) => char + chars[index + 1]));
}

export function similarity(a, b) {
  const left = titleTokens(a), right = titleTokens(b);
  if (!left.size || !right.size) return 0;
  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection++;
  return intersection / (left.size + right.size - intersection);
}

export function isNearDuplicate(a, b, threshold = 0.72) {
  return String(a?.channelId ?? '') === String(b?.channelId ?? '')
    && similarity(a?.title, b?.title) >= threshold;
}

function deadlineCompare(a, b) {
  const left = a.deadline || '9999-99-99', right = b.deadline || '9999-99-99';
  return left.localeCompare(right);
}

export function sortTasks(tasks) {
  return [...tasks].sort((a, b) => {
    const aDone = ACTIVE_STATES.has(a.status) ? 0 : 1, bDone = ACTIVE_STATES.has(b.status) ? 0 : 1;
    return aDone - bDone || b.score - a.score || deadlineCompare(a, b) || a.id.localeCompare(b.id);
  });
}

function channelIdFromLink(link) {
  return String(link || '').match(/discord\.com\/channels\/[^/]+\/([^/]+)\//)?.[1] || '';
}

export function rowToTask(row) {
  return {
    id: String(row[0] || ''), createdAt: String(row[1] || ''), rank: String(row[2] || ''), score: Number(row[3]) || 0,
    type: String(row[4] || ''), title: String(row[5] || ''), action: String(row[6] || ''), owner: String(row[7] || ''),
    deadline: String(row[8] || ''), channelName: String(row[9] || ''), evidence: String(row[10] || ''), link: String(row[11] || ''),
    status: String(row[12] || ''), memo: String(row[13] || ''), updatedAt: String(row[14] || ''), channelId: channelIdFromLink(row[11]),
  };
}

export function taskToRow(task) {
  return [task.id, task.createdAt, task.rank, task.score, task.type, task.title, task.action, task.owner, task.deadline, task.channelName, task.evidence, task.link, task.status, task.memo, task.updatedAt];
}

export function mergeTasks(existingRows, candidates, { now = new Date() } = {}) {
  const stamp = formatJst(now);
  const existing = existingRows.filter((row) => row.some((cell) => String(cell || '').trim())).map(rowToTask);
  let nextId = existing.reduce((max, task) => Math.max(max, Number(task.id.match(/^T-(\d+)$/)?.[1]) || 0), 0) + 1;
  const open = existing.filter((task) => ACTIVE_STATES.has(task.status));
  const openKeys = new Set(open.map(dedupeKey));
  const selected = [];
  let suppressed = 0;
  const prefer = (left, right) => {
    const scoreDiff = left.score - right.score;
    if (scoreDiff) return scoreDiff > 0 ? left : right;
    const deadlineDiff = deadlineCompare(left, right);
    if (deadlineDiff) return deadlineDiff < 0 ? left : right;
    return [...String(left.action || '')].length >= [...String(right.action || '')].length ? left : right;
  };
  for (const item of candidates) {
    const scored = { ...item, score: priorityScore(item, { now }) };
    const exactExisting = openKeys.has(dedupeKey(scored));
    const nearExisting = open.some((task) => isNearDuplicate(task, scored));
    if (exactExisting || nearExisting) {
      if (nearExisting) suppressed++;
      continue;
    }
    const collision = selected.findIndex((task) => dedupeKey(task) === dedupeKey(scored) || isNearDuplicate(task, scored));
    if (collision >= 0) {
      if (isNearDuplicate(selected[collision], scored)) suppressed++;
      selected[collision] = prefer(selected[collision], scored);
    } else selected.push(scored);
  }
  const added = [];
  for (const item of selected) {
    const task = { ...item, id: `T-${String(nextId++).padStart(4, '0')}`, createdAt: stamp, updatedAt: stamp, rank: priorityRank(item.score), status: '未着手', memo: '' };
    added.push(task);
  }
  // urgency/impact は台帳列にないため、既存行を推測で再採点すると優先度が壊れる。
  const preserved = existing.map((task) => ({ ...task, updatedAt: stamp, status: task.status, memo: task.memo }));
  return { tasks: sortTasks([...preserved, ...added]), added, suppressed };
}

export function formatJst(value) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(value));
  const x = Object.fromEntries(p.map((part) => [part.type, part.value]));
  return `${x.year}-${x.month}-${x.day} ${x.hour}:${x.minute}`;
}

function parseItems(raw) {
  const clean = String(raw ?? '').replace(/```(?:json)?/gi, '').replace(/```/g, '').replace(/,\s*([}\]])/g, '$1');
  for (const start of [clean.indexOf('{')].filter((value) => value >= 0)) {
    for (let end = clean.length; end > start; end--) {
      try {
        const value = JSON.parse(clean.slice(start, end));
        if (Array.isArray(value?.items)) return value.items;
      } catch {}
    }
  }
  return null;
}

function validExtractedItem(item, batch, channel, guildId) {
  const index = Number(item?.i), message = batch[index];
  if (!Number.isInteger(index) || !message || !TYPES.has(item.type)) return null;
  const title = String(item.title || '').trim().slice(0, 40), action = String(item.action || '').trim();
  if (!title || !action) return null;
  const deadline = /^\d{4}-\d{2}-\d{2}$/.test(String(item.deadline || '')) ? String(item.deadline) : '';
  return {
    type: item.type, title, action, owner: String(item.owner || '').trim(), deadline,
    urgency: Math.max(0, Math.min(3, Number(item.urgency) || 0)), impact: Math.max(0, Math.min(3, Number(item.impact) || 0)),
    evidence: String(item.evidence || '').trim().slice(0, 120), channelId: String(channel.id), channelName: String(channel.name || channel.id),
    messageId: String(message.id || ''), link: `https://discord.com/channels/${guildId}/${channel.id}/${message.id}`,
  };
}

async function extractTasks(messages, channel, { guildId, provider, llm }) {
  const items = []; let held = 0;
  const system = 'Discord発言から未完了の実行事項だけを抽出する。雑談、アクション不要の報告、完了報告は除外する。JSONオブジェクトのみを返し、前置き・説明・コードフェンスは禁止。形式は {"items":[{"i":<入力番号>,"type":"改善|タスク|締切|決定待ち|リスク","title":"40字以内","action":"誰が何をするかを具体的に1文","owner":"発言中で明示された担当者名または空文字","deadline":"YYYY-MM-DDまたは空文字","urgency":0-3,"impact":0-3,"evidence":"実際の発言から120字以内で抜粋"}]}。担当者を推測しない。期限は発言中の明示または各入力のpostedAtを基準に解決できる相対期日のみ。evidenceを創作しない。該当なしは {"items":[]}。';
  for (let offset = 0; offset < messages.length; offset += 30) {
    const batch = messages.slice(offset, offset + 30);
    const prompt = batch.map((message, i) => ({ i, postedAt: message.timestamp, author: message.author?.global_name || message.author?.username || '', text: message.content })).map(JSON.stringify).join('\n');
    let parsed = null;
    for (let attempt = 0; attempt < 2 && parsed === null; attempt++) {
      const response = await llm({ provider, messages: [{ role: 'system', content: attempt ? `${system} 前回の応答はJSONとして解釈できなかった。` : system }, { role: 'user', content: prompt }], responseFormat: { type: 'json_object' } });
      parsed = parseItems(response.text);
    }
    if (parsed === null) { held += batch.length; continue; }
    for (const raw of parsed) { const item = validExtractedItem(raw, batch, channel, guildId); if (item) items.push(item); }
  }
  return { items, held };
}

function parseArgs(argv) {
  const opts = { since: '24h', guild: DEFAULT_GUILD_ID, sheet: process.env.DISCORD_TASK_SHEET_ID?.trim() || DEFAULT_SHEET_ID, provider: 'groq', maxChannels: 120, dryRun: false, fixture: '', noLlm: false };
  const valued = new Set(['since', 'guild', 'sheet', 'provider', 'max-channels', 'fixture']);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') { opts.dryRun = true; continue; }
    if (arg === '--no-llm') { opts.noLlm = true; continue; }
    if (!arg.startsWith('--') || !valued.has(arg.slice(2)) || argv[i + 1] == null) throw new Error(`不正な引数: ${arg}`);
    const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    opts[key] = argv[++i];
  }
  opts.maxChannels = Number(opts.maxChannels);
  if (!Number.isInteger(opts.maxChannels) || opts.maxChannels < 1) throw new Error('--max-channels は正の整数で指定してください');
  if (!['groq', 'deepseek', 'gemini'].includes(opts.provider) || !PROVIDERS[opts.provider]) throw new Error('--provider は groq、deepseek、gemini のいずれかを指定してください');
  return opts;
}

// orgiast は 374 テキストチャンネルの大半が private のため、Administrator を持つ
// clawd-connector の token でなければ 97% が 403 になる(実測 coverage 2.5%)。
// 台帳が静かに空になるのを防ぐため、admin token を優先し、無いときは警告する。
export function readToken(home) {
  const explicit = process.env.DISCORD_ADMIN_BOT_TOKEN?.trim() || process.env.DISCORD_BOT_TOKEN?.trim();
  if (explicit) return { token: explicit, source: 'env', admin: Boolean(process.env.DISCORD_ADMIN_BOT_TOKEN?.trim()) };
  try {
    const admin = parseEnvText(fs.readFileSync(path.join(home, '.claude', 'discord-admin.env'), 'utf8')).DISCORD_ADMIN_BOT_TOKEN?.trim();
    if (admin) return { token: admin, source: 'discord-admin.env', admin: true };
  } catch {}
  try {
    const fallback = fs.readFileSync(path.join(home, '.claude', 'orgiast-discord-bot-token.txt'), 'utf8').trim();
    if (fallback) return { token: fallback, source: 'orgiast-discord-bot-token.txt', admin: false };
  } catch {}
  return { token: '', source: 'none', admin: false };
}

async function discordChannels(guildId, token, fetchImpl) {
  const response = await fetchImpl(`${API}/guilds/${encodeURIComponent(guildId)}/channels`, { headers: { Authorization: `Bot ${token}` } });
  if (!response.ok) throw new Error(`Discord チャンネル一覧の取得に失敗しました: HTTP ${response.status}`);
  const value = await response.json();
  if (!Array.isArray(value)) throw new Error('Discord チャンネル一覧の応答が配列ではありません');
  return value;
}

async function sheetsRequest(fetchImpl, token, url, init = {}) {
  const response = await fetchImpl(url, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init.headers || {}) } });
  if (!response.ok) throw new Error(`Sheets API エラー: HTTP ${response.status} ${await response.text()}`);
  return response.json();
}

function valuesUrl(sheetId, range) {
  return `${SHEETS_API}/${encodeURIComponent(sheetId)}/values/${encodeURIComponent(range)}`;
}

function appendJsonLines(file, values) {
  if (!values.length) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${values.map(JSON.stringify).join('\n')}\n`);
}

export async function runDiscordTaskDigest(options = {}) {
  const argv = options.args || [], opts = { ...parseArgs(argv), ...(options.cli || {}) };
  const now = options.now || new Date(), since = parseSince(opts.since, now.getTime());
  if (since == null) throw new Error('--since の形式が不正です');
  const home = options.home || os.homedir(), fetchImpl = options.fetchImpl || globalThis.fetch;
  let fixture = null, token = '';
  if (opts.fixture) fixture = JSON.parse(fs.readFileSync(opts.fixture, 'utf8'));
  let tokenSource = 'fixture';
  if (!fixture) {
    const resolved = readToken(home);
    if (!resolved.token) throw new Error('Discord Bot トークンが見つかりません');
    token = resolved.token; tokenSource = resolved.source;
    if (!resolved.admin) console.error(`[警告] Administrator を持たない Bot (${resolved.source}) を使っています。private チャンネルは 403 で読めず台帳が空になります。node tools/discord-admin-token-install.mjs を先に実行してください`);
  }
  const channels = fixture?.channels || await discordChannels(opts.guild, token, fetchImpl);
  if (!Array.isArray(channels)) throw new Error('fixture.channels は配列で指定してください');
  const textChannels = channels.filter((channel) => channel?.type === 0 || channel?.type === 5);
  const active = selectActiveChannels(channels, since, opts.maxChannels);
  const llm = options.llm || (opts.noLlm ? null : createLlmClient({ home, fetchImpl, usageFile: path.join(home, '.claude', 'executor-usage.jsonl') }));
  const extracted = []; let skipped = 0, messageCount = 0, held = 0;
  const state = { lastRunAt: now.toISOString(), channels: {} };
  for (const channel of active) {
    let messages;
    try {
      messages = fixture ? fixture.messages?.[channel.id] || [] : (await fetchMessages({ channelId: channel.id, limit: 300, since, token, fetchImpl })).messages;
    } catch (error) {
      if (/HTTP (403|404)\b/.test(error.message)) { skipped++; continue; }
      skipped++; continue;
    }
    const recent = messages.filter((message) => Date.parse(message?.timestamp || '') >= since);
    messageCount += recent.length;
    state.channels[channel.id] = { lastMessageId: String(channel.last_message_id || recent[0]?.id || ''), lastSeenAt: now.toISOString() };
    const prepared = preprocessForTasks(recent);
    if (!prepared.length || opts.noLlm) continue;
    const result = await extractTasks(prepared, channel, { guildId: opts.guild, provider: opts.provider, llm });
    extracted.push(...result.items); held += result.held;
  }
  let existingRows = options.existingRows || [];
  let sheetsToken = '';
  if (!opts.dryRun && !options.existingRows) {
    sheetsToken = await (options.getToken || getDriveToken)({ scope: SHEETS_SCOPE });
    const read = await sheetsRequest(fetchImpl, sheetsToken, valuesUrl(opts.sheet, 'タスク!A2:O'));
    existingRows = Array.isArray(read.values) ? read.values : [];
  }
  const merged = mergeTasks(existingRows, extracted, { now });
  const rows = merged.tasks.map(taskToRow);
  if (opts.dryRun) (options.log || console.log)(JSON.stringify({ rows }));
  else {
    const writeCount = Math.max(existingRows.length, rows.length);
    const writeRows = [...rows, ...Array.from({ length: writeCount - rows.length }, () => Array(15).fill(''))];
    if (writeCount > 0) {
      const range = `タスク!A2:O${writeCount + 1}`;
      await sheetsRequest(fetchImpl, sheetsToken, `${valuesUrl(opts.sheet, range)}?valueInputOption=USER_ENTERED`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ range, majorDimension: 'ROWS', values: writeRows }) });
      const verified = await sheetsRequest(fetchImpl, sheetsToken, valuesUrl(opts.sheet, range));
      const actual = (verified.values || []).filter((row) => row.some((cell) => String(cell || '').trim()));
      if (actual.length !== rows.length || String(actual[0]?.[0] || '') !== String(rows[0]?.[0] || '')) throw new Error(`書き込み検証に失敗しました: 行数 ${actual.length}/${rows.length}、先頭ID ${actual[0]?.[0] || 'なし'}/${rows[0]?.[0] || 'なし'}`);
    }
    const base = path.join(home, '.claude', 'discord-tasks');
    fs.mkdirSync(base, { recursive: true });
    fs.writeFileSync(path.join(base, 'state.json'), `${JSON.stringify(state, null, 2)}\n`);
    appendJsonLines(path.join(base, 'tasks.jsonl'), merged.added);
  }
  const result = { ok: true, tokenSource, channelsScanned: textChannels.length, channelsActive: active.length, skipped, messages: messageCount, extracted: extracted.length, added: merged.added.length, suppressed: merged.suppressed, held, totalRows: rows.length, top: merged.tasks.slice(0, 5).map((task) => ({ id: task.id, rank: task.rank, title: task.title })) };
  (options.log || console.log)(JSON.stringify(result));
  (options.log || console.log)(`discord-task-digest: 走査${textChannels.length}ch / 新規${merged.added.length}件 / 重複除外${merged.suppressed}件 / P1 ${merged.tasks.filter((task) => task.rank === 'P1').length}件`);
  return result;
}

export async function main(argv = process.argv.slice(2)) {
  try { await runDiscordTaskDigest({ args: argv }); return 0; }
  catch (error) { console.error(`discord-task-digest: ${error.message}`); return 1; }
}

if (isEntry(import.meta.url)) process.exitCode = await main();
