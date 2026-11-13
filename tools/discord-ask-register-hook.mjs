#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { addManual, formatDate, manualLedgerPath, updateManualLedger } from './outbound-reply-chase.mjs';
import { readStdinWithTimeout } from './lib/hook-stdin.mjs';
import { isEntry } from './is-entry.mjs';

export const MATCHER = 'mcp__claude_ai_Discord(?:_2)?__(?:send_dm|send_message|reply_message)';
const target = new RegExp(`^(?:${MATCHER})$`);
// Same identity as notify-kim.mjs / kim-discord-report-gate.mjs.
const KIM_USER_ID = '715210673642012733';
const KIM_CHANNEL_ID = '1508437329247862794';
const snowflake = value => typeof value === 'string' && /^\d+$/.test(value);

// MCP may return JSON directly, or JSON in text content blocks.
export function responseData(value) {
  if (typeof value === 'string') { try { return responseData(JSON.parse(value)); } catch { return null; } }
  if (!value || typeof value !== 'object' || value.isError || value.error || value.success === false || value.ok === false) return null;
  if (snowflake(value.message_id)) return value;
  if (value.structuredContent) return responseData(value.structuredContent);
  const blocks = Array.isArray(value) ? value : value.content;
  if (Array.isArray(blocks)) {
    // An error block must not be masked by another block containing an ID.
    const decoded = blocks.map(b => { try { return JSON.parse(b.text); } catch { return b; } });
    if (decoded.some(b => b?.isError || b?.error || b?.success === false || b?.ok === false)) return null;
    for (const block of decoded) { const data = responseData(block); if (data) return data; }
  }
  return null;
}
export function registerDiscord(options, { file = manualLedgerPath() } = {}) {
  const { channelId, messageId, userId } = options;
  if (!snowflake(channelId) || !snowflake(messageId) || (userId !== undefined && !snowflake(userId))) throw new Error('invalid Discord IDs');
  if (userId === KIM_USER_ID || channelId === KIM_CHANNEL_ID) return 0;
  return updateManualLedger(file, ledger => {
    if (ledger.entries.some(row => row.discord?.messageId === messageId)) return 0;
    const entry = addManual(ledger, { who: userId || channelId, channel: 'Discord', subject: options.subject,
      sent: options.sent, staleDays: 2, explicitStaleDays: true });
    entry.discord = { channelId, messageId, ...(userId ? { userId } : {}) };
    entry.session = String(options.session || '');
    return 1;
  });
}
export function registerHook(input, { file = manualLedgerPath(), now = Date.now() } = {}) {
  if (!target.test(input?.tool_name || '')) return 0;
  const args = input.tool_input || {};
  if (typeof args.content !== 'string' || !/お願い|してください|送ってください|教えてください|ご確認ください|返信ください|ご回答/.test(args.content)) return 0;
  const result = responseData(input.tool_response);
  if (!result) return 0;
  const channelId = result.dm_channel_id || result.channel_id || args.channel_id;
  const userId = args.user_id || result.user_id;
  if (!snowflake(channelId) || (input.tool_name.endsWith('__send_dm') && !snowflake(userId))) return 0;
  return registerDiscord({ channelId, messageId: result.message_id, userId,
    subject: Array.from(args.content).slice(0, 60).join(''), sent: formatDate(now).slice(0, 10), session: input.session_id }, { file });
}
export async function main(args = process.argv.slice(2)) {
  if (args.length) {
    const { values: v } = parseArgs({ args, options: {
      add: { type: 'boolean' }, 'channel-id': { type: 'string' }, 'message-id': { type: 'string' },
      'user-id': { type: 'string' }, subject: { type: 'string' }, sent: { type: 'string' },
      session: { type: 'string' }, ledger: { type: 'string' },
    } });
    if (!v.add) throw new Error('missing --add');
    console.log(registerDiscord({ channelId: v['channel-id'], messageId: v['message-id'], userId: v['user-id'],
      subject: v.subject, sent: v.sent, session: v.session }, { file: v.ledger || manualLedgerPath() }));
  } else {
    registerHook(JSON.parse(await readStdinWithTimeout(500)));
  }
}
if (isEntry(import.meta.url)) main().catch(() => { console.error('1'); process.exitCode = 1; });
