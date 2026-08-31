#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { userHome } from './batch-enqueue.mjs';
import { fetchMessages } from './discord-digest.mjs';
import { isEntry } from './is-entry.mjs';
import { addDecision, setDecisionAttachments } from './pending-decisions.mjs';
import { redactSecrets } from './webhook-health.mjs';

function readTrimmed(file) { try { return fs.readFileSync(file, 'utf8').trim(); } catch { return ''; } }
function statePath(home) { return path.join(home, '.claude', 'discord-inbox-state.json'); }
function authorName(message) { return message?.author?.global_name || message?.author?.username || '不明'; }
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_ATTACHMENTS = 10;
const DOWNLOAD_TIMEOUT_MS = 20_000;

function attachmentRoot(home) { return path.join(home, '.claude', 'inbox-attachments'); }
export function sanitizeFilename(value) {
  const cleaned = String(value || '').replace(/[\\/]+/g, '_').replace(/\.\./g, '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return cleaned || 'file';
}

export function cleanupOldAttachments({ home = userHome(), now = new Date() } = {}) {
  const root = attachmentRoot(home);
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
  const cutoff = now.getTime() - 30 * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const target = path.join(root, entry.name);
    try {
      if (fs.statSync(target).mtimeMs < cutoff) { fs.rmSync(target, { recursive: true, force: true }); removed++; }
    } catch {}
  }
  return removed;
}

function attachmentMetadata(attachment) {
  return {
    filename: String(attachment?.filename || 'file'),
    contentType: attachment?.content_type || attachment?.contentType || null,
    size: Number.isFinite(Number(attachment?.size)) ? Number(attachment.size) : null,
    url: String(attachment?.url || ''),
  };
}

async function saveAttachments(items, { home, decisionId, fetchImpl }) {
  const output = [];
  for (const [index, attachment] of items.slice(0, MAX_ATTACHMENTS).entries()) {
    const metadata = attachmentMetadata(attachment);
    if (metadata.size != null && metadata.size > MAX_ATTACHMENT_BYTES) { output.push({ ...metadata, skipped: 'too-large' }); continue; }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
    try {
      const response = await fetchImpl(metadata.url, { signal: controller.signal });
      if (!response?.ok) throw new Error(`HTTP ${response?.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > MAX_ATTACHMENT_BYTES) { output.push({ ...metadata, size: metadata.size ?? bytes.length, skipped: 'too-large' }); continue; }
      const directory = path.join(attachmentRoot(home), decisionId);
      fs.mkdirSync(directory, { recursive: true });
      const file = path.join(directory, `${index}-${sanitizeFilename(metadata.filename)}`);
      fs.writeFileSync(file, bytes);
      output.push({ ...metadata, size: metadata.size ?? bytes.length, path: path.resolve(file) });
    } catch {
      output.push({ ...metadata, skipped: 'download-failed' });
    } finally { clearTimeout(timeout); }
  }
  return output;
}

export function resolveChannelId({ home = userHome(), channelId } = {}) {
  return channelId || process.env.ORGIAST_INBOX_CHANNEL_ID?.trim()
    || readTrimmed(path.join(home, '.claude', 'orgiast-inbox-channel-id.txt'))
    || readTrimmed(path.join(home, '.claude', 'orgiast-discord-channel-id.txt'));
}

export async function intake({ home = userHome(), now = new Date(), channelId, token, fetchMessagesImpl = fetchMessages, fetchImpl = fetch, dryRun = false } = {}) {
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
    .filter((message) => {
      const hasText = String(message?.content || '').trim().length > 0;
      const hasAttachment = Array.isArray(message?.attachments) && message.attachments.length > 0;
      return message?.author?.bot !== true && (hasText || hasAttachment);
    })
    .filter((message) => { const time = Date.parse(message?.timestamp || ''); return !Number.isFinite(time) || time >= since; })
    .sort((a, b) => Date.parse(a?.timestamp || '') - Date.parse(b?.timestamp || ''));
  const decisions = [];
  for (const [index, message] of candidates.entries()) {
    const rawAttachments = Array.isArray(message.attachments) ? message.attachments.slice(0, MAX_ATTACHMENTS) : [];
    const input = { source: 'discord-inbox', author: authorName(message), text: String(message.content || '').trim() || '(画像のみ)', capturedAt: message.timestamp };
    if (dryRun) {
      const decision = { ...input, id: `dry-run-${message.id || index + 1}`, status: 'pending', batchDate: null };
      if (rawAttachments.length) decision.attachments = rawAttachments.map(attachmentMetadata);
      decisions.push(decision);
      continue;
    }
    let decision = addDecision(input, { home, now });
    if (rawAttachments.length) {
      const attachments = await saveAttachments(rawAttachments, { home, decisionId: decision.id, fetchImpl });
      decision = setDecisionAttachments(decision.id, attachments, { home }) || { ...decision, attachments };
    }
    decisions.push(decision);
  }
  if (!dryRun) {
    const validTimes = candidates.map((message) => Date.parse(message?.timestamp || '')).filter(Number.isFinite);
    const lastIntakeAt = validTimes.length ? new Date(Math.max(...validTimes) + 1).toISOString() : now.toISOString();
    const file = statePath(home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify({ lastIntakeAt })}\n`);
    fs.renameSync(tmp, file);
  }
  if (!dryRun) { try { cleanupOldAttachments({ home, now }); } catch {} }
  return { count: decisions.length, channelId: resolvedChannelId, decisions, since };
}

function option(args, name) { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; }
export async function main(args = process.argv.slice(2)) {
  const home = userHome();
  const token = process.env.DISCORD_BOT_TOKEN?.trim() || readTrimmed(path.join(home, '.claude', 'orgiast-discord-bot-token.txt'));
  if (!token) { console.error('Discord Bot トークンが見つかりません'); return 2; }
  try {
    const result = await intake({ home, channelId: option(args, '--channel'), token, dryRun: args.includes('--dry-run') });
    console.log(`取り込み: ${result.count}件 (channel=${result.channelId})`);
    return 0;
  } catch (error) { console.error(`discord-inbox-intake: ${redactSecrets(error?.message ?? error)}`); return 1; }
}

if (isEntry(import.meta.url)) process.exitCode = await main();
