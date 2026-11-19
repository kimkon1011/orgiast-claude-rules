#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fetchMessages } from './discord-digest.mjs';
import { isEntry } from './is-entry.mjs';

const DEFAULT_LOOKBACK_HOURS = 2;
const MAX_INGEST_BATCH = 200;
const DEFAULT_STATE_FILE = '.discord-capture-state.json';

function trimmed(value) {
  return String(value ?? '').trim();
}

export function parseChannelIds(value) {
  return [...new Set(String(value ?? '').split(',').map(trimmed).filter(Boolean))];
}

export function transformMessage(channelId, message) {
  const body = trimmed(message?.content);
  const messageId = trimmed(message?.id);
  if (!body || !messageId) return null;

  const author = message?.author ?? {};
  // ingest API / channel-inbox は name・mime（Discord の filename・content_type を写す）
  const attachments = Array.isArray(message?.attachments)
    ? message.attachments.map((attachment) => ({
        name: trimmed(attachment?.filename) || undefined,
        url: trimmed(attachment?.url) || undefined,
        mime: trimmed(attachment?.content_type) || undefined,
        size: Number.isFinite(Number(attachment?.size)) ? Number(attachment.size) : undefined,
      })).map((attachment) => Object.fromEntries(Object.entries(attachment).filter(([, value]) => value !== undefined)))
        .filter((attachment) => attachment.name)
    : [];

  return {
    channel_id: String(channelId),
    external_message_id: `discord:${channelId}:${messageId}`,
    sender_identifier: trimmed(author.id) || trimmed(author.username) || 'unknown',
    sender_display_name: trimmed(author.global_name) || trimmed(author.username) || 'Unknown',
    body,
    received_at: message?.timestamp ?? new Date(Number(messageId) / 4194304 + 1420070400000).toISOString(),
    ...(attachments.length ? { attachments } : {}),
  };
}

export function readState(file, readFile = fs.readFileSync) {
  try {
    const value = JSON.parse(readFile(file, 'utf8'));
    return value && typeof value === 'object' ? value : { channels: {} };
  } catch {
    return { channels: {} };
  }
}

function lookbackSince(env, now) {
  const hours = Number(env.DISCORD_CAPTURE_LOOKBACK_HOURS ?? DEFAULT_LOOKBACK_HOURS);
  const validHours = Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_LOOKBACK_HOURS;
  return now - validHours * 60 * 60 * 1000;
}

function stateSince(state, channelId, fallback) {
  const parsed = Date.parse(state?.channels?.[channelId] ?? '');
  return Number.isFinite(parsed) ? parsed + 1 : fallback;
}

function endpoint(appUrl) {
  return `${appUrl.replace(/\/+$/, '')}/api/external/discord-ingest`;
}

async function postBatch(url, secret, messages, fetchImpl) {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secret}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ messages }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`ingest API HTTP ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ''}`);
  }
}

export async function capture({
  env = process.env,
  dryRun = false,
  now = Date.now(),
  fetchMessagesImpl = fetchMessages,
  fetchImpl = globalThis.fetch,
  readFile = fs.readFileSync,
  writeFile = fs.writeFileSync,
} = {}) {
  const channelIds = parseChannelIds(env.DISCORD_CAPTURE_CHANNEL_IDS);
  const token = trimmed(env.DISCORD_BOT_TOKEN);
  const appUrl = trimmed(env.APP_URL);
  const secret = trimmed(env.CRON_SECRET);
  if (!channelIds.length) return { skipped: 'DISCORD_CAPTURE_CHANNEL_IDS is not configured' };
  if (!token) return { skipped: 'DISCORD_BOT_TOKEN is not configured' };
  if (!appUrl) return { skipped: 'APP_URL is not configured' };
  if (!secret) return { skipped: 'CRON_SECRET is not configured' };

  const stateFile = path.resolve(env.DISCORD_CAPTURE_STATE_FILE || DEFAULT_STATE_FILE);
  const state = readState(stateFile, readFile);
  state.channels ??= {};
  const fallbackSince = lookbackSince(env, now);
  const transformed = [];
  const latestByChannel = {};

  for (const channelId of channelIds) {
    const since = stateSince(state, channelId, fallbackSince);
    const { messages } = await fetchMessagesImpl({ channelId, limit: 1000, since, token, fetchImpl });
    for (const message of messages) {
      const item = transformMessage(channelId, message);
      if (item) transformed.push(item);
      const timestamp = Date.parse(message?.timestamp ?? '');
      if (Number.isFinite(timestamp) && (!latestByChannel[channelId] || timestamp > Date.parse(latestByChannel[channelId]))) {
        latestByChannel[channelId] = new Date(timestamp).toISOString();
      }
    }
  }

  transformed.sort((a, b) => Date.parse(a.received_at) - Date.parse(b.received_at));
  if (!dryRun) {
    const url = endpoint(appUrl);
    for (let index = 0; index < transformed.length; index += MAX_INGEST_BATCH) {
      await postBatch(url, secret, transformed.slice(index, index + MAX_INGEST_BATCH), fetchImpl);
    }
    for (const [channelId, timestamp] of Object.entries(latestByChannel)) state.channels[channelId] = timestamp;
    state.updated_at = new Date(now).toISOString();
    writeFile(stateFile, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  }

  return { dry_run: dryRun, channels: channelIds.length, messages: transformed.length };
}

export async function main(argv = process.argv.slice(2), options = {}) {
  const unknown = argv.filter((arg) => arg !== '--dry-run');
  if (unknown.length) {
    console.error(`discord-capture: unknown argument: ${unknown[0]}`);
    return 2;
  }
  try {
    const result = await capture({ ...options, dryRun: argv.includes('--dry-run') });
    if (result.skipped) console.log(`skip: ${result.skipped}`);
    else console.log(JSON.stringify(result));
    return 0;
  } catch (error) {
    console.error(`discord-capture: ${error.message}`);
    return 1;
  }
}

if (isEntry(import.meta.url)) process.exitCode = await main();
