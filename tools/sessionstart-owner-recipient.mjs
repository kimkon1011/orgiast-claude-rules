#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isEntry } from './is-entry.mjs';
import { RECIPIENT_NOTICE, resolveOwner, resolveOwnerDiscordId } from './notify-owner.mjs';

const GUILD_ID = '715211007307284530';

function localDay(now) {
  const date = new Date(now);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function ownerRecipientContext({
  home = os.homedir(),
  now = Date.now(),
  ownerOptions = {},
  resolveOwnerFn = resolveOwner,
  resolveOwnerDiscordIdFn = resolveOwnerDiscordId,
} = {}) {
  const owner = resolveOwnerFn({ home, ...ownerOptions });
  if (resolveOwnerDiscordIdFn(owner, { home, ...ownerOptions })) return null;

  const stateFile = path.join(home, '.claude', 'logs', 'owner-recipient-selfheal.json');
  const day = localDay(now);
  try {
    if (JSON.parse(fs.readFileSync(stateFile, 'utf8')).day === day) return null;
  } catch { /* missing or invalid state should retry self-healing */ }

  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, `${JSON.stringify({ day, at: new Date(now).toISOString() })}\n`, { mode: 0o600 });
  return {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: `進捗通知の Discord 宛先が未登録です。user には頼まず、Discord MCP の search_members（guild_id=${GUILD_ID}）で持ち主（${owner || '未解決'}）のメール・名前・memory の reference_*discord* に載るユーザー名から user_id を特定し、~/.claude/orgiast-discord-user-id.txt に書き、notifyOwner のテスト送信で ok を確認して報告してください。他人の ID を推測・登録しないでください。特定できない時だけ user に次の1行を出してください: ${RECIPIENT_NOTICE}`,
    },
  };
}

export function main() {
  const output = ownerRecipientContext();
  if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
}

if (isEntry(import.meta.url)) main();
