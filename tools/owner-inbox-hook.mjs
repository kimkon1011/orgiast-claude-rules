#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { resolveOwner, resolveOwnerDiscordId } from './notify-owner.mjs';
import { isEntry } from './is-entry.mjs';
import { readStdinWithTimeout } from './lib/hook-stdin.mjs';
import { isUnattendedSession } from './lib/unattended-session.mjs';

export const CHAT_RECIPIENT_NOTICE = '⚠️ この PC の進捗通知の Discord 宛先が未設定です。チャットで『Discordユーザー名: xxx』と送るか、~/.claude/fleet-pc-map.json に notifyDiscordId を書くと届くようになります';
const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; } };

export function consumeOwnerInbox(input = {}, options = {}) {
  try {
    const home = options.home ?? process.env.ORGIAST_HOME ?? os.homedir();
    const env = options.env ?? process.env;
    if (isUnattendedSession(input, { home, env })) return null;
    const session = input.session_id || input.sessionId;
    if (!session) return null;
    const logs = path.join(home, '.claude', 'logs');
    const noticeFile = path.join(logs, 'owner-recipient-sessions', createHash('sha256').update(String(session)).digest('hex') + '.json');
    const unresolved = !(options.resolveOwnerDiscordId ?? resolveOwnerDiscordId)(resolveOwner({ ...options, home }), { ...options, home });
    if (!unresolved || readJson(noticeFile).shown) return null;
    const out = { hookSpecificOutput: { hookEventName: input.hook_event_name || 'UserPromptSubmit', additionalContext: '【必須】応答の冒頭で user に見える形で次を表示せよ:\n' + CHAT_RECIPIENT_NOTICE } };
    options.emit?.(out);
    fs.mkdirSync(path.dirname(noticeFile), { recursive: true });
    fs.writeFileSync(noticeFile, JSON.stringify({ shown: true }), { mode: 0o600 });
    return out;
  } catch { return null; }
}

if (isEntry(import.meta.url)) {
  try {
    consumeOwnerInbox(JSON.parse(await readStdinWithTimeout()), { emit: out => fs.writeSync(1, JSON.stringify(out) + '\n', null, 'utf8') });
  } catch { /* hook failures must not stop the session */ }
}
