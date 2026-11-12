#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveOwner, resolveOwnerDiscordId } from './notify-owner.mjs';
import { mobilePushInstruction } from './lib/mobile-push-queue.mjs';
import { resolveFleetLabel } from './lib/fleet-label.mjs';
import { isEntry } from './is-entry.mjs';
import { readStdinWithTimeout } from './lib/hook-stdin.mjs';

import { isUnattendedSession } from './lib/unattended-session.mjs';
import { inboxText, inboxFile, readRows } from './lib/auto-progress-inbox.mjs';
export { inboxFile, appendInbox, appendOwnerInbox } from './lib/auto-progress-inbox.mjs';
function displayText(text, limit = 1500) {
  const seen = new Set();
  return String(text).split(/\r?\n/).filter(line => {
    if (!line.trim()) return true;
    if (seen.has(line)) return false;
    seen.add(line); return true;
  }).join('\n').slice(0, limit);
}
function recipientWarning(options, now) {
  const { home, label } = options;
  const owner = resolveOwner(options);
  if (resolveOwnerDiscordId(owner, options)) return '';
  const file = path.join(home, '.claude', 'auto-progress-inbox', '_recipient-warning.json');
  const day = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
  try {
    if (JSON.parse(fs.readFileSync(file, 'utf8')).day === day) return '';
  } catch { /* First display or invalid state. */ }
  // Serialize concurrent prompt hooks before checking and recording the daily display.
  const lock = `${file}.lock`;
  let fd;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fd = fs.openSync(lock, 'wx', 0o600);
    try {
      if (JSON.parse(fs.readFileSync(file, 'utf8')).day === day) return '';
    } catch { /* First display or invalid state. */ }
    fs.writeFileSync(file, JSON.stringify({ day, at: now.toISOString() }), { mode: 0o600 });
    return `⚠ 進捗DMの宛先が未登録（PC: ${label} / ${owner}）: 進捗報告が Discord に届いていません。Claude は Discord メンバー検索で使用者を特定し、fleet-pc-map.json の当該行に notifyDiscordId を足す PR を出すこと（使用者が誰かだけを1問で確認してよい）。`;
  } catch { return ''; /* Keep inbox consumption independent of warning state. */ }
  finally {
    if (fd !== undefined) { fs.closeSync(fd); fs.unlinkSync(lock); }
  }
}
export function consumeInbox(input, { home = process.env.ORGIAST_HOME || os.homedir(), env = process.env, now = Date.now(), label = resolveFleetLabel(home), ...ownerOptions } = {}) {
  if (isUnattendedSession(input, { home, env })) return null;
  const sessionId = input?.session_id || input?.sessionId; if (!sessionId) return null;
  const ownerFile = inboxFile(home, '_owner');
  const sessionFile = inboxFile(home, sessionId);
  const sessionRows = readRows(sessionFile);
  const ownerRows = readRows(ownerFile);
  const unreadSession = sessionRows.filter(row => !row.shown);
  const ids = new Set(unreadSession.map(row => row.id).filter(Boolean));
  const unreadOwner = ownerRows.filter(row => !row.shown && !ids.has(row.id))
    .sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0));
  const lines = unreadSession.map(row => displayText(inboxText(row)));
  lines.push(...unreadOwner.slice(0, 5).map(row => {
    const text = String(inboxText(row));
    const limit = row.state === 'needs_user' || text.includes('判断待ち') ? 600 : 120;
    return text.replace(/\s+/g, ' ').slice(0, limit);
  }));
  if (unreadOwner.length > 5) lines.push(`ほか ${unreadOwner.length - 5} 件`);
  // Overflow remains unread so its contents can be delivered on the next prompt.
  const selected = [...unreadSession, ...unreadOwner.slice(0, 5)];
  const selectedIds = new Set(selected.map(row => row.id).filter(Boolean));
  const shownAt = new Date().toISOString();
  // Owner summaries shown elsewhere must leave the original session unread.
  for (const file of new Set([sessionFile, ownerFile])) {
    const rows = file === sessionFile ? sessionRows : ownerRows;
    let changed = false;
    const updated = rows.map(row => {
      if (row.shown || !(selectedIds.has(row.id) || selected.includes(row))) return row;
      changed = true;
      return { ...row, shown: true, shownAt, shownSession: sessionId };
    });
    if (changed) fs.writeFileSync(file, updated.map(JSON.stringify).join('\n') + '\n');
  }
  const warning = recipientWarning({ ...ownerOptions, home, label }, new Date(now));
  // mobile-push 席の未送信 push 要求は、この対話セッションに PushNotification 送信を指示する。
  const pushContext = mobilePushInstruction(home, {
    now,
    owner: resolveOwner({ ...ownerOptions, home, label }),
    cliPath: path.join(path.dirname(fileURLToPath(import.meta.url)), 'mobile-push-queue.mjs'),
  });
  if (!lines.length && !warning && !pushContext) return null;
  const event = input.hook_event_name || 'UserPromptSubmit';
  const context = lines.length ? `【必須】応答の冒頭で user に見える形で「📲 自動進行の結果（聞かれる前にお知らせ）」として次を表示せよ: ${displayText(lines.join('\n'), Infinity)}` : '';
  return { hookSpecificOutput: { hookEventName: event, additionalContext: [warning, context, pushContext].filter(Boolean).join('\n') } };
}
async function main() {
  try {
    const input = JSON.parse(await readStdinWithTimeout());
    const out = consumeInbox(input);
    const { sessionDigest } = await import('./auto-progress-digest.mjs');
    const digest = sessionDigest();
    if (digest) {
      const context = `【進捗まとめ】以下を応答で提示する（最大5件・1件1行）。\n${digest}`;
      if (out) out.hookSpecificOutput.additionalContext += '\n' + context;
      else { console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: input.hook_event_name || 'UserPromptSubmit', additionalContext: context } })); return; }
    }
    if (out) console.log(JSON.stringify(out));
  } catch (error) { console.error(`auto-progress-inbox: ${error.message}`); }
}
if (isEntry(import.meta.url)) await main();
