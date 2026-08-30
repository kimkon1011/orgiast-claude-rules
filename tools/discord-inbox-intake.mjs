#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { userHome } from './batch-enqueue.mjs';
import { fetchMessages } from './discord-digest.mjs';
import { isEntry } from './is-entry.mjs';
import { addDecision } from './pending-decisions.mjs';
import { redactSecrets } from './webhook-health.mjs';

function readTrimmed(file) { try { return fs.readFileSync(file, 'utf8').trim(); } catch { return ''; } }
function statePath(home) { return path.join(home, '.claude', 'discord-inbox-state.json'); }
function authorName(message) { return message?.author?.global_name || message?.author?.username || '不明'; }

export function resolveChannelId({ home = userHome(), channelId } = {}) {
  return channelId || process.env.ORGIAST_INBOX_CHANNEL_ID?.trim()
    || readTrimmed(path.join(home, '.claude', 'orgiast-inbox-channel-id.txt'))
    || readTrimmed(path.join(home, '.claude', 'orgiast-discord-channel-id.txt'));
}

export async function intake({ home = userHome(), now = new Date(), channelId, token, fetchMessagesImpl = fetchMessages, dryRun = false } = {}) {
  const resolvedChannelId = resolveChannelId({ home, channelId });
  if (!resolvedChannelId) throw new Error('Discord チャンネルIDが見つかりません');
  let state = {};
  try { state = JSON.parse(fs.readFileSync(statePath(home), 'utf8')); } catch {}
  const savedSince = Date.parse(state.lastIntakeAt || '');
  const since = Number.isFinite(savedSince) ? savedSince : now.getTime() - 24 * 60 * 60 * 1000;
  const result = await fetchMessagesImpl({ channelId: resolvedChannelId, limit: 100, since, token });
  const messages = Array.isArray(result) ? result : result?.messages;
  if (!Array.isArray(messages)) throw new Error('Discord API の応答が配列ではありません');
  const candidates = messages
    .filter((message) => message?.author?.bot !== true && String(message?.content || '').trim())
    .filter((message) => { const time = Date.parse(message?.timestamp || ''); return !Number.isFinite(time) || time >= since; })
    .sort((a, b) => Date.parse(a?.timestamp || '') - Date.parse(b?.timestamp || ''));
  const decisions = candidates.map((message, index) => {
    const input = { source: 'discord-inbox', author: authorName(message), text: message.content, capturedAt: message.timestamp };
    return dryRun ? { ...input, id: `dry-run-${message.id || index + 1}`, status: 'pending', batchDate: null } : addDecision(input, { home, now });
  });
  if (!dryRun) {
    const validTimes = candidates.map((message) => Date.parse(message?.timestamp || '')).filter(Number.isFinite);
    const lastIntakeAt = validTimes.length ? new Date(Math.max(...validTimes) + 1).toISOString() : now.toISOString();
    const file = statePath(home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify({ lastIntakeAt })}\n`);
    fs.renameSync(tmp, file);
  }
  return { count: decisions.length, channelId: resolvedChannelId, decisions, since };
}

function option(args, name) { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; }
export async function main(args = process.argv.slice(2)) {
  const home = userHome();
  const token = process.env.DISCORD_BOT_TOKEN?.trim() || readTrimmed(path.join(home, '.claude', 'orgiast-discord-bot-token.txt'));
  if (!token) { console.error('Discord Bot トークンが見つかりません'); return 2; }
  try {
    const result = await intake({ home, channelId: option(args, '--channel'), token });
    console.log(`取り込み: ${result.count}件 (channel=${result.channelId})`);
    return 0;
  } catch (error) { console.error(`discord-inbox-intake: ${redactSecrets(error?.message ?? error)}`); return 1; }
}

if (isEntry(import.meta.url)) process.exitCode = await main();
