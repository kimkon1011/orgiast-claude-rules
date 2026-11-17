#!/usr/bin/env node
// 読み取り専用。合成通知への返信は配送不達の疑いであり、Discord到達の断定ではない。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as beeper from './beeper-api.mjs';
import { isSyntheticMessage, plainText } from './discord-beeper-autoreply.mjs';
import { isEntry } from './is-entry.mjs';

export async function audit({ days = 7, home = os.homedir(), now = Date.now(), api = beeper } = {}) {
  if (!Number.isInteger(days) || days < 1 || days > 365) throw new Error('--days must be an integer between 1 and 365');
  const file = path.join(home, '.claude', 'discord-autoreply', 'sent-log.jsonl');
  const result = { ok: true, days, totalDmEntries: 0, checked: 0, suspiciousCount: 0, entries: [], unresolved: [], invalidLines: 0 };
  // Missing logs are not evidence of zero affected sends.
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
  const groups = new Map();
  for (const line of lines) {
    let entry;
    try { entry = JSON.parse(line); } catch { result.invalidLines++; continue; }
    const ts = Date.parse(entry.ts);
    if (entry.where !== 'dm' || !Number.isFinite(ts) || ts < now - days * 86400000 || ts > now) continue;
    result.totalDmEntries++;
    if (!groups.has(entry.channelId)) groups.set(entry.channelId, []);
    groups.get(entry.channelId).push(entry);
  }
  for (const [chatId, entries] of groups) {
    const messages = new Map(), cursors = new Set();
    let cursor, failure;
    try {
      if (!chatId) throw new Error('channelId missing');
      for (let page = 0; page < 1000; page++) {
        const data = await api.listMessages(chatId, { limit: 200, direction: 'before', cursor });
        if (!Array.isArray(data.items)) throw new Error('invalid message response');
        for (const m of data.items) messages.set(String(m.id), m);
        const resolved = entries.every(e => {
          const sent = messages.get(String(e.replyId));
          return sent && (!sent.linkedMessageID || messages.has(String(sent.linkedMessageID)));
        });
        if (resolved || !data.hasMore) break;
        if (!data.oldestCursor || cursors.has(data.oldestCursor)) throw new Error('pagination incomplete');
        cursor = data.oldestCursor; cursors.add(cursor);
        if (page === 999) throw new Error('pagination limit');
      }
    } catch (error) { failure = error.code || error.message; }
    for (const entry of entries) {
      const row = { ts: entry.ts, channelName: entry.channelName || chatId, channelId: chatId,
        replyId: entry.replyId, questionPreview: (entry.question || '').slice(0, 60) };
      const sent = messages.get(String(entry.replyId));
      const target = sent?.linkedMessageID ? messages.get(String(sent.linkedMessageID)) : null;
      if (!sent || (sent.linkedMessageID && !target)) {
        result.unresolved.push({ ...row, reason: failure || (!sent ? 'sent message not found' : 'reply target not found') });
        continue;
      }
      result.checked++;
      if (target && isSyntheticMessage(target)) result.entries.push({ ...row,
        linkedMessageID: sent.linkedMessageID, targetPreview: plainText(target.text).slice(0, 120) });
    }
  }
  result.suspiciousCount = result.entries.length;
  result.ok = result.unresolved.length === 0 && result.invalidLines === 0;
  return result;
}
export async function main(args = process.argv.slice(2)) {
  const index = args.indexOf('--days');
  const result = await audit({ days: index < 0 ? 7 : Number(args[index + 1]) });
  console.log(JSON.stringify(result, null, 2));
  return result.ok ? 0 : 1;
}
if (isEntry(import.meta.url)) process.exitCode = await main().catch(error => { console.error(error.code || error.message); return 1; });
